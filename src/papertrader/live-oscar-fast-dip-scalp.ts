/**
 * Fast-dip scalp lane (Live Oscar) — DISABLED by default.
 *
 * Rationale (60d backtest, pumpswap 60s bars, PG snapshots — see scripts-tmp/_fastdip_*):
 * our prod dip detector only has 120/360/720-min windows + a 48h age gate, so fast intraday
 * flushes (drop within <=15m) are invisible and fall under `dip_not_deep_enough`. On big
 * runners (mcap>=$3M, vol1h>=$100k) there were ~1870 such flushes in 49d; a deep-flush
 * entry (<=-25% vs a short rolling-high window) with single-shot sizing, hard SL, a 30m
 * time-stop and a front-loaded TP ladder netted ~+4.4%/trade (win ~55%) after 2% round-trip.
 *
 * This lane mirrors `live-oscar-scalp-wave.ts` but:
 *  - uses a single SHORT dip window (not OR-across 120/360/720),
 *  - has NO 48h age gate (fresh momentum coins flush too),
 *  - keeps a real hard SL (kill enabled) instead of escalation handoff,
 *  - is restricted to the pumpswap source at the discovery layer (60s cadence).
 */
import type { PaperTraderConfig } from './config.js';
import { evaluateDipOneWindow, type DipContextByWindows } from './dip-detector.js';
import { evaluateSnapshot } from './filters/snapshot-filter.js';
import { globalGate } from './filters/global-gate.js';
import type { Lane, OpenTrade, SnapshotCandidateRow } from './types.js';
import { resolveLiveOscarTradeLaneFromOpen } from './live-oscar-scalp-wave.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';

export type FastDipScalpEntryPath = 'fast_dip_window';

export function isLiveOscarFastDipScalpLaneEnabled(cfg: PaperTraderConfig): boolean {
  return isLiveOscarTradingStrategyId(cfg.strategyId) && cfg.liveOscarFastDipScalpLaneEnabled;
}

/** Only pumpswap has the 60s cadence needed; 120s lanes are too coarse for fast flushes. */
export function isFastDipScalpEligibleSource(source: string | undefined): boolean {
  return (source ?? '').toLowerCase() === 'pumpswap';
}

export function resolveLiveOscarFastDipScalpInMcapBand(cfg: PaperTraderConfig, mcapUsd: number): boolean {
  if (!isLiveOscarFastDipScalpLaneEnabled(cfg)) return false;
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return false;
  if (mcap + 1e-9 < cfg.liveOscarFastDipScalpMinMcapUsd) return false;
  if (mcap - 1e-9 > cfg.liveOscarFastDipScalpMaxMcapUsd) return false;
  return true;
}

export function liveOscarFastDipScalpAgeMeetsMin(cfg: PaperTraderConfig, ageMin: number): boolean {
  const age = Number(ageMin);
  if (!Number.isFinite(age)) return false;
  return age + 1e-9 >= cfg.liveOscarFastDipScalpMinAgeMin;
}

/** Per-lane entry overlay: single short dip window, deep flush thresholds, no staged split. */
export function liveOscarFastDipScalpEntryConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  const minAge = cfg.liveOscarFastDipScalpMinAgeMin;
  return {
    ...cfg,
    dipMinDropPct: cfg.liveOscarFastDipScalpDipMinDropPct,
    dipMaxDropPct: cfg.liveOscarFastDipScalpDipMaxDropPct,
    dipMinImpulsePct: cfg.liveOscarFastDipScalpMinImpulsePct,
    dipMinAgeMin: minAge,
    globalMinTokenAgeMin: minAge,
    vol1hMinUsd: cfg.liveOscarFastDipScalpVol1hMinUsd,
    positionUsd: cfg.liveOscarFastDipScalpPositionUsd,
  };
}

export function liveOscarFastDipScalpOpenLegUsd(cfg: PaperTraderConfig): number {
  return cfg.liveOscarFastDipScalpPositionUsd;
}

export function isLiveOscarFastDipScalpTrade(
  ot: Pick<OpenTrade, 'liveOscarTradeLane' | 'liveOscarMcapTier' | 'liveExitPolicyId'>,
): boolean {
  return resolveLiveOscarTradeLaneFromOpen(ot) === 'fast_dip_scalp';
}

