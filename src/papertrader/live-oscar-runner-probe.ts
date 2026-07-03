import type { PaperTraderConfig } from './config.js';
import { evaluateDip, type DipContextByWindows } from './dip-detector.js';
import { evaluateSnapshot } from './filters/snapshot-filter.js';
import { globalGate } from './filters/global-gate.js';
import type { Lane, OpenTrade, SnapshotCandidateRow } from './types.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';
import {
  evaluateRunner,
  fetchRunnerContextMap,
  summariseRunnerPass,
  type RunnerWindowFeatures,
} from './discovery/runner-mode.js';

export const RUNNER_PROBE_POSITION_SOURCE = 'runner_probe' as const;

export type RunnerProbeEntryPath = 'dip_windows' | 'runner';

const RUNNER_PROBE_MAP_SUFFIX = '::runner_probe';

export function runnerProbeOpenMapKey(mint: string): string {
  return `${mint}${RUNNER_PROBE_MAP_SUFFIX}`;
}

export function isRunnerProbeOpenMapKey(key: string): boolean {
  return key.endsWith(RUNNER_PROBE_MAP_SUFFIX);
}

import {
  resolveOpenMapKey,
  mintFromCompositeOpenMapKey,
  runnerLiteMintAlreadyOpen,
} from './live-oscar-runner-lite.js';

export { resolveOpenMapKey, mintFromCompositeOpenMapKey as mintFromOpenMapKey };

/** Re-key runner_probe opens to `mint::runner_probe` after journal/snapshot replay at bare mint. */
export function normalizeRunnerProbeOpenMapKeys(open: Map<string, OpenTrade>): number {
  let migrated = 0;
  for (const [key, ot] of [...open.entries()]) {
    if (!isRunnerProbeTrade(ot)) continue;
    stampRunnerProbeOnOpen(ot);
    const canon = resolveOpenMapKey(ot);
    if (key === canon) continue;
    open.delete(key);
    open.set(canon, ot);
    migrated += 1;
  }
  return migrated;
}

export function isRunnerProbeLaneEnabled(cfg: PaperTraderConfig): boolean {
  return isLiveOscarTradingStrategyId(cfg.strategyId) && cfg.runnerProbeEnabled;
}

export function isRunnerProbeTrade(
  ot: Pick<OpenTrade, 'positionSource' | 'liveOscarTradeLane' | 'liveExitPolicyId'>,
): boolean {
  if (ot.positionSource === RUNNER_PROBE_POSITION_SOURCE) return true;
  if (ot.liveOscarTradeLane === 'runner_probe') return true;
  return ot.liveExitPolicyId === 'runner_probe_v1';
}

export function countOpenRunnerProbePositions(open: ReadonlyMap<string, OpenTrade>): number {
  let n = 0;
  for (const ot of open.values()) {
    if (isRunnerProbeTrade(ot)) n++;
  }
  return n;
}

export function sumRunnerProbeExposureUsd(open: ReadonlyMap<string, OpenTrade>): number {
  let sum = 0;
  for (const ot of open.values()) {
    if (!isRunnerProbeTrade(ot)) continue;
    sum += ot.totalInvestedUsd > 0 ? ot.totalInvestedUsd : ot.legs.reduce((a, l) => a + l.sizeUsd, 0);
  }
  return sum;
}

/** Age band 12h–48h (minutes). */
export function runnerProbeAgeInBand(cfg: PaperTraderConfig, ageMin: number): boolean {
  const age = Number(ageMin);
  if (!Number.isFinite(age)) return false;
  if (age + 1e-9 < cfg.runnerProbeMinAgeMin) return false;
  if (age - 1e-9 > cfg.runnerProbeMaxAgeMin) return false;
  return true;
}

/** Preflight: runner_probe lane only applies inside configured age + mcap bands. */
export function runnerProbeCandidateInBand(
  cfg: PaperTraderConfig,
  refMcapUsd: number,
  ageMin: number,
): boolean {
  return runnerProbeMcapInBand(cfg, refMcapUsd) && runnerProbeAgeInBand(cfg, ageMin);
}

