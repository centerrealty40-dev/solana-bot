import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  countOpenRunnerLitePositions,
  evaluateLiveOscarRunnerLiteDiscovery,
  isRunnerLiteTrade,
  normalizeRunnerLiteOpenMapKeys,
  resolveOpenMapKey,
  resolveRunnerLiteTier,
  runnerLiteAgeInBand,
  runnerLiteCandidateInBand,
  runnerLiteDiscoveryPrefilter,
  runnerLiteMcapInBand,
  normalizeRunnerLiteOpenMapKeys,
  runnerLiteMintOpenSkipReason,
  runnerLiteOpenLegUsd,
  runnerLiteOpenMapKey,
  runnerLiteRankScore,
  runnerLiteTier2McapInBand,
  RUNNER_LITE_POSITION_SOURCE,
  runnerProbeMintAlreadyOpen,
  stampRunnerLiteOnOpen,
  sumRunnerLiteExposureUsd,
} from '../src/papertrader/live-oscar-runner-lite.js';
import {
  runnerProbeCandidateInBand,
  runnerProbeMintOpenSkipReason,
  RUNNER_PROBE_POSITION_SOURCE,
} from '../src/papertrader/live-oscar-runner-probe.js';
import {
  isRunnerLiteExitPolicy,
  runnerLiteMaxPositionUsd,
  stampRunnerLiteExitPolicyOnOpen,
} from '../src/papertrader/executor/exit-policy-runner-lite.js';
import type { OpenTrade, SnapshotCandidateRow } from '../src/papertrader/types.js';
import type { RunnerWindowFeatures } from '../src/papertrader/discovery/runner-mode.js';

