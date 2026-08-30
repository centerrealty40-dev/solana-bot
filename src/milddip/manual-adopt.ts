import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import type { MildDipConfig } from './config.js';
import {
  quoteOrphanHolding,
  activeObservation,
} from './orphan-sweep.js';
import { listOrphanTokenAccounts, type OrphanAtaRow } from './orphan-janitor.js';
import {
  appendMildDipJournal,
  saveMildDipState,
  type MildDipState,
} from './state.js';
import {
  noteBuyLot,
  snapshotTradeLots,
  writeUsBuyFill,
  type TradeFillEvent,
} from './trade-journal.js';
import { HOLDING_DUST_RAW } from './sell-empty-guard.js';

type Quote = { ok: boolean; usd: number };
type Signer = ReturnType<typeof loadLiveKeypairFromSecretEnv>;
export type ManualAdoptDeps = {
  list?: typeof listOrphanTokenAccounts;
  quote?: (row: OrphanAtaRow) => Promise<Quote>;
  signer?: (secret: string) => Signer;
};

export type ManualAdoptResult = {
  candidates: number;
  adopted: number;
  skipped: number;
};

function recentEntry(state: MildDipState, mint: string): boolean {
  return (state.recentEntryMsByMint?.[mint] ?? []).some((atMs) => Number(atMs) > 0);
}

function hasHistory(state: MildDipState, mint: string, nowMs: number): string | null {
  if (state.open[mint]) return 'open_position';
  if (recentEntry(state, mint)) return 'recent_entry';
  if (state.lastExitByMint?.[mint]) return 'last_exit';
  if (state.mirrorTradeLots?.[mint]) return 'trade_lot';
  if ((state.cooldownUntilMs?.[mint] ?? 0) > nowMs) return 'cooldown';
  if (activeObservation(state, mint, nowMs)) return 'active_observation';
  return null;
}

function appendSkip(cfg: MildDipConfig, row: OrphanAtaRow, reason: string): void {
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_manual_adopt_skip',
    mint: row.mint,
    tokenRaw: row.amountRaw,
    reason,
  });
}

export async function adoptManualHoldings(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  nowMs?: number;
  deps?: ManualAdoptDeps;
}): Promise<ManualAdoptResult> {
  const { cfg, state } = args;
  const nowMs = args.nowMs ?? Date.now();
  const empty = { candidates: 0, adopted: 0, skipped: 0 };
  const owner = cfg.walletPubkeyExpected?.trim();
  if (
    cfg.executionMode !== 'live' ||
    !cfg.leaderMirror.manualAdoptEnabled ||
    !cfg.walletSecret?.trim() ||
    !owner
  ) return empty;
  try {
    const signer = (args.deps?.signer ?? loadLiveKeypairFromSecretEnv)(cfg.walletSecret);
    if (signer.publicKey.toBase58() !== owner) return empty;
  } catch {
    return empty;
  }
  const rows = (await (args.deps?.list ?? listOrphanTokenAccounts)({
    rpcUrl: cfg.rpcUrl,
    owner,
    protectMints: Object.keys(state.open ?? {}),
  })).filter(
    (row) => /^\d+$/.test(row.amountRaw) && BigInt(row.amountRaw) > HOLDING_DUST_RAW,
  );
  const result = { ...empty, candidates: rows.length };
  for (const row of rows) {
    const historyReason = hasHistory(state, row.mint, nowMs);
    if (historyReason) {
      result.skipped += 1;
      appendSkip(cfg, row, historyReason);
      continue;
    }
    let valuation: Quote;
    try {
      valuation = await (args.deps?.quote ?? quoteOrphanHolding)(row);
    } catch {
      valuation = { ok: false, usd: 0 };
    }
    if (!valuation.ok || !(valuation.usd >= cfg.leaderMirror.manualAdoptMinUsd)) {
      result.skipped += 1;
      appendSkip(cfg, row, valuation.ok ? 'below_min_usd' : 'quote_unknown');
      continue;
    }
    const tokenAmount = Number(row.amountRaw) / Math.pow(10, Math.max(0, row.decimals));
    const entryPriceUsd =
      tokenAmount > 0 && Number.isFinite(tokenAmount) ? valuation.usd / tokenAmount : 0;
    if (!(entryPriceUsd > 0) || !Number.isFinite(entryPriceUsd)) {
      result.skipped += 1;
      appendSkip(cfg, row, 'quote_unknown');
      continue;
    }
    const pos = {
      mint: row.mint,
      symbol: row.mint.slice(0, 6),
      entryPriceUsd,
      entryMarkPriceUsd: entryPriceUsd,
      sizeUsd: valuation.usd,
      tokenRaw: row.amountRaw,
      openedAtMs: nowMs,
      entryPc5mPct: null,
      buySignature: null,
      lane: 'leader_mirror' as const,
      manualAdopted: true,
      peakPriceUsd: entryPriceUsd,
      mirrorLadderBasisPriceUsd: entryPriceUsd,
      mirrorExitArmPct: cfg.leaderMirror.manualAdoptArmPct,
      mirrorExitTrailPct: cfg.leaderMirror.manualAdoptTrailPct,
      trailArmed: false,
    };
    state.open[row.mint] = pos;
    state.recentEntryMsByMint ??= {};
    state.recentEntryMsByMint[row.mint] = [
      ...(state.recentEntryMsByMint[row.mint] ?? []),
      nowMs,
    ];
    let fill: TradeFillEvent;
    try {
      fill = writeUsBuyFill({
        tradesPath: cfg.tradesPath,
        wallet: owner,
        mint: row.mint,
        symbol: pos.symbol,
        ok: true,
        signature: null,
        sizeUsdIntent: valuation.usd,
        quoteSpentUsd: valuation.usd,
        fillPriceUsd: entryPriceUsd,
        reason: 'mild_dip_manual_adopt',
        lane: 'leader_mirror',
        nowMs,
      });
    } catch {
      noteBuyLot(row.mint, valuation.usd, nowMs);
      fill = {
        v: 1,
        kind: 'trade_fill',
        actor: 'us',
        wallet: owner,
        mint: row.mint,
        symbol: pos.symbol,
        side: 'buy',
        ok: true,
        signature: null,
        sizeUsdIntent: valuation.usd,
        quoteSpentUsd: valuation.usd,
        cashDeltaUsd: -valuation.usd,
        fillPriceUsd: entryPriceUsd,
        fraction: 1,
        reason: 'mild_dip_manual_adopt',
        lane: 'leader_mirror',
        source: 'mild_dip',
        leader: null,
        cashSource: 'quote_fallback',
      };
    }
    const bookedUsd = Math.max(valuation.usd, Number(fill.quoteSpentUsd ?? 0));
    if (bookedUsd > valuation.usd) noteBuyLot(row.mint, bookedUsd - valuation.usd, nowMs);
    state.mirrorTradeLots = snapshotTradeLots();
    state.mirrorTradingCashUsd = (state.mirrorTradingCashUsd ?? 0) - valuation.usd;
    saveMildDipState(cfg.statePath, state);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_manual_adopt',
      mint: row.mint,
      tokenRaw: row.amountRaw,
      sizeUsd: valuation.usd,
      entryPriceUsd,
    });
    result.adopted += 1;
  }
  return result;
}
