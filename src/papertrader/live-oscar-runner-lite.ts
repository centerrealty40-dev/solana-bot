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

export const RUNNER_LITE_POSITION_SOURCE = 'runner_lite' as const;

export type RunnerLiteEntryPath = 'dip_windows' | 'runner';

const RUNNER_LITE_MAP_SUFFIX = '::runner_lite';

export function runnerLiteOpenMapKey(mint: string): string {
  return `${mint}${RUNNER_LITE_MAP_SUFFIX}`;
}

export function isRunnerLiteOpenMapKey(key: string): boolean {
  return key.endsWith(RUNNER_LITE_MAP_SUFFIX);
}

/** Strip composite lane suffix (`::runner_probe` / `::runner_lite`) for PG/Jupiter/journal mint. */
export function mintFromCompositeOpenMapKey(key: string): string {
  if (isRunnerLiteOpenMapKey(key)) return key.slice(0, -RUNNER_LITE_MAP_SUFFIX.length);
  if (key.endsWith('::runner_probe')) return key.slice(0, -'::runner_probe'.length);
  return key;
}

export function resolveOpenMapKey(
  ot: Pick<OpenTrade, 'mint' | 'positionSource' | 'liveOscarTradeLane' | 'liveExitPolicyId'>,
): string {
  if (isRunnerLiteTrade(ot)) return runnerLiteOpenMapKey(ot.mint);
  if (isRunnerProbeTrade(ot)) return `${ot.mint}::runner_probe`;
  return ot.mint;
}

/** @deprecated Use {@link mintFromCompositeOpenMapKey}. */
export { mintFromCompositeOpenMapKey as mintFromOpenMapKey };

function isRunnerProbeTrade(
  ot: Pick<OpenTrade, 'positionSource' | 'liveOscarTradeLane' | 'liveExitPolicyId'>,
): boolean {
  if (ot.positionSource === 'runner_probe') return true;
  if (ot.liveOscarTradeLane === 'runner_probe') return true;
  return ot.liveExitPolicyId === 'runner_probe_v1';
}

/** Re-key runner_lite opens to `mint::runner_lite` after journal/snapshot replay at bare mint. */
export function normalizeRunnerLiteOpenMapKeys(open: Map<string, OpenTrade>): number {
  let migrated = 0;
  for (const [key, ot] of [...open.entries()]) {
    if (!isRunnerLiteTrade(ot)) continue;
    stampRunnerLiteOnOpen(ot);
    const canon = resolveOpenMapKey(ot);
    if (key === canon) continue;
    open.delete(key);
    open.set(canon, ot);
    migrated += 1;
  }
  return migrated;
}

export function isRunnerLiteLaneEnabled(cfg: PaperTraderConfig): boolean {
  return isLiveOscarTradingStrategyId(cfg.strategyId) && cfg.runnerLiteEnabled;
}

export function isRunnerLiteTrade(
  ot: Pick<OpenTrade, 'positionSource' | 'liveOscarTradeLane' | 'liveExitPolicyId'>,
): boolean {
  if (ot.positionSource === RUNNER_LITE_POSITION_SOURCE) return true;
  if (ot.liveOscarTradeLane === 'runner_lite') return true;
  return ot.liveExitPolicyId === 'runner_lite_v1';
}

export function countOpenRunnerLitePositions(open: ReadonlyMap<string, OpenTrade>): number {
  let n = 0;
  for (const ot of open.values()) {
    if (isRunnerLiteTrade(ot)) n++;
  }
  return n;
}

export function sumRunnerLiteExposureUsd(open: ReadonlyMap<string, OpenTrade>): number {
  let sum = 0;
  for (const ot of open.values()) {
    if (!isRunnerLiteTrade(ot)) continue;
    sum += ot.totalInvestedUsd > 0 ? ot.totalInvestedUsd : ot.legs.reduce((a, l) => a + l.sizeUsd, 0);
  }
  return sum;
}

/** Age band 12h–48h (720–2880 min) — aligned with runner_probe / volume-leader inject floor. */
export function runnerLiteAgeInBand(cfg: PaperTraderConfig, ageMin: number): boolean {
  const age = Number(ageMin);
  if (!Number.isFinite(age)) return false;
  if (age + 1e-9 < cfg.runnerLiteMinAgeMin) return false;
  if (age - 1e-9 > cfg.runnerLiteMaxAgeMin) return false;
  return true;
}

export type RunnerLiteTier = 'tier1' | 'tier2';

