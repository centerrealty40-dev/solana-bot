/**
 * Live Oscar Wave B — post-TP1 scratch @ signal drop → full close → re-entry deeper @ same signal anchor.
 * Distinct from partial `WAVE_B_POST_TP1_DERISK` (avg PnL) and Variant A exit-ref re-entry.
 */
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { DexId, Lane, OpenTrade } from '../types.js';
import { liveStagedEntrySignalTtlExpired } from './live-staged-entry-gates.js';
import { waveBPostTp1ScratchEligible } from './exit-policy-wave-b.js';

const log = child('wave-b-post-tp1-scratch-reentry');

export type WaveBPostTp1ScratchPending = {
  mint: string;
  symbol: string;
  lane: Lane;
  source?: string;
  dex: DexId;
  signalTs: number;
  signalPriceUsd: number;
  scratchTs: number;
  scratchDropPct: number;
  reentryDropPct: number;
  reentryUsd: number;
  tokenDecimals?: number;
  liveOscarMcapTier?: 'micro' | 'low' | 'prod';
  pairAddress?: string | null;
  entryMarketCapUsd?: number | null;
};

const pendingByMint = new Map<string, WaveBPostTp1ScratchPending>();
let cfgRef: PaperTraderConfig | null = null;

export function configureWaveBPostTp1ScratchReentry(cfg: PaperTraderConfig): void {
  cfgRef = cfg;
}

export function waveBPostTp1ScratchSignalDropPct(
  signalPriceUsd: number,
  curMetric: number,
): number | null {
  if (!(signalPriceUsd > 0) || !(curMetric > 0)) return null;
  return (curMetric / signalPriceUsd - 1) * 100;
}

export function waveBPostTp1ScratchFullExitDue(
  cfg: PaperTraderConfig,
  ot: OpenTrade,
  curMetric: number,
): boolean {
  if (!cfg.liveOscarWaveBPostTp1ScratchReentryEnabled) return false;
  if (!waveBPostTp1ScratchEligible(ot)) return false;
  const signalPriceUsd = ot.liveStagedEntry?.signalPriceUsd ?? 0;
  if (!(signalPriceUsd > 0)) return false;
  const drop = waveBPostTp1ScratchSignalDropPct(signalPriceUsd, curMetric);
  if (drop == null) return false;
  return drop <= -cfg.liveOscarWaveBPostTp1ScratchDropPct + 1e-9;
}

export function waveBPostTp1ScratchReentryDue(
  pending: WaveBPostTp1ScratchPending,
  curMetric: number,
): boolean {
  if (!(pending.signalPriceUsd > 0) || !(curMetric > 0)) return false;
  const drop = waveBPostTp1ScratchSignalDropPct(pending.signalPriceUsd, curMetric);
  if (drop == null) return false;
  return drop <= -pending.reentryDropPct + 1e-9;
}

export function waveBPostTp1ScratchReentryExpired(
  cfg: PaperTraderConfig,
  pending: WaveBPostTp1ScratchPending,
  nowMs: number,
): boolean {
  return liveStagedEntrySignalTtlExpired(cfg, pending.signalTs, nowMs);
}

export function armWaveBPostTp1ScratchReentry(
  pending: WaveBPostTp1ScratchPending,
  journalAppend?: (event: Record<string, unknown>) => void,
): void {
  const cfg = cfgRef;
  if (!cfg?.liveOscarWaveBPostTp1ScratchReentryEnabled) return;
  const key = pending.mint.trim();
  if (!key) return;
  pendingByMint.set(key, pending);
  journalAppend?.({
    kind: 'wave_b_post_tp1_scratch_pending',
    ...serializeWaveBPostTp1ScratchPending(pending),
  });
  log.info(
    {
      mint: key.slice(0, 12),
      signalPriceUsd: pending.signalPriceUsd,
      reentryDropPct: pending.reentryDropPct,
      reentryUsd: pending.reentryUsd,
    },
    'wave B post-TP1 scratch re-entry armed',
  );
}

export function armWaveBPostTp1ScratchReentryFromOpenTrade(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  journalAppend?: (event: Record<string, unknown>) => void,
): void {
  if (!cfg.liveOscarWaveBPostTp1ScratchReentryEnabled) return;
  const st = ot.liveStagedEntry;
  if (!st || !(st.signalPriceUsd > 0)) return;
  armWaveBPostTp1ScratchReentry(
    {
      mint: ot.mint,
      symbol: ot.symbol,
      lane: ot.lane,
      source: ot.source,
      dex: ot.dex,
      signalTs: st.signalTs,
      signalPriceUsd: st.signalPriceUsd,
      scratchTs: Date.now(),
      scratchDropPct: cfg.liveOscarWaveBPostTp1ScratchDropPct,
      reentryDropPct: cfg.liveOscarWaveBPostTp1ScratchReentryDropPct,
      reentryUsd: cfg.liveOscarWaveBPostTp1ScratchReentryUsd,
      tokenDecimals: ot.tokenDecimals != null ? ot.tokenDecimals : undefined,
      liveOscarMcapTier: ot.liveOscarMcapTier,
      pairAddress: ot.pairAddress,
      entryMarketCapUsd: ot.entryMarketCapUsd != null ? ot.entryMarketCapUsd : undefined,
    },
    journalAppend,
  );
}

