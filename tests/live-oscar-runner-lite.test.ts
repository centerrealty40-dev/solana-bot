import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig, parseDcaLevels } from '../src/papertrader/config.js';
import {
  attachRunnerLitePendingScaleIn,
  countOpenRunnerLitePositions,
  evaluateLiveOscarRunnerLiteDiscovery,
  isRunnerLiteTrade,
  normalizeRunnerLiteOpenMapKeys,
  resolveOpenMapKey,
  runnerLiteAgeInBand,
  runnerLiteCandidateInBand,
  runnerLiteMcapInBand,
  runnerLiteMintAlreadyOpen,
  runnerLiteMintOpenSkipReason,
  runnerLiteOpenLegUsd,
  runnerLiteOpenMapKey,
  runnerLiteRankScore,
  RUNNER_LITE_POSITION_SOURCE,
  runnerProbeMintAlreadyOpen,
  stampRunnerLiteOnOpen,
  sumRunnerLiteExposureUsd,
} from '../src/papertrader/live-oscar-runner-lite.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  runnerProbeCandidateInBand,
  runnerProbeMintOpenSkipReason,
  RUNNER_PROBE_POSITION_SOURCE,
} from '../src/papertrader/live-oscar-runner-probe.js';
import {
  isRunnerLiteExitPolicy,
  runnerLiteDcaLevelsSpec,
  runnerLiteMaxPositionUsd,
  stampRunnerLiteExitPolicyOnOpen,
} from '../src/papertrader/executor/exit-policy-runner-lite.js';
import { dcaCrossedDownward } from '../src/papertrader/executor/dca-state.js';
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
      'PAPER_RUNNER_LITE_DCA_LEVELS',
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
    process.env.PAPER_RUNNER_LITE_DCA_LEVELS = '-25:0.333';
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

  it('2×$100 entry sizing, −25% DCA +⅓ max, and wave_b exit stamp', () => {
    const cfg = loadPaperTraderConfig();
    expect(runnerLiteOpenLegUsd(cfg)).toBe(100);
    expect(runnerLiteMaxPositionUsd(cfg)).toBeCloseTo(266.6, 0);
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

  it('−25% drop triggers one DCA add of ⅓ positionUsd', () => {
    const cfg = loadPaperTraderConfig();
    const levels = parseDcaLevels(runnerLiteDcaLevelsSpec(cfg));
    expect(levels).toHaveLength(1);
    expect(levels[0]!.triggerPct).toBeCloseTo(-0.25);
    expect(levels[0]!.addFraction).toBeCloseTo(0.333, 3);
    const addUsd = cfg.runnerLitePositionUsd * levels[0]!.addFraction;
    expect(addUsd).toBeCloseTo(66.6, 0);
    expect(dcaCrossedDownward(Number.POSITIVE_INFINITY, -0.26, levels[0]!.triggerPct)).toBe(true);
    expect(dcaCrossedDownward(-0.2, -0.22, levels[0]!.triggerPct)).toBe(false);
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

  it('does not apply prod discoveryMinMarketCapUsd ($2M) to tier-2 lite fallback', () => {
    const cfg = loadPaperTraderConfig();
    const row = {
      mint: 'cgp3',
      symbol: 'CGp3',
      price_usd: 0.001028,
      liquidity_usd: 87_000,
      volume_1h: 180_000,
      volume_5m: 9_771,
      market_cap_usd: 1_028_380,
      token_age_min: 1355,
      age_min: 1355,
      buys_5m: 10,
      sells_5m: 5,
      holder_count: 100,
      source: 'pumpswap',
    } as SnapshotCandidateRow;
    const runnerCtx = {
      vol1hUsd: 180_305,
      vol12hUsd: 500_000,
      vol5mPeak1hUsd: 15_000,
      vol1hVelocity: 1.2,
      bs1h: 1.0,
      bs12h: 0.95,
      coverageOk: true,
      pgSamples24h: 48,
      mcapNowUsd: 1_028_380,
      liqNowUsd: 87_000,
      priceNowUsd: 0.001028,
      priceMax24hUsd: 0.0014,
      vol1hAvg24hUsd: 100_000,
      liqP25_24hUsd: 80_000,
    } as RunnerWindowFeatures;
    const evalRes = evaluateLiveOscarRunnerLiteDiscovery({
      cfg,
      row,
      lane: 'post_migration',
      refMcap: 1_028_380,
      ageMin: 1355,
      dipCtx: undefined,
      runnerCtx,
      probeOutcome: { inBand: true, fullyPassed: false },
    });
    expect(evalRes.tier).toBe('tier2');
    expect(evalRes.reasons).not.toContain('mcap<2000000');
    expect(evalRes.reasons.some((r) => r.startsWith('runner_lite_runner_mcap>'))).toBe(false);
  });

  it('rejects mcap ≥ $1M in discovery eval (probe band only)', () => {
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
    });
    expect(eval1.pass).toBe(false);
    expect(
      eval1.reasons.some(
        (r) => r.includes('runner_lite_tier2_requires_probe_band') || r.includes('runner_lite_mcap_outside'),
      ),
    ).toBe(true);
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

  it('always attaches pending scale-in for 2×$100 (ignores LIVE_ENTRY_SCALE_IN_ENABLED=0)', () => {
    const cfg = loadPaperTraderConfig();
    process.env.LIVE_ENTRY_SCALE_IN_ENABLED = '0';
    process.env.LIVE_ENTRY_SCALE_IN_DELAY_MS = '5000';
    const ot: OpenTrade = {
      mint: 'mintLite',
      legs: [{ ts: Date.now(), price: 1, marketPrice: 1, sizeUsd: 100, reason: 'open' }],
    } as OpenTrade;
    attachRunnerLitePendingScaleIn(ot, cfg, 1, {
      delayMs: 5000,
      corridorUpPct: 1,
      corridorDownPct: 2,
      maxSwapAttempts: 8,
    });
    expect(ot.livePendingScaleIn).toMatchObject({
      secondLegUsd: 100,
      corridorUpPct: 1,
      corridorDownPct: 2,
      maxSwapAttempts: 8,
    });
    expect(ot.livePendingScaleIn!.executeAfterTs).toBeGreaterThan(Date.now() - 100);
  });
});
