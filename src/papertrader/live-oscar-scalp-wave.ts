import type { PaperTraderConfig } from './config.js';
import { evaluateDip, type DipContextByWindows } from './dip-detector.js';
import { evaluateSnapshot } from './filters/snapshot-filter.js';
import { globalGate } from './filters/global-gate.js';
import type { Lane, OpenTrade, SnapshotCandidateRow } from './types.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';
import { liveOscarTierEntryConfig, type LiveOscarMcapTier } from './live-oscar-mcap-tier.js';
import { liveOscarMintOpenSkipReasonForEscalation } from './live-oscar-phase-escalation.js';

/** Trade strategy lane — mutex dimension (prod/scalp_wave); runner lanes parallel via composite open key. */
export type LiveOscarTradeLane =
  | 'prod'
  | 'scalp_wave'
  | 'runner_probe'
  | 'runner_lite'
  | 'pervyy_vystrel'
  | 'fast_dip_scalp';

export type ScalpWaveEntryPath = 'dip_windows';

export function isLiveOscarScalpWaveLaneEnabled(cfg: PaperTraderConfig): boolean {
  return isLiveOscarTradingStrategyId(cfg.strategyId) && cfg.liveOscarScalpWaveLaneEnabled;
}

export function resolveLiveOscarTradeLaneFromOpen(
  ot: Pick<
    OpenTrade,
    'liveOscarTradeLane' | 'liveOscarMcapTier' | 'liveExitPolicyId' | 'positionSource'
  >,
): LiveOscarTradeLane {
  if (ot.positionSource === 'runner_probe') return 'runner_probe';
  if (ot.liveOscarTradeLane === 'runner_probe') return 'runner_probe';
  if (ot.liveExitPolicyId === 'runner_probe_v1') return 'runner_probe';
  if (ot.positionSource === 'runner_lite') return 'runner_lite';
  if (ot.liveOscarTradeLane === 'runner_lite') return 'runner_lite';
  if (ot.liveExitPolicyId === 'runner_lite_v1') return 'runner_lite';
  if (ot.positionSource === 'pervyy_vystrel') return 'pervyy_vystrel';
  if (ot.liveOscarTradeLane === 'pervyy_vystrel') return 'pervyy_vystrel';
  if (ot.liveExitPolicyId === 'pervyy_vystrel_v1') return 'pervyy_vystrel';
  if (ot.liveOscarTradeLane === 'fast_dip_scalp') return 'fast_dip_scalp';
  if (ot.liveExitPolicyId === 'fast_dip_scalp_v1') return 'fast_dip_scalp';
  if (ot.liveOscarTradeLane === 'scalp_wave') return 'scalp_wave';
  if (ot.liveOscarMcapTier === 'scalp_wave') return 'scalp_wave';
  if (ot.liveExitPolicyId === 'scalp_wave_v1') return 'scalp_wave';
  return 'prod';
}

export function isLiveOscarScalpWaveTrade(
  ot: Pick<OpenTrade, 'liveOscarTradeLane' | 'liveOscarMcapTier' | 'liveExitPolicyId'>,
): boolean {
  return resolveLiveOscarTradeLaneFromOpen(ot) === 'scalp_wave';
}

export function countOpenScalpWavePositions(
  open: ReadonlyMap<string, OpenTrade>,
): number {
  let n = 0;
  for (const ot of open.values()) {
    if (isLiveOscarScalpWaveTrade(ot)) n++;
  }
  return n;
}

/** Mint corridor + age band for scalp_wave discovery (mcap only — pair with age gate). */
export function resolveLiveOscarScalpWaveMcapTier(
  cfg: PaperTraderConfig,
  mcapUsd: number,
): LiveOscarMcapTier | 'below' {
  if (!isLiveOscarScalpWaveLaneEnabled(cfg)) return 'below';
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return 'below';
  if (mcap + 1e-9 < cfg.liveOscarScalpWaveMinMcapUsd) return 'below';
  if (mcap - 1e-9 > cfg.liveOscarScalpWaveMaxMcapUsd) return 'below';
  return 'scalp_wave';
}

/** Min age only (12h prod default); no upper cap when maxAgeMin is 0. */
export function liveOscarScalpWaveAgeMeetsMin(cfg: PaperTraderConfig, ageMin: number): boolean {
  const age = Number(ageMin);
  if (!Number.isFinite(age)) return false;
  if (age + 1e-9 < cfg.liveOscarScalpWaveMinAgeMin) return false;
  const maxAge = cfg.liveOscarScalpWaveMaxAgeMin ?? 0;
  if (maxAge > 0 && age - 1e-9 > maxAge) return false;
  return true;
}

/** @deprecated Use {@link liveOscarScalpWaveAgeMeetsMin}. */
export const liveOscarScalpWaveAgeInBand = liveOscarScalpWaveAgeMeetsMin;