/** Probe outcome for tier routing — `fullyPassed` = all runner_probe gates (pre-rank). */
export type RunnerLiteProbeOutcome = {
  inBand: boolean;
  fullyPassed: boolean;
};

/**
 * SQL/discovery prefilter: age in lite band and mcap $500k…probe max (tier-1 + tier-2 fallback).
 */
export function runnerLiteDiscoveryPrefilter(
  cfg: PaperTraderConfig,
  refMcapUsd: number,
  ageMin: number,
): boolean {
  if (!isRunnerLiteLaneEnabled(cfg)) return false;
  if (!runnerLiteAgeInBand(cfg, ageMin)) return false;
  const mcap = Number(refMcapUsd);
  if (!Number.isFinite(mcap) || mcap + 1e-9 < cfg.runnerLiteMinMcapUsd) return false;
  if (cfg.runnerProbeMaxMcapUsd > 0 && mcap - 1e-9 > cfg.runnerProbeMaxMcapUsd) return false;
  return true;
}

/** @deprecated Prefer {@link runnerLiteDiscoveryPrefilter} + {@link resolveRunnerLiteTier}. */
export function runnerLiteCandidateInBand(
  cfg: PaperTraderConfig,
  refMcapUsd: number,
  ageMin: number,
): boolean {
  return runnerLiteDiscoveryPrefilter(cfg, refMcapUsd, ageMin);
}

/**
 * Tier-1 mcap band: $500k – <$1M — always runner_lite (2×$100), never runner_probe $500.
 */
export function runnerLiteTier1McapInBand(cfg: PaperTraderConfig, mcapUsd: number): boolean {
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return false;
  if (cfg.runnerLiteMinMcapUsd > 0 && mcap + 1e-9 < cfg.runnerLiteMinMcapUsd) return false;
  const tier1Max = Math.min(cfg.runnerLiteMaxMcapUsd, cfg.runnerProbeMinMcapUsd - 1);
  if (tier1Max > 0 && mcap - 1e-9 > tier1Max) return false;
  return true;
}

/** Tier-1 mcap band alias — see {@link runnerLiteTier1McapInBand}. */
export function runnerLiteMcapInBand(cfg: PaperTraderConfig, mcapUsd: number): boolean {
  return runnerLiteTier1McapInBand(cfg, mcapUsd);
}

/** Tier-2 fallback: mcap ≥ probe min when probe was in-band but did not fully pass. */
export function runnerLiteTier2McapInBand(cfg: PaperTraderConfig, mcapUsd: number): boolean {
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return false;
  if (cfg.runnerProbeMinMcapUsd > 0 && mcap + 1e-9 < cfg.runnerProbeMinMcapUsd) return false;
  if (cfg.runnerProbeMaxMcapUsd > 0 && mcap - 1e-9 > cfg.runnerProbeMaxMcapUsd) return false;
  return true;
}

/**
 * Resolve runner_lite tier from mcap + probe outcome.
 * Priority: probe full pass → no lite; else tier1 ($500k–<$1M) or tier2 (probe fallback).
 */
export function resolveRunnerLiteTier(
  cfg: PaperTraderConfig,
  refMcapUsd: number,
  ageMin: number,
  probeOutcome: RunnerLiteProbeOutcome,
): { tier: RunnerLiteTier | null; reasons: string[] } {
  const reasons: string[] = [];
  if (!isRunnerLiteLaneEnabled(cfg)) {
    return { tier: null, reasons: ['runner_lite_lane_disabled'] };
  }
  if (!runnerLiteAgeInBand(cfg, ageMin)) {
    const minH = Math.round(cfg.runnerLiteMinAgeMin / 60);
    const maxH = Math.round(cfg.runnerLiteMaxAgeMin / 60);
    reasons.push(`runner_lite_age_outside_${minH}h_${maxH}h`);
    return { tier: null, reasons };
  }
  const mcap = Number(refMcapUsd);
  if (!Number.isFinite(mcap) || mcap + 1e-9 < cfg.runnerLiteMinMcapUsd) {
    reasons.push(`runner_lite_mcap_below_${cfg.runnerLiteMinMcapUsd}`);
    return { tier: null, reasons };
  }
  if (runnerLiteTier1McapInBand(cfg, mcap)) {
    return { tier: 'tier1', reasons: [] };
  }
  if (probeOutcome.fullyPassed) {
    reasons.push('runner_lite_skipped_probe_full_pass');
    return { tier: null, reasons };
  }
  if (!probeOutcome.inBand) {
    reasons.push(
      `runner_lite_tier2_requires_probe_band_${cfg.runnerProbeMinMcapUsd}_${cfg.runnerProbeMaxMcapUsd}`,
    );
    return { tier: null, reasons };
  }
  if (!runnerLiteTier2McapInBand(cfg, mcap)) {
    reasons.push(`runner_lite_mcap_outside_fallback_${cfg.runnerProbeMaxMcapUsd}`);
    return { tier: null, reasons };
  }
  return { tier: 'tier2', reasons: [] };
}

export function runnerLiteRunnerFetchConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  return { ...runnerLiteRunnerEvalConfig(cfg, 'tier1'), runnerModeEnabled: true };
}

export function runnerLiteRunnerEvalConfig(
  cfg: PaperTraderConfig,
  tier: RunnerLiteTier,
): PaperTraderConfig {
  const runnerMinMcapUsd =
    tier === 'tier1' ? cfg.runnerLiteMinMcapUsd : cfg.runnerProbeMinMcapUsd;
  const runnerMaxMcapUsd =
    tier === 'tier1'
      ? Math.min(cfg.runnerLiteMaxMcapUsd, cfg.runnerProbeMinMcapUsd - 1)
      : cfg.runnerProbeMaxMcapUsd;
  return {
    ...cfg,
    runnerModeEnabled: true,
    runnerMinVol1hUsd: cfg.runnerLiteMinVol1hUsd,
    runnerMinVol12hUsd: cfg.runnerLiteMinVol12hUsd,
    runnerVelocityMinX: cfg.runnerLiteVelocityMinX,
    runnerMinVol5mPeak1hUsd: cfg.runnerLiteMinVol5mPeak1hUsd,
    runnerBs1hMin: cfg.runnerLiteBs1hMin,
    runnerBs12hMin: cfg.runnerLiteBs12hMin,
    runnerLiqVsP25Min: cfg.runnerLiteLiqVsP25Min,
    runnerPriceHoldMin: cfg.runnerLitePriceHoldMin,
    runnerMinMcapUsd,
    runnerMaxMcapUsd,
    runnerMinLiqUsd: cfg.runnerLiteMinLiqUsd,
    runnerStaleVolRatioMax: cfg.runnerLiteStaleVolRatioMax,
    runnerMinPgSamples24h: cfg.runnerLiteMinPgSamples24h,
  };
}

export function runnerLiteEntryConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  const minAge = cfg.runnerLiteMinAgeMin;
  return {
    ...cfg,
    /** Mcap band already enforced by {@link resolveRunnerLiteTier}; prod $2M floor must not block lite. */
    discoveryMinMarketCapUsd: 0,
    dipMinDropPct: cfg.runnerLiteDipMinDropPct,
    dipMaxDropPct: cfg.runnerLiteDipMaxDropPct,
    dipMinAgeMin: minAge,
    globalMinTokenAgeMin: minAge,
    dipMinImpulsePct: cfg.runnerLiteMinImpulsePct,
    vol1hMinUsd: cfg.runnerLiteVol1hMinUsd,
    postCrashFastPathMinDropPct: cfg.runnerLiteDipMinDropPct,
    positionUsd: cfg.runnerLitePositionUsd,
  };
}

/** First leg of 2×$100 entry split. */
export function runnerLiteOpenLegUsd(cfg: PaperTraderConfig): number {
  return cfg.runnerLiteLegUsd;
}

export function runnerLiteSecondLegUsd(cfg: PaperTraderConfig): number {
  return Math.max(0, cfg.runnerLitePositionUsd - cfg.runnerLiteLegUsd);
}

export function runnerLiteRankScore(f: RunnerWindowFeatures): number {
  const vel = f.vol1hVelocity != null && Number.isFinite(f.vol1hVelocity) ? f.vol1hVelocity : 1;
  return f.vol1hUsd * Math.max(vel, 1);
}

export interface RunnerLiteDiscoveryEval {
  pass: boolean;
  reasons: string[];
  entryPath?: RunnerLiteEntryPath;
  runnerFeatures?: RunnerWindowFeatures;
  rankScore?: number;
  intelReasons?: string[];
  tier?: RunnerLiteTier;
}

