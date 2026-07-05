/**
 * Wallet balance is the source of truth for live exit sizing and orphan detection.
 * Journal `remainingFraction` may lag after manual buys/sells or partial-fill drift.
 */
import type { OpenTrade } from '../papertrader/types.js';
import { oscarWalletMintUsdExcludingCopyLeader } from './copy-leader-attribution.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';

/** Treat journal remainder as zero below this (matches tracker TP-close heuristic). */
export const WALLET_RECONCILE_REMAINING_EPS = 1e-6;

export type WalletBalanceReconcileReason =
  | 'chain_above_journal'
  | 'chain_below_journal_after_partial'
  | 'journal_zero_chain_holds'
  | 'chain_orphan_no_open';

export type WalletBalanceReconcileResult = {
  resynced: boolean;
  prevRemainingFraction: number;
  nextRemainingFraction: number;
  journalRemainingUsd: number;
  chainOscarUsd: number;
  chainGrossUsd: number;
  reason?: WalletBalanceReconcileReason;
};

/** USD notional for raw SPL balance at spot price. */
export function walletNotionalUsdFromRaw(
  raw: bigint,
  decimals: number,
  priceUsd: number,
): number {
  if (raw <= 0n || !(priceUsd > 0) || !Number.isFinite(priceUsd)) return 0;
  const dec = Math.min(24, Math.max(0, Math.floor(decimals)));
  const tokens = Number(raw) / 10 ** dec;
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return tokens * priceUsd;
}

/** Journal cost-basis USD still marked open. */
export function journalRemainingUsd(ot: OpenTrade): number {
  return ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
}

/** Oscar-attributed chain USD (subtract copy-leader leg on shared wallet). */
export function oscarChainUsdFromRaw(args: {
  raw: bigint;
  decimals: number;
  priceUsd: number;
  mint: string;
}): { grossUsd: number; oscarUsd: number } {
  const grossUsd = walletNotionalUsdFromRaw(args.raw, args.decimals, args.priceUsd);
  const oscarUsd = oscarWalletMintUsdExcludingCopyLeader({
    walletMintUsd: grossUsd,
    mint: args.mint,
  });
  return { grossUsd, oscarUsd };
}

/** Effective remainder USD for exit sizing: max(journal, Oscar-attributed chain). */
export function effectiveRemainingUsdForExit(journalUsd: number, chainOscarUsd: number): number {
  const j = Number.isFinite(journalUsd) && journalUsd > 0 ? journalUsd : 0;
  const c = Number.isFinite(chainOscarUsd) && chainOscarUsd > 0 ? chainOscarUsd : 0;
  return Math.max(j, c);
}

/** Whether exit policy should still manage this open (journal zero but chain holds). */
export function hasManagedWalletExposure(args: {
  ot: OpenTrade;
  chainOscarUsd: number;
  minUsd: number;
}): boolean {
  if (args.ot.remainingFraction > WALLET_RECONCILE_REMAINING_EPS) return true;
  return args.chainOscarUsd >= args.minUsd;
}

/**
 * Zombie tail safety net after partial sells:
 * - journal zero but chain still holds (PR #391)
 * - journal non-zero but both chain and journal below tail-flush threshold (manlet DdPrHY class)
 */
export function shouldForceCloseJournalZeroChainTail(args: {
  remainingFraction: number;
  chainOscarUsd: number;
  journalRemainingUsd?: number;
  minUsd: number;
  tailFlushThresholdUsd?: number;
  partialSellCount: number;
}): boolean {
  if (args.partialSellCount <= 0) return false;
  if (!(args.chainOscarUsd >= args.minUsd)) return false;

  const journalZero = args.remainingFraction <= WALLET_RECONCILE_REMAINING_EPS;
  if (journalZero) return true;

  const threshold =
    typeof args.tailFlushThresholdUsd === 'number' &&
    Number.isFinite(args.tailFlushThresholdUsd) &&
    args.tailFlushThresholdUsd > 0
      ? args.tailFlushThresholdUsd
      : 100;
  const journalUsd = args.journalRemainingUsd;
  return (
    args.chainOscarUsd < threshold &&
    typeof journalUsd === 'number' &&
    Number.isFinite(journalUsd) &&
    journalUsd < threshold
  );
}

/**
 * Sync journal `remainingFraction` with Oscar-attributed chain USD.
 * Expands when chain exceeds journal; shrinks only after partial sells when chain is materially lower.
 */