/** Per-lane entry thresholds: shallow dip −8..−15%, no staged split. */
export function liveOscarScalpWaveEntryConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  const minAge = cfg.liveOscarScalpWaveMinAgeMin;
  return {
    ...cfg,
    dipMinDropPct: cfg.liveOscarScalpWaveDipMinDropPct,
    dipMaxDropPct: cfg.liveOscarScalpWaveDipMaxDropPct,
    dipMinAgeMin: minAge,
    /** Scalp lane min 12h — not prod global 36h (`PAPER_POST_MIN_AGE_MIN` / `PAPER_MIN_TOKEN_AGE_MIN`). */
    globalMinTokenAgeMin: minAge,
    dipMinImpulsePct: cfg.liveOscarScalpWaveMinImpulsePct,
    vol1hMinUsd: cfg.liveOscarScalpWaveVol1hMinUsd,
    postCrashFastPathMinDropPct: cfg.liveOscarScalpWaveDipMinDropPct,
    positionUsd: cfg.liveOscarScalpWavePositionUsd,
  };
}

export function liveOscarScalpWaveOpenLegUsd(cfg: PaperTraderConfig): number {
  return cfg.liveOscarScalpWavePositionUsd;
}

export interface ScalpWaveDiscoveryEval {
  pass: boolean;
  reasons: string[];
  entryPath?: ScalpWaveEntryPath;
}

/** Lightweight discovery path — snapshot + shallow dip; skips prod protectors / runner / staged. */
export function evaluateLiveOscarScalpWaveDiscovery(args: {
  cfg: PaperTraderConfig;
  row: SnapshotCandidateRow;
  lane: Lane;
  refMcap: number;
  ageMin: number;
  dipCtx: DipContextByWindows | undefined;
}): ScalpWaveDiscoveryEval {
  const { cfg, row, lane, refMcap, ageMin, dipCtx } = args;
  const reasons: string[] = [];

  if (!isLiveOscarScalpWaveLaneEnabled(cfg)) {
    return { pass: false, reasons: ['scalp_wave_lane_disabled'], entryPath: undefined };
  }
  if (resolveLiveOscarScalpWaveMcapTier(cfg, refMcap) !== 'scalp_wave') {
    reasons.push(
      `scalp_wave_mcap_outside_${cfg.liveOscarScalpWaveMinMcapUsd}_${cfg.liveOscarScalpWaveMaxMcapUsd}`,
    );
    return { pass: false, reasons, entryPath: undefined };
  }
  if (!liveOscarScalpWaveAgeMeetsMin(cfg, ageMin)) {
    const minH = Math.round(cfg.liveOscarScalpWaveMinAgeMin / 60);
    reasons.push(`scalp_wave_age_below_${minH}h`);
    return { pass: false, reasons, entryPath: undefined };
  }

  const scalpCfg = liveOscarScalpWaveEntryConfig(cfg);
  const snap = evaluateSnapshot(scalpCfg, row, lane);
  const globalReasons = globalGate(scalpCfg, row.token_age_min, row.holder_count, {
    skipHolderCheck: cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0,
  });
  if (!snap.pass || globalReasons.length > 0) {
    return {
      pass: false,
      reasons: [...snap.reasons, ...globalReasons],
      entryPath: undefined,
    };
  }

  const dipEval = evaluateDip(scalpCfg, row, dipCtx);
  if (dipEval.reasons.length > 0) {
    return { pass: false, reasons: dipEval.reasons, entryPath: undefined };
  }

  return { pass: true, reasons: [], entryPath: 'dip_windows' };
}

/** Stamp trade lane + mcap tier on OpenTrade at discovery open. */
export function stampLiveOscarTradeLaneOnOpen(ot: OpenTrade, tradeLane: LiveOscarTradeLane): void {
  ot.liveOscarTradeLane = tradeLane;
  if (tradeLane === 'scalp_wave') {
    ot.liveOscarMcapTier = 'scalp_wave';
  }
  /** fast_dip_scalp is identified via liveOscarTradeLane / liveExitPolicyId, not the mcap-tier axis. */
}

export function liveOscarMintOpenSkipReason(args: {
  open: ReadonlyMap<string, OpenTrade>;
  mint: string;
  incomingTradeLane: LiveOscarTradeLane;
  cfg?: PaperTraderConfig;
}): 'lane_mint_mutex' | 'already_open' | 'phase_escalation_handoff' | null {
  if (args.cfg) {
    return liveOscarMintOpenSkipReasonForEscalation({
      open: args.open,
      mint: args.mint,
      incomingTradeLane: args.incomingTradeLane,
      cfg: args.cfg,
    });
  }
  const existing = args.open.get(args.mint);
  if (!existing) return null;
  const openLane = resolveLiveOscarTradeLaneFromOpen(existing);
  return openLane !== args.incomingTradeLane ? 'lane_mint_mutex' : 'already_open';
}

/** prod tier entry config passthrough (unchanged). */
export { liveOscarTierEntryConfig };