export function evaluateLiveOscarRunnerLiteDiscovery(args: {
  cfg: PaperTraderConfig;
  row: SnapshotCandidateRow;
  lane: Lane;
  refMcap: number;
  ageMin: number;
  dipCtx: DipContextByWindows | undefined;
  runnerCtx: RunnerWindowFeatures | undefined;
  probeOutcome?: RunnerLiteProbeOutcome;
}): RunnerLiteDiscoveryEval {
  const { cfg, row, lane, refMcap, ageMin, dipCtx, runnerCtx } = args;
  const probeOutcome = args.probeOutcome ?? { inBand: false, fullyPassed: false };

  const tierRes = resolveRunnerLiteTier(cfg, refMcap, ageMin, probeOutcome);
  if (!tierRes.tier) {
    return { pass: false, reasons: tierRes.reasons };
  }
  const tier = tierRes.tier;

  const runnerCfg = runnerLiteRunnerEvalConfig(cfg, tier);
  const runnerEval = evaluateRunner(runnerCfg, row, runnerCtx);
  if (!runnerEval.pass) {
    return {
      pass: false,
      reasons: runnerEval.reasons.map((r) => `runner_lite_${r}`),
      runnerFeatures: runnerEval.features,
      tier,
    };
  }

  const liteCfg = runnerLiteEntryConfig(cfg);
  const snap = evaluateSnapshot(liteCfg, row, lane);
  const globalReasons = globalGate(liteCfg, row.token_age_min, row.holder_count, {
    skipHolderCheck: cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0,
  });
  if (!snap.pass || globalReasons.length > 0) {
    return {
      pass: false,
      reasons: [...snap.reasons, ...globalReasons],
      runnerFeatures: runnerEval.features,
      tier,
    };
  }

  const dipEval = evaluateDip(liteCfg, row, dipCtx);
  if (dipEval.reasons.length > 0) {
    return {
      pass: false,
      reasons: dipEval.reasons,
      runnerFeatures: runnerEval.features,
      entryPath: 'dip_windows',
      tier,
    };
  }

  return {
    pass: true,
    reasons: [],
    entryPath: 'dip_windows',
    runnerFeatures: runnerEval.features,
    rankScore: runnerLiteRankScore(runnerEval.features),
    tier,
  };
}

export function stampRunnerLiteOnOpen(ot: OpenTrade): void {
  ot.positionSource = RUNNER_LITE_POSITION_SOURCE;
  ot.liveOscarTradeLane = 'runner_lite';
}

export function runnerLiteMintAlreadyOpen(open: ReadonlyMap<string, OpenTrade>, mint: string): boolean {
  if (open.has(runnerLiteOpenMapKey(mint))) return true;
  const bare = open.get(mint);
  return bare != null && isRunnerLiteTrade(bare);
}

export function runnerProbeMintAlreadyOpen(open: ReadonlyMap<string, OpenTrade>, mint: string): boolean {
  const probeKey = `${mint}::runner_probe`;
  if (open.has(probeKey)) return true;
  const bare = open.get(mint);
  return bare != null && isRunnerProbeTrade(bare);
}

export function runnerLiteMintOpenSkipReason(args: {
  open: ReadonlyMap<string, OpenTrade>;
  mint: string;
}): 'runner_lite_already_open' | 'runner_probe_blocks_runner_lite' | 'prod_blocks_runner_lite' | null {
  if (runnerLiteMintAlreadyOpen(args.open, args.mint)) return 'runner_lite_already_open';
  if (runnerProbeMintAlreadyOpen(args.open, args.mint)) return 'runner_probe_blocks_runner_lite';
  const prodOt = args.open.get(args.mint);
  if (prodOt && !isRunnerLiteTrade(prodOt) && !isRunnerProbeTrade(prodOt)) return 'prod_blocks_runner_lite';
  return null;
}

/** Attach second $100 leg via live/paper scale-in machinery. */
export function attachRunnerLitePendingScaleIn(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  snapshotEntryPriceUsd: number,
  opts: {
    delayMs: number;
    corridorUpPct: number;
    corridorDownPct: number;
    maxSwapAttempts: number;
  },
): void {
  const secondUsd = runnerLiteSecondLegUsd(cfg);
  if (!(secondUsd > 1e-6)) return;
  ot.livePendingScaleIn = {
    anchorMarketUsd: ot.legs[0]?.marketPrice ?? snapshotEntryPriceUsd,
    secondLegUsd: secondUsd,
    executeAfterTs: Date.now() + opts.delayMs,
    corridorUpPct: opts.corridorUpPct,
    corridorDownPct: opts.corridorDownPct,
    maxSwapAttempts: opts.maxSwapAttempts,
    swapAttempts: 0,
    nextAttemptAfterTs: 0,
  };
}

export { fetchRunnerContextMap, summariseRunnerPass };
