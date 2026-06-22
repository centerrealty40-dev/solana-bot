import type { PaperTraderConfig } from './config.js';
import { evaluateDip, type DipContextByWindows } from './dip-detector.js';
import { evaluateSnapshot } from './filters/snapshot-filter.js';
import { globalGate } from './filters/global-gate.js';
import type { Lane, OpenTrade, SnapshotCandidateRow } from './types.js';
import { liveOscarTierEntryConfig, type LiveOscarMcapTier } from './live-oscar-mcap-tier.js';

/** Trade strategy lane — mutex dimension (one open per mint across lanes). */
export type LiveOscarTradeLane = 'prod' | 'scalp_wave';

export type ScalpWaveEntryPath = 'dip_windows';

export function isLiveOscarScalpWaveLaneEnabled(cfg: PaperTraderConfig): boolean {
  return cfg.strategyId === 'live-oscar' && cfg.liveOscarScalpWaveLaneEnabled;
}

export function resolveLiveOscarTradeLaneFromOpen(
  ot: Pick<OpenTrade, 'liveOscarTradeLane' | 'liveOscarMcapTier' | 'liveExitPolicyId'>,
): LiveOscarTradeLane {
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

export function liveOscarScalpWaveAgeInBand(cfg: PaperTraderConfig, ageMin: number): boolean {
  const age = Number(ageMin);
  if (!Number.isFinite(age)) return false;
  return age + 1e-9 >= cfg.liveOscarScalpWaveMinAgeMin && age - 1e-9 <= cfg.liveOscarScalpWaveMaxAgeMin;
}

/** Per-lane entry thresholds: shallow dip −8..−15%, no staged split. */
export function liveOscarScalpWaveEntryConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  return {
    ...cfg,
    dipMinDropPct: cfg.liveOscarScalpWaveDipMinDropPct,
    dipMaxDropPct: cfg.liveOscarScalpWaveDipMaxDropPct,
    dipMinAgeMin: cfg.liveOscarScalpWaveMinAgeMin,
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
  if (!liveOscarScalpWaveAgeInBand(cfg, ageMin)) {
    reasons.push(
      `scalp_wave_age_outside_${cfg.liveOscarScalpWaveMinAgeMin}_${cfg.liveOscarScalpWaveMaxAgeMin}m`,
    );
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
}

export function liveOscarMintOpenSkipReason(args: {
  open: ReadonlyMap<string, OpenTrade>;
  mint: string;
  incomingTradeLane: LiveOscarTradeLane;
}): 'lane_mint_mutex' | 'already_open' | null {
  const existing = args.open.get(args.mint);
  if (!existing) return null;
  const openLane = resolveLiveOscarTradeLaneFromOpen(existing);
  return openLane !== args.incomingTradeLane ? 'lane_mint_mutex' : 'already_open';
}

/** prod tier entry config passthrough (unchanged). */
export { liveOscarTierEntryConfig };