export function runnerProbeMcapInBand(cfg: PaperTraderConfig, mcapUsd: number): boolean {
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return false;
  if (cfg.runnerProbeMinMcapUsd > 0 && mcap + 1e-9 < cfg.runnerProbeMinMcapUsd) return false;
  if (cfg.runnerProbeMaxMcapUsd > 0 && mcap - 1e-9 > cfg.runnerProbeMaxMcapUsd) return false;
  return true;
}

/** Runner SQL fetch cfg — probe lane uses strict runner thresholds without enabling prod runner mode. */
export function runnerProbeRunnerFetchConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  return { ...runnerProbeRunnerEvalConfig(cfg), runnerModeEnabled: true };
}

export function runnerProbeRunnerEvalConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  return {
    ...cfg,
    runnerModeEnabled: true,
    runnerMinVol1hUsd: cfg.runnerProbeMinVol1hUsd,
    runnerMinVol12hUsd: cfg.runnerProbeMinVol12hUsd,
    runnerVelocityMinX: cfg.runnerProbeVelocityMinX,
    runnerMinVol5mPeak1hUsd: cfg.runnerProbeMinVol5mPeak1hUsd,
    runnerBs1hMin: cfg.runnerProbeBs1hMin,
    runnerBs12hMin: cfg.runnerProbeBs12hMin,
    runnerLiqVsP25Min: cfg.runnerProbeLiqVsP25Min,
    runnerPriceHoldMin: cfg.runnerProbePriceHoldMin,
    runnerMinMcapUsd: cfg.runnerProbeMinMcapUsd,
    runnerMaxMcapUsd: cfg.runnerProbeMaxMcapUsd,
    runnerMinLiqUsd: cfg.runnerProbeMinLiqUsd,
    runnerStaleVolRatioMax: cfg.runnerProbeStaleVolRatioMax,
    runnerMinPgSamples24h: cfg.runnerProbeMinPgSamples24h,
  };
}

export function runnerProbeEntryConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  const minAge = cfg.runnerProbeMinAgeMin;
  return {
    ...cfg,
    /** Probe band ($1M–$3M) is below prod discovery floor; tier routing owns mcap. */
    discoveryMinMarketCapUsd: 0,
    dipMinDropPct: cfg.runnerProbeDipMinDropPct,
    dipMaxDropPct: cfg.runnerProbeDipMaxDropPct,
    dipMinAgeMin: minAge,
    globalMinTokenAgeMin: minAge,
    dipMinImpulsePct: cfg.runnerProbeMinImpulsePct,
    vol1hMinUsd: cfg.runnerProbeVol1hMinUsd,
    postCrashFastPathMinDropPct: cfg.runnerProbeDipMinDropPct,
    positionUsd: cfg.runnerProbePositionUsd,
  };
}

export function runnerProbeOpenLegUsd(cfg: PaperTraderConfig): number {
  return cfg.runnerProbePositionUsd;
}

/**
 * Top-runner ranking among guard-passing candidates:
 * `score = vol1hUsd × max(vol1hVelocity, 1)` — favors high absolute 1h volume and acceleration.
 */
export function runnerProbeRankScore(f: RunnerWindowFeatures): number {
  const vel = f.vol1hVelocity != null && Number.isFinite(f.vol1hVelocity) ? f.vol1hVelocity : 1;
  return f.vol1hUsd * Math.max(vel, 1);
}

export interface RunnerProbeDiscoveryEval {
  pass: boolean;
  reasons: string[];
  entryPath?: RunnerProbeEntryPath;
  runnerFeatures?: RunnerWindowFeatures;
  rankScore?: number;
  intelReasons?: string[];
}