export function waveBPostTp1ScratchReentryPending(mint: string): WaveBPostTp1ScratchPending | null {
  return pendingByMint.get(mint.trim()) ?? null;
}

export function listWaveBPostTp1ScratchReentryPending(): WaveBPostTp1ScratchPending[] {
  return [...pendingByMint.values()];
}

/** Bypass discovery/execution post-exit re-entry gates for armed scratch re-entry buys. */
export function waveBPostTp1ScratchReentryBypassGate(mint: string): boolean {
  return pendingByMint.has(mint.trim());
}

export function consumeWaveBPostTp1ScratchReentry(
  mint: string,
  journalAppend?: (event: Record<string, unknown>) => void,
): void {
  const key = mint.trim();
  if (!pendingByMint.has(key)) return;
  pendingByMint.delete(key);
  journalAppend?.({ kind: 'wave_b_post_tp1_scratch_consumed', mint: key, ts: Date.now() });
}

export function clearWaveBPostTp1ScratchReentry(
  mint: string,
  journalAppend?: (event: Record<string, unknown>) => void,
): void {
  consumeWaveBPostTp1ScratchReentry(mint, journalAppend);
}

export function serializeWaveBPostTp1ScratchPending(
  p: WaveBPostTp1ScratchPending,
): Record<string, unknown> {
  return {
    mint: p.mint,
    symbol: p.symbol,
    lane: p.lane,
    source: p.source,
    dex: p.dex,
    signalTs: p.signalTs,
    signalPriceUsd: p.signalPriceUsd,
    scratchTs: p.scratchTs,
    scratchDropPct: p.scratchDropPct,
    reentryDropPct: p.reentryDropPct,
    reentryUsd: p.reentryUsd,
    ...(p.tokenDecimals != null ? { tokenDecimals: p.tokenDecimals } : {}),
    ...(p.liveOscarMcapTier ? { liveOscarMcapTier: p.liveOscarMcapTier } : {}),
    ...(p.pairAddress != null ? { pairAddress: p.pairAddress } : {}),
    ...(p.entryMarketCapUsd != null ? { entryMarketCapUsd: p.entryMarketCapUsd } : {}),
  };
}

export function restoreWaveBPostTp1ScratchPendingFromJournal(raw: Record<string, unknown>): void {
  const mint = raw.mint != null ? String(raw.mint).trim() : '';
  if (!mint) return;
  const signalTs = Number(raw.signalTs ?? 0);
  const signalPriceUsd = Number(raw.signalPriceUsd ?? 0);
  const scratchTs = Number(raw.scratchTs ?? raw.ts ?? 0);
  const reentryUsd = Number(raw.reentryUsd ?? 0);
  if (!(signalTs > 0) || !(signalPriceUsd > 0) || !(reentryUsd > 0)) return;
  pendingByMint.set(mint, {
    mint,
    symbol: String(raw.symbol ?? '?'),
    lane: (raw.lane as Lane) ?? 'post_migration',
    source: raw.source != null ? String(raw.source) : undefined,
    dex: (raw.dex as DexId) ?? 'raydium',
    signalTs,
    signalPriceUsd,
    scratchTs: scratchTs > 0 ? scratchTs : Date.now(),
    scratchDropPct: Number(raw.scratchDropPct ?? 15),
    reentryDropPct: Number(raw.reentryDropPct ?? 30),
    reentryUsd,
    tokenDecimals:
      raw.tokenDecimals != null && Number.isFinite(Number(raw.tokenDecimals))
        ? Number(raw.tokenDecimals)
        : undefined,
    liveOscarMcapTier:
      raw.liveOscarMcapTier === 'micro' || raw.liveOscarMcapTier === 'low'
        ? raw.liveOscarMcapTier
        : undefined,
    pairAddress: raw.pairAddress != null ? String(raw.pairAddress) : null,
    entryMarketCapUsd:
      raw.entryMarketCapUsd != null && Number.isFinite(Number(raw.entryMarketCapUsd))
        ? Number(raw.entryMarketCapUsd)
        : null,
  });
}

export function applyWaveBPostTp1ScratchJournalLine(raw: Record<string, unknown>): void {
  const kind = String(raw.kind ?? '');
  if (kind === 'wave_b_post_tp1_scratch_pending') {
    restoreWaveBPostTp1ScratchPendingFromJournal(raw);
    return;
  }
  if (kind === 'wave_b_post_tp1_scratch_consumed') {
    const mint = raw.mint != null ? String(raw.mint).trim() : '';
    if (mint) pendingByMint.delete(mint);
  }
}

/** Test helper — reset in-memory pending map. */
export function resetWaveBPostTp1ScratchReentryForTests(): void {
  pendingByMint.clear();
  cfgRef = null;
}