export function resyncRemainingFractionFromChain(args: {
  ot: OpenTrade;
  chainOscarUsd: number;
  minUsd: number;
}): WalletBalanceReconcileResult {
  const { ot, chainOscarUsd, minUsd } = args;
  const prev = ot.remainingFraction;
  const journalUsd = journalRemainingUsd(ot);
  const base: WalletBalanceReconcileResult = {
    resynced: false,
    prevRemainingFraction: prev,
    nextRemainingFraction: prev,
    journalRemainingUsd: journalUsd,
    chainOscarUsd,
    chainGrossUsd: chainOscarUsd,
  };

  if (!(chainOscarUsd >= minUsd) || !(ot.totalInvestedUsd > 0)) return base;

  const journalZero = prev <= WALLET_RECONCILE_REMAINING_EPS;
  const chainAboveJournal = chainOscarUsd > journalUsd * 1.02 + 0.01;
  const hasPartials = ot.partialSells.length > 0;
  const chainBelowJournalAfterPartial =
    hasPartials &&
    !journalZero &&
    chainOscarUsd < journalUsd * 0.98 - 0.01;

  if (chainBelowJournalAfterPartial) {
    const next = Math.max(
      WALLET_RECONCILE_REMAINING_EPS,
      Math.min(prev, chainOscarUsd / ot.totalInvestedUsd),
    );
    if (next < prev - 1e-9) {
      ot.remainingFraction = next;
      return {
        ...base,
        resynced: true,
        nextRemainingFraction: next,
        reason: 'chain_below_journal_after_partial',
      };
    }
  }

  if (!journalZero && !chainAboveJournal) return base;

  const next = Math.min(1, chainOscarUsd / ot.totalInvestedUsd);
  if (!(next > prev + 1e-9)) return base;

  ot.remainingFraction = next;
  return {
    ...base,
    resynced: true,
    nextRemainingFraction: next,
    reason: journalZero ? 'journal_zero_chain_holds' : 'chain_above_journal',
  };
}

/** Partial sell USD notional from chain (Oscar-attributed) when live. */
export function planPartialSellUsdNotional(args: {
  ot: OpenTrade;
  chainOscarUsd: number;
  sellFraction: number;
  marketPrice: number;
}): number {
  const { ot, chainOscarUsd, sellFraction, marketPrice } = args;
  const sf = Math.min(1, Math.max(0, sellFraction));
  if (!(sf > 0)) return 0;

  const journalUsd = journalRemainingUsd(ot);
  const effectiveRemUsd = effectiveRemainingUsdForExit(journalUsd, chainOscarUsd);
  const fromEffective = effectiveRemUsd * sf;

  const entryPx =
    ot.avgEntryMarket > 1e-18 && Number.isFinite(ot.avgEntryMarket)
      ? ot.avgEntryMarket
      : ot.avgEntry > 1e-18 && Number.isFinite(ot.avgEntry)
        ? ot.avgEntry
        : marketPrice;
  const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * sf;
  const fromJournalTokens =
    marketPrice > 1e-18 && entryPx > 1e-18 && Number.isFinite(marketPrice)
      ? investedSoldUsd * (marketPrice / entryPx)
      : investedSoldUsd;

  if (chainOscarUsd > 0) {
    return Math.max(fromJournalTokens, chainOscarUsd * sf);
  }
  return fromEffective > 0 ? fromEffective * sf : fromJournalTokens;
}

/** Full exit USD notional — prefer chain when journal remainder is stale/zero. */
export function planFullExitUsdNotional(args: {
  ot: OpenTrade;
  chainOscarUsd: number;
}): number {
  return effectiveRemainingUsdForExit(journalRemainingUsd(args.ot), args.chainOscarUsd);
}

export function liveWalletBalanceReconcileMinUsd(liveCfg: LiveOscarConfig | undefined): number {
  const n = liveCfg?.liveWalletBalanceReconcileMinUsd;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n;
  return 5;
}

/** Reconcile one open position against a pre-fetched chain map + spot price. */
export function reconcileOpenPositionWalletBalance(args: {
  liveCfg: LiveOscarConfig | undefined;
  ot: OpenTrade;
  mint: string;
  chainMap: Map<string, bigint> | null | undefined;
  priceUsd: number;
}): WalletBalanceReconcileResult | null {
  const { liveCfg, ot, mint, chainMap, priceUsd } = args;
  if (!liveCfg?.strategyEnabled) return null;
  if (liveCfg.executionMode !== 'live' && liveCfg.executionMode !== 'simulate') return null;
  if (!chainMap || !(priceUsd > 0)) return null;

  const dec = ot.tokenDecimals ?? 6;
  const raw = chainMap.get(mint) ?? 0n;
  const { oscarUsd } = oscarChainUsdFromRaw({ raw, decimals: dec, priceUsd, mint });
  const minUsd = liveWalletBalanceReconcileMinUsd(liveCfg);
  const result = resyncRemainingFractionFromChain({ ot, chainOscarUsd: oscarUsd, minUsd });

  if (result.resynced && result.reason) {
    appendLiveJsonlEvent({
      kind: 'orphan_reconcile',
      mint,
      reason: result.reason,
      prevRemainingFraction: +result.prevRemainingFraction.toFixed(6),
      nextRemainingFraction: +result.nextRemainingFraction.toFixed(6),
      journalRemainingUsd: +result.journalRemainingUsd.toFixed(4),
      chainOscarUsd: +result.chainOscarUsd.toFixed(4),
      minUsd,
    });
  }

  return result;
}

/** Chain-only mint with material balance and no open journal row (post-close / manual add). */
export function emitChainOrphanReconcileIfNeeded(args: {
  liveCfg: LiveOscarConfig;
  mint: string;
  chainOscarUsd: number;
  hasOpen: boolean;
}): void {
  if (args.hasOpen) return;
  const minUsd = liveWalletBalanceReconcileMinUsd(args.liveCfg);
  if (!(args.chainOscarUsd >= minUsd)) return;
  appendLiveJsonlEvent({
    kind: 'orphan_reconcile',
    mint: args.mint,
    reason: 'chain_orphan_no_open',
    chainOscarUsd: +args.chainOscarUsd.toFixed(4),
    minUsd,
  });
}
