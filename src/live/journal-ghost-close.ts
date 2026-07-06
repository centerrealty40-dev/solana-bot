/**
 * Wallet = SoT: close journal-only ghost opens when chain has no exposure.
 * Journal is post-factum — never initiate buys to match journal.
 */
import type { PaperTraderConfig } from '../papertrader/config.js';
import { applyExitCosts, buildCloseCosts } from '../papertrader/costs.js';
import type { ClosedTrade, ExitReason, OpenTrade } from '../papertrader/types.js';
import { cancelPendingEntrySplitLegs } from '../papertrader/executor/live-staged-entry-gates.js';
import { getPriorityFeeUsd } from '../papertrader/pricing/priority-fee.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { cancelLivePostCloseTailSweepForMint } from './post-close-tail-sweep.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { serializeClosedTrade } from './strategy-snapshot.js';
import { COPY_HANDOFF_WALLET_DUST_RAW } from './copy-oscar-handoff-lifecycle.js';

/** Cancel pending entry_split / staged_avg legs — position is closing journal-side. */
export function clearPendingEntryLegsOnJournalClose(ot: OpenTrade): void {
  if (ot.liveStagedEntry) {
    cancelPendingEntrySplitLegs(ot.liveStagedEntry);
    delete ot.liveStagedEntry;
  }
  delete ot.livePendingScaleIn;
  delete ot.livePendingTpSell;
}

function buildJournalGhostClosedTrade(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  exitReason: ExitReason;
}): ClosedTrade {
  const { cfg, ot, exitReason } = args;
  const marketSell =
    ot.lastObservedPriceUsd ?? ot.avgEntryMarket ?? ot.avgEntry;
  const ageH = (Date.now() - ot.entryTs) / 3_600_000;
  const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
  const perTx = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
  const remUsd = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
  const marketPx = marketSell > 0 ? marketSell : ot.avgEntry;
  const { effectivePrice: effectiveSell } = applyExitCosts(
    cfg,
    marketPx,
    ot.dex,
    Math.max(1, remUsd > 1e-6 ? remUsd : cfg.positionUsd * 1e-4),
    null,
  );
  let finalProceeds = 0;
  let finalGrossProceeds = 0;
  if (ot.remainingFraction > 1e-6 && marketPx > 0 && ot.avgEntry > 0) {
    finalProceeds = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
    finalGrossProceeds =
      ot.totalInvestedUsd * ot.remainingFraction * (marketPx / ot.avgEntryMarket);
  }
  const priorProceeds = ot.partialSells.reduce((s, p) => s + (p.proceedsUsd ?? 0), 0);
  const priorGross = ot.partialSells.reduce((s, p) => s + (p.grossProceedsUsd ?? p.proceedsUsd ?? 0), 0);
  const totalProceedsUsd = priorProceeds + finalProceeds;
  const grossTotalProceedsUsd = priorGross + finalGrossProceeds;
  const netPnlUsd = totalProceedsUsd - ot.totalInvestedUsd;
  const grossPnlUsd = grossTotalProceedsUsd - ot.totalInvestedUsd;
  const totalPnlPct = ot.totalInvestedUsd > 0 ? (netPnlUsd / ot.totalInvestedUsd) * 100 : 0;
  const grossPnlPct = ot.totalInvestedUsd > 0 ? (grossPnlUsd / ot.totalInvestedUsd) * 100 : 0;
  const networkFeeUsdTotal = (ot.legs.length + ot.partialSells.length + 1) * perTx;
  const costs = buildCloseCosts({
    cfg,
    trade: ot,
    exit: { effectivePrice: effectiveSell, marketPrice: marketPx },
    networkFeeUsdTotal,
    slipDynamicBpsEntry: 0,
    slipDynamicBpsExit: 0,
    netPnlUsd,
    grossPnlUsd,
  });
  return {
    ...ot,
    exitTs: Date.now(),
    exitMcUsd: marketPx,
    exitReason,
    pnlPct: totalPnlPct,
    durationMin: ageH * 60,
    totalProceedsUsd,
    netPnlUsd,
    grossTotalProceedsUsd,
    grossPnlUsd,
    grossPnlPct,
    costs,
    effective_entry_price: ot.avgEntry,
    effective_exit_price: effectiveSell,
    theoretical_entry_price: ot.legs[0]?.marketPrice ?? ot.avgEntryMarket,
    theoretical_exit_price: marketPx,
  };
}

export type JournalGhostCloseResult = {
  closedMints: string[];
};

/**
 * Close journal opens with zero Oscar-attributed chain exposure.
 * Never initiates on-chain buys — journal-only hygiene close.
 */
export function closeJournalGhostOpensWhenChainEmpty(args: {
  cfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  chainMap: Map<string, bigint> | null | undefined;
  /** Where the close was triggered (boot / periodic_heal). */
  context: 'boot' | 'periodic_heal';
}): JournalGhostCloseResult {
  const { cfg, open, closed, chainMap, context } = args;
  const closedMints: string[] = [];
  if (!chainMap) return { closedMints };

  for (const [mint, ot] of [...open.entries()]) {
    const raw = chainMap.get(mint) ?? 0n;
    if (raw > COPY_HANDOFF_WALLET_DUST_RAW) continue;

    clearPendingEntryLegsOnJournalClose(ot);
    cancelLivePostCloseTailSweepForMint(mint);

    const exitReason: ExitReason =
      context === 'periodic_heal' ? 'PERIODIC_HEAL' : 'RECONCILE_ORPHAN';
    const ct = buildJournalGhostClosedTrade({ cfg, ot, exitReason });
    open.delete(mint);
    closed.push(ct);
    closedMints.push(mint);

    appendLiveJsonlEvent({
      kind: 'orphan_reconcile',
      mint,
      reason: 'journal_open_chain_zero',
      context,
      prevRemainingFraction: +ot.remainingFraction.toFixed(6),
      journalRemainingUsd: +(ot.totalInvestedUsd * ot.remainingFraction).toFixed(4),
      chainOscarUsd: 0,
    });
    appendLiveJsonlEvent({
      kind: 'live_position_close',
      mint,
      closedTrade: serializeClosedTrade(ct),
      walletSoTJournalOnly: true,
      ghostCloseContext: context,
    });
  }

  return { closedMints };
}