export function evaluateLiveOscarRunnerProbeDiscovery(args: {
  cfg: PaperTraderConfig;
  row: SnapshotCandidateRow;
  lane: Lane;
  refMcap: number;
  ageMin: number;
  dipCtx: DipContextByWindows | undefined;
  runnerCtx: RunnerWindowFeatures | undefined;
}): RunnerProbeDiscoveryEval {
  const { cfg, row, lane, refMcap, ageMin, dipCtx, runnerCtx } = args;
  const reasons: string[] = [];

  if (!isRunnerProbeLaneEnabled(cfg)) {
    return { pass: false, reasons: ['runner_probe_lane_disabled'] };
  }
  if (!runnerProbeMcapInBand(cfg, refMcap)) {
    reasons.push(
      `runner_probe_mcap_outside_${cfg.runnerProbeMinMcapUsd}_${cfg.runnerProbeMaxMcapUsd}`,
    );
    return { pass: false, reasons };
  }
  if (!runnerProbeAgeInBand(cfg, ageMin)) {
    const minH = Math.round(cfg.runnerProbeMinAgeMin / 60);
    const maxH = Math.round(cfg.runnerProbeMaxAgeMin / 60);
    reasons.push(`runner_probe_age_outside_${minH}h_${maxH}h`);
    return { pass: false, reasons };
  }

  const runnerCfg = runnerProbeRunnerEvalConfig(cfg);
  const runnerEval = evaluateRunner(runnerCfg, row, runnerCtx);
  if (!runnerEval.pass) {
    return {
      pass: false,
      reasons: runnerEval.reasons.map((r) => `runner_probe_${r}`),
      runnerFeatures: runnerEval.features,
    };
  }

  const probeCfg = runnerProbeEntryConfig(cfg);
  const snap = evaluateSnapshot(probeCfg, row, lane);
  const globalReasons = globalGate(probeCfg, row.token_age_min, row.holder_count, {
    skipHolderCheck: cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0,
  });
  if (!snap.pass || globalReasons.length > 0) {
    return {
      pass: false,
      reasons: [...snap.reasons, ...globalReasons],
      runnerFeatures: runnerEval.features,
    };
  }

  const dipEval = evaluateDip(probeCfg, row, dipCtx);
  if (dipEval.reasons.length > 0) {
    return {
      pass: false,
      reasons: dipEval.reasons,
      runnerFeatures: runnerEval.features,
      entryPath: 'dip_windows',
    };
  }

  return {
    pass: true,
    reasons: [],
    entryPath: 'dip_windows',
    runnerFeatures: runnerEval.features,
    rankScore: runnerProbeRankScore(runnerEval.features),
  };
}

/** Stamp runner_probe lane on OpenTrade — parallel to prod (composite open-map key). */
export function stampRunnerProbeOnOpen(ot: OpenTrade): void {
  ot.positionSource = RUNNER_PROBE_POSITION_SOURCE;
  ot.liveOscarTradeLane = 'runner_probe';
}

export function runnerProbeMintAlreadyOpen(open: ReadonlyMap<string, OpenTrade>, mint: string): boolean {
  if (open.has(runnerProbeOpenMapKey(mint))) return true;
  const bare = open.get(mint);
  return bare != null && isRunnerProbeTrade(bare);
}

/**
 * Runner probe does not block prod/scalp on same mint; prod/scalp block runner_probe re-entry only.
 */
export function runnerProbeMintOpenSkipReason(args: {
  open: ReadonlyMap<string, OpenTrade>;
  mint: string;
}): 'runner_probe_already_open' | 'runner_lite_blocks_runner_probe' | 'prod_blocks_runner_probe' | null {
  if (runnerProbeMintAlreadyOpen(args.open, args.mint)) return 'runner_probe_already_open';
  if (runnerLiteMintAlreadyOpen(args.open, args.mint)) return 'runner_lite_blocks_runner_probe';
  const prodOt = args.open.get(args.mint);
  if (prodOt && !isRunnerProbeTrade(prodOt) && prodOt.liveOscarTradeLane !== 'runner_lite') {
    return 'prod_blocks_runner_probe';
  }
  return null;
}

export { fetchRunnerContextMap, summariseRunnerPass };