describe('live-oscar-runner-lite', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = [
      'PAPER_STRATEGY_ID',
      'PAPER_RUNNER_LITE_ENABLED',
      'PAPER_RUNNER_LITE_MIN_AGE_MIN',
      'PAPER_RUNNER_LITE_MAX_AGE_MIN',
      'PAPER_RUNNER_LITE_MIN_MCAP_USD',
      'PAPER_RUNNER_LITE_MAX_MCAP_USD',
      'PAPER_RUNNER_LITE_POSITION_USD',
      'PAPER_RUNNER_LITE_LEG_USD',
      'PAPER_RUNNER_PROBE_ENABLED',
      'PAPER_RUNNER_PROBE_MIN_MCAP_USD',
      'LIVE_OSCAR_INTEL_ENABLED',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_RUNNER_LITE_ENABLED = '1';
    process.env.PAPER_RUNNER_LITE_MIN_AGE_MIN = '720';
    process.env.PAPER_RUNNER_LITE_MAX_AGE_MIN = '2880';
    process.env.PAPER_RUNNER_LITE_MIN_MCAP_USD = '500000';
    process.env.PAPER_RUNNER_LITE_MAX_MCAP_USD = '999999';
    process.env.PAPER_RUNNER_LITE_POSITION_USD = '200';
    process.env.PAPER_RUNNER_LITE_LEG_USD = '100';
    process.env.PAPER_RUNNER_PROBE_ENABLED = '1';
    process.env.PAPER_RUNNER_PROBE_MIN_MCAP_USD = '1000000';
    process.env.LIVE_OSCAR_INTEL_ENABLED = '0';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('mcap bands are disjoint: lite [$500k,$1M) vs probe [$1M,$30M]', () => {
    const cfg = loadPaperTraderConfig();
    expect(runnerLiteMcapInBand(cfg, 499_999)).toBe(false);
    expect(runnerLiteMcapInBand(cfg, 500_000)).toBe(true);
    expect(runnerLiteMcapInBand(cfg, 800_000)).toBe(true);
    expect(runnerLiteMcapInBand(cfg, 999_999)).toBe(true);
    expect(runnerLiteMcapInBand(cfg, 1_000_000)).toBe(false);
    expect(runnerProbeCandidateInBand(cfg, 800_000, 1500)).toBe(false);
    expect(runnerProbeCandidateInBand(cfg, 1_000_000, 1500)).toBe(true);
  });

  it('mcap-first: $800k with probe-level metrics stays lite band, not probe', () => {
    const cfg = loadPaperTraderConfig();
    expect(runnerLiteCandidateInBand(cfg, 800_000, 1500)).toBe(true);
    expect(runnerProbeCandidateInBand(cfg, 800_000, 1500)).toBe(false);
  });

  it('2×$100 entry sizing and wave_b exit stamp', () => {
    const cfg = loadPaperTraderConfig();
    expect(runnerLiteOpenLegUsd(cfg)).toBe(100);
    expect(runnerLiteMaxPositionUsd(cfg)).toBe(200);
    const ot = {
      mint: 'mintA',
      positionSource: RUNNER_LITE_POSITION_SOURCE,
      legs: [{ sizeUsd: 100 } as OpenTrade['legs'][0]],
      totalInvestedUsd: 100,
    } as OpenTrade;
    stampRunnerLiteExitPolicyOnOpen(ot, cfg);
    expect(ot.liveExitPolicyId).toBe('runner_lite_v1');
    expect(ot.liveWaveFlatTpMode).toBe('half8_runner');
    expect(isRunnerLiteExitPolicy(ot)).toBe(true);
  });

  it('cross-lane open map prevents double-buy on same mint', () => {
    const open = new Map<string, OpenTrade>();
    open.set(runnerLiteOpenMapKey('mintA'), {
      mint: 'mintA',
      positionSource: RUNNER_LITE_POSITION_SOURCE,
    } as OpenTrade);
    expect(runnerProbeMintOpenSkipReason({ open, mint: 'mintA' })).toBe('runner_lite_blocks_runner_probe');
    open.clear();
    open.set('mintA::runner_probe', {
      mint: 'mintA',
      positionSource: RUNNER_PROBE_POSITION_SOURCE,
    } as OpenTrade);
    expect(runnerLiteMintOpenSkipReason({ open, mint: 'mintA' })).toBe('runner_probe_blocks_runner_lite');
  });

  it('composite open-map key and exposure accounting', () => {
    const open = new Map<string, OpenTrade>();
    const ot = {
      mint: 'mintA',
      positionSource: RUNNER_LITE_POSITION_SOURCE,
      totalInvestedUsd: 200,
      legs: [{ sizeUsd: 100 }, { sizeUsd: 100 }],
    } as OpenTrade;
    stampRunnerLiteOnOpen(ot);
    open.set(resolveOpenMapKey(ot), ot);
    expect(open.has('mintA')).toBe(false);
    expect(runnerLiteMintAlreadyOpen(open, 'mintA')).toBe(true);
    expect(countOpenRunnerLitePositions(open)).toBe(1);
    expect(sumRunnerLiteExposureUsd(open)).toBe(200);
    expect(normalizeRunnerLiteOpenMapKeys(open)).toBe(0);
  });

  it('tier2 fallback when probe in-band but not fully passed', () => {
    const cfg = loadPaperTraderConfig();
    expect(
      resolveRunnerLiteTier(cfg, 1_200_000, 1500, { inBand: true, fullyPassed: false }).tier,
    ).toBe('tier2');
    expect(
      resolveRunnerLiteTier(cfg, 1_200_000, 1500, { inBand: true, fullyPassed: true }).reasons,
    ).toContain('runner_lite_skipped_probe_full_pass');
    expect(runnerLiteDiscoveryPrefilter(cfg, 1_200_000, 1500)).toBe(true);
    expect(runnerLiteTier2McapInBand(cfg, 1_200_000)).toBe(true);
  });

  it('rejects tier2 without probe in-band outcome', () => {
    const cfg = loadPaperTraderConfig();
    const row = {
      mint: 'x',
      symbol: 'X',
      price_usd: 1,
      liquidity_usd: 100_000,
      volume_1h: 100_000,
      volume_5m: 10_000,
      market_cap_usd: 1_500_000,
      token_age_min: 1500,
      age_min: 1500,
      buys_5m: 10,
      sells_5m: 5,
      holder_count: 100,
      source: 'pumpswap',
    } as SnapshotCandidateRow;
    const eval1 = evaluateLiveOscarRunnerLiteDiscovery({
      cfg,
      row,
      lane: 'post_migration',
      refMcap: 1_500_000,
      ageMin: 1500,
      dipCtx: undefined,
      runnerCtx: {
        vol1hUsd: 200_000,
        vol12hUsd: 500_000,
        coverageOk: true,
        pgSamples24h: 48,
      } as RunnerWindowFeatures,
      probeOutcome: { inBand: false, fullyPassed: false },
    });
    expect(eval1.pass).toBe(false);
    expect(eval1.reasons.some((r) => r.includes('runner_lite_tier2_requires'))).toBe(true);
  });

  it('ranking score favors vol1h × velocity', () => {
    const low = { vol1hUsd: 80_000, vol1hVelocity: 1 } as RunnerWindowFeatures;
    const high = { vol1hUsd: 80_000, vol1hVelocity: 2.5 } as RunnerWindowFeatures;
    expect(runnerLiteRankScore(high)).toBeGreaterThan(runnerLiteRankScore(low));
  });

  it('age band 12h–48h', () => {
    const cfg = loadPaperTraderConfig();
    expect(runnerLiteAgeInBand(cfg, 719)).toBe(false);
    expect(runnerLiteAgeInBand(cfg, 720)).toBe(true);
    expect(runnerLiteAgeInBand(cfg, 2880)).toBe(true);
    expect(runnerLiteAgeInBand(cfg, 2881)).toBe(false);
  });

  it('identifies runner_lite trade markers', () => {
    expect(isRunnerLiteTrade({ liveExitPolicyId: 'runner_lite_v1' } as OpenTrade)).toBe(true);
    expect(runnerProbeMintAlreadyOpen(new Map(), 'mintZ')).toBe(false);
  });
});