export function countOpenFastDipScalpPositions(open: ReadonlyMap<string, OpenTrade>): number {
  let n = 0;
  for (const ot of open.values()) {
    if (isLiveOscarFastDipScalpTrade(ot)) n++;
  }
  return n;
}

export interface FastDipScalpTpRung {
  gainFrac: number;
  sellFrac: number;
}

/** Parse the TP ladder ("0.10,0.22" + "0.50,0.30") into aligned rungs. Remainder trails. */
export function parseFastDipScalpTpLadder(cfg: PaperTraderConfig): FastDipScalpTpRung[] {
  const gains = cfg.liveOscarFastDipScalpTpRungsPct
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const fracs = cfg.liveOscarFastDipScalpTpSellFracs
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const out: FastDipScalpTpRung[] = [];
  let cumFrac = 0;
  for (let i = 0; i < gains.length; i++) {
    const sellFrac = Math.min(fracs[i] ?? 0, Math.max(0, 1 - cumFrac));
    if (sellFrac <= 0) continue;
    cumFrac += sellFrac;
    out.push({ gainFrac: gains[i], sellFrac });
  }
  return out;
}

export interface FastDipScalpDiscoveryEval {
  pass: boolean;
  reasons: string[];
  entryPath?: FastDipScalpEntryPath;
  dipPct: number | null;
}

/** Lightweight discovery path — pumpswap-only, snapshot + single short-window deep flush. */
export function evaluateLiveOscarFastDipScalpDiscovery(args: {
  cfg: PaperTraderConfig;
  row: SnapshotCandidateRow;
  lane: Lane;
  refMcap: number;
  ageMin: number;
  dipCtx: DipContextByWindows | undefined;
}): FastDipScalpDiscoveryEval {
  const { cfg, row, lane, refMcap, ageMin, dipCtx } = args;
  const reasons: string[] = [];

  if (!isLiveOscarFastDipScalpLaneEnabled(cfg)) {
    return { pass: false, reasons: ['fast_dip_scalp_lane_disabled'], dipPct: null };
  }
  if (!isFastDipScalpEligibleSource(row.source)) {
    reasons.push('fast_dip_scalp_source_not_pumpswap');
    return { pass: false, reasons, dipPct: null };
  }
  if (!resolveLiveOscarFastDipScalpInMcapBand(cfg, refMcap)) {
    reasons.push(
      `fast_dip_scalp_mcap_outside_${cfg.liveOscarFastDipScalpMinMcapUsd}_${cfg.liveOscarFastDipScalpMaxMcapUsd}`,
    );
    return { pass: false, reasons, dipPct: null };
  }
  if (!liveOscarFastDipScalpAgeMeetsMin(cfg, ageMin)) {
    reasons.push(`fast_dip_scalp_age_below_${cfg.liveOscarFastDipScalpMinAgeMin}m`);
    return { pass: false, reasons, dipPct: null };
  }

  const scalpCfg = liveOscarFastDipScalpEntryConfig(cfg);
  const snap = evaluateSnapshot(scalpCfg, row, lane);
  const globalReasons = globalGate(scalpCfg, row.token_age_min, row.holder_count, {
    skipHolderCheck: cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0,
  });
  if (!snap.pass || globalReasons.length > 0) {
    return { pass: false, reasons: [...snap.reasons, ...globalReasons], dipPct: null };
  }

  const win = cfg.liveOscarFastDipScalpDipWindowMin;
  const ctx = dipCtx?.get(win);
  if (!ctx || !(ctx.high_px > 0)) {
    return { pass: false, reasons: [`fast_dip_scalp_ctx_missing_w${win}`], dipPct: null };
  }
  const dipEval = evaluateDipOneWindow(scalpCfg, row, ctx);
  if (dipEval.reasons.length > 0) {
    return { pass: false, reasons: dipEval.reasons, dipPct: dipEval.dipPct };
  }

  return { pass: true, reasons: [], entryPath: 'fast_dip_window', dipPct: dipEval.dipPct };
}
