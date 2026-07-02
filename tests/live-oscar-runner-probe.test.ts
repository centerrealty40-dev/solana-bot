import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  countOpenRunnerProbePositions,
  evaluateLiveOscarRunnerProbeDiscovery,
  isRunnerProbeTrade,
  normalizeRunnerProbeOpenMapKeys,
  resolveOpenMapKey,
  runnerProbeAgeInBand,
  runnerProbeMintAlreadyOpen,
  runnerProbeMintOpenSkipReason,
  runnerProbeOpenMapKey,
  runnerProbeOpenLegUsd,
  runnerProbeRankScore,
  RUNNER_PROBE_POSITION_SOURCE,
  stampRunnerProbeOnOpen,
  sumRunnerProbeExposureUsd,
  mintFromOpenMapKey,
} from '../src/papertrader/live-oscar-runner-probe.js';
import {
  isRunnerProbeExitPolicy,
  runnerProbeEffectiveExitParams,
  runnerProbeEffectiveKillFrac,
  runnerProbeKillEligible,
  runnerProbeMaxPositionUsd,
  runnerProbeResetPeakAfterDca,
  runnerProbeTpEligible,
  stampRunnerProbeExitPolicyOnOpen,
} from '../src/papertrader/executor/exit-policy-runner-probe.js';
import { cfgEffectiveForOpen } from '../src/papertrader/cfg-effective-for-open.js';
import type { OpenTrade, SnapshotCandidateRow } from '../src/papertrader/types.js';
import type { RunnerWindowFeatures } from '../src/papertrader/discovery/runner-mode.js';

describe('live-oscar-runner-probe', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = [
      'PAPER_STRATEGY_ID',
      'PAPER_RUNNER_PROBE_ENABLED',
      'PAPER_RUNNER_PROBE_MIN_AGE_MIN',
      'PAPER_RUNNER_PROBE_MAX_AGE_MIN',
      'PAPER_RUNNER_PROBE_POSITION_USD',
      'PAPER_RUNNER_PROBE_MAX_CONCURRENT',
      'PAPER_RUNNER_PROBE_MAX_EXPOSURE_USD',
      'PAPER_RUNNER_PROBE_TP_PCT',
      'PAPER_RUNNER_PROBE_KILL_PCT',
      'PAPER_RUNNER_PROBE_DCA_LEVELS',
      'PAPER_RUNNER_PROBE_TIME_STOP_HOURS',
      'PAPER_RUNNER_PROBE_MIN_MCAP_USD',
      'PAPER_RUNNER_PROBE_MAX_MCAP_USD',
      'LIVE_OSCAR_INTEL_ENABLED',
      'LIVE_OSCAR_INTEL_MODE',
      'LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_RUNNER_PROBE_ENABLED = '1';
    process.env.PAPER_RUNNER_PROBE_MIN_AGE_MIN = '720';
    process.env.PAPER_RUNNER_PROBE_MAX_AGE_MIN = '2880';
    process.env.PAPER_RUNNER_PROBE_POSITION_USD = '500';
    process.env.PAPER_RUNNER_PROBE_MAX_CONCURRENT = '2';
    process.env.PAPER_RUNNER_PROBE_MAX_EXPOSURE_USD = '2000';
    process.env.PAPER_RUNNER_PROBE_TP_PCT = '0.10';
    process.env.PAPER_RUNNER_PROBE_KILL_PCT = '0.50';
    process.env.PAPER_RUNNER_PROBE_DCA_LEVELS = '-25:1';
    process.env.PAPER_RUNNER_PROBE_TIME_STOP_HOURS = '6';
    process.env.PAPER_RUNNER_PROBE_MIN_MCAP_USD = '1000000';
    process.env.PAPER_RUNNER_PROBE_MAX_MCAP_USD = '30000000';
    process.env.LIVE_OSCAR_INTEL_ENABLED = '0';
    process.env.LIVE_OSCAR_INTEL_MODE = 'off';
    process.env.LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED = '0';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('age band 12h–48h and $500 one-shot sizing', () => {
    const cfg = loadPaperTraderConfig();
    expect(runnerProbeAgeInBand(cfg, 719)).toBe(false);
    expect(runnerProbeAgeInBand(cfg, 720)).toBe(true);
    expect(runnerProbeAgeInBand(cfg, 1500)).toBe(true);
    expect(runnerProbeAgeInBand(cfg, 2880)).toBe(true);
    expect(runnerProbeAgeInBand(cfg, 2881)).toBe(false);
    expect(runnerProbeOpenLegUsd(cfg)).toBe(500);
  });

  it('ranking score favors vol1h × velocity', () => {
    const low: RunnerWindowFeatures = {
      vol1hUsd: 100_000,
      vol1hVelocity: 1,
    } as RunnerWindowFeatures;
    const high: RunnerWindowFeatures = {
      vol1hUsd: 100_000,
      vol1hVelocity: 2,
    } as RunnerWindowFeatures;
    expect(runnerProbeRankScore(high)).toBeGreaterThan(runnerProbeRankScore(low));
  });

  it('max 2 concurrent runner_probe positions counted', () => {
    const open = new Map<string, OpenTrade>();
    open.set(runnerProbeOpenMapKey('mintA'), {
      mint: 'mintA',
      positionSource: RUNNER_PROBE_POSITION_SOURCE,
      totalInvestedUsd: 500,
      legs: [{ sizeUsd: 500 } as OpenTrade['legs'][0]],
    } as OpenTrade);
    open.set(runnerProbeOpenMapKey('mintB'), {
      mint: 'mintB',
      positionSource: RUNNER_PROBE_POSITION_SOURCE,
      totalInvestedUsd: 500,
      legs: [{ sizeUsd: 500 } as OpenTrade['legs'][0]],
    } as OpenTrade);
    expect(countOpenRunnerProbePositions(open)).toBe(2);
    expect(sumRunnerProbeExposureUsd(open)).toBe(1000);
  });

  it('does not block prod open when runner_probe occupies composite key', () => {
    const open = new Map<string, OpenTrade>();
    open.set(runnerProbeOpenMapKey('mintA'), {
      mint: 'mintA',
      positionSource: RUNNER_PROBE_POSITION_SOURCE,
    } as OpenTrade);
    expect(open.has('mintA')).toBe(false);
    expect(runnerProbeMintOpenSkipReason({ open, mint: 'mintA' })).toBe('runner_probe_already_open');
    expect(runnerProbeMintOpenSkipReason({ open, mint: 'mintB' })).toBe(null);
  });

  it('prod open on mint blocks second runner_probe', () => {
    const open = new Map<string, OpenTrade>();
    open.set('mintA', { mint: 'mintA', liveOscarTradeLane: 'prod' } as OpenTrade);
    expect(runnerProbeMintOpenSkipReason({ open, mint: 'mintA' })).toBe('prod_blocks_runner_probe');
  });

  it('rejects age outside band in discovery eval', () => {
    const cfg = loadPaperTraderConfig();
    const row = {
      mint: 'mintX',
      symbol: 'X',
      age_min: 600,
      token_age_min: 600,
      price_usd: 1,
      liquidity_usd: 200_000,
      volume_5m: 50_000,
      volume_1h: 100_000,
      market_cap_usd: 2_000_000,
      buys_5m: 10,
      sells_5m: 5,
      holder_count: 100,
      source: 'raydium',
    } as SnapshotCandidateRow;
    const evalRes = evaluateLiveOscarRunnerProbeDiscovery({
      cfg,
      row,
      lane: 'post_migration',
      refMcap: 2_000_000,
      ageMin: 600,
      dipCtx: undefined,
      runnerCtx: undefined,
    });
    expect(evalRes.pass).toBe(false);
    expect(evalRes.reasons.some((r) => r.includes('runner_probe_age_outside'))).toBe(true);
  });

  it('mintFromOpenMapKey strips runner_probe composite suffix', () => {
    const bare = 'mintA';
    expect(mintFromOpenMapKey(bare)).toBe(bare);
    expect(mintFromOpenMapKey(runnerProbeOpenMapKey(bare))).toBe(bare);
  });

  it('resolveOpenMapKey uses liveOscarTradeLane when positionSource missing', () => {
    const ot = { mint: 'mintA', liveOscarTradeLane: 'runner_probe' } as OpenTrade;
    expect(resolveOpenMapKey(ot)).toBe(runnerProbeOpenMapKey('mintA'));
  });

  it('normalizeRunnerProbeOpenMapKeys migrates bare replay key to composite', () => {
    const ot = {
      mint: 'mintA',
      liveOscarTradeLane: 'runner_probe',
      liveExitPolicyId: 'runner_probe_v1',
    } as OpenTrade;
    const open = new Map<string, OpenTrade>([['mintA', ot]]);
    expect(normalizeRunnerProbeOpenMapKeys(open)).toBe(1);
    expect(open.has('mintA')).toBe(false);
    expect(open.has(runnerProbeOpenMapKey('mintA'))).toBe(true);
    expect(open.get(runnerProbeOpenMapKey('mintA'))?.positionSource).toBe(RUNNER_PROBE_POSITION_SOURCE);
  });

  it('runnerProbeMintAlreadyOpen detects bare replay key', () => {
    const open = new Map<string, OpenTrade>([
      ['mintA', { mint: 'mintA', liveOscarTradeLane: 'runner_probe' } as OpenTrade],
    ]);
    expect(runnerProbeMintAlreadyOpen(open, 'mintA')).toBe(true);
  });

  it('stamps runner_probe_v1 exit policy with negative kill and effective params', () => {
    const cfg = loadPaperTraderConfig();
    const ot = { mint: 'm1', liveOscarTradeLane: 'runner_probe', avgEntry: 1 } as OpenTrade;
    stampRunnerProbeOnOpen(ot);
    expect(stampRunnerProbeExitPolicyOnOpen(ot, cfg)).toBe(true);
    expect(isRunnerProbeExitPolicy(ot)).toBe(true);
    expect(isRunnerProbeTrade(ot)).toBe(true);
    expect(resolveOpenMapKey(ot)).toBe(runnerProbeOpenMapKey('m1'));
    expect(ot.tpGridOverrides?.dcaKillstop).toBe(-0.5);
    const eff = cfgEffectiveForOpen(cfg, ot);
    expect(eff.tpX).toBeCloseTo(1.1);
    expect(eff.dcaKillstop).toBe(-0.5);
    expect(eff.timeoutHours).toBe(6);
    expect(runnerProbeMaxPositionUsd(cfg)).toBe(1000);
  });

  it('kill uses PG floor when Jupiter MTM is optimistic', () => {
    const cfg = loadPaperTraderConfig();
    const ot = {
      mint: 'm1',
      liveExitPolicyId: 'runner_probe_v1',
      avgEntry: 1,
    } as OpenTrade;
    expect(runnerProbeKillEligible(ot, 0.88, 0.48, cfg)).toBe(true);
    expect(runnerProbeKillEligible(ot, 0.88, 0.55, cfg)).toBe(false);
  });

  it('TP triggers from tracked peak even when current tick is below tpX', () => {
    const cfg = loadPaperTraderConfig();
    const ot = {
      mint: 'm1',
      liveExitPolicyId: 'runner_probe_v1',
      avgEntry: 1,
      peakMcUsd: 1.12,
      peakPnlPct: 12,
    } as OpenTrade;
    expect(runnerProbeTpEligible(ot, 1.05, 1.05, cfg)).toBe(true);
    expect(runnerProbeEffectiveKillFrac(cfg)).toBe(-0.5);
  });

  it('does not phantom-TP after DCA when pre-DCA peak exceeds new avgEntry', () => {
    const cfg = loadPaperTraderConfig();
    const ot = {
      mint: 'm1',
      liveExitPolicyId: 'runner_probe_v1',
      avgEntry: 0.0018177951694850678,
      peakMcUsd: 0.0021334969336829785,
      peakPnlPct: -18.02,
    } as OpenTrade;
    expect(runnerProbeTpEligible(ot, 0.0014901720290547192, 0.0014901720290547192, cfg)).toBe(true);
    runnerProbeResetPeakAfterDca(ot, 0.0014901720290547192);
    expect(runnerProbeTpEligible(ot, 0.0014901720290547192, 0.0014901720290547192, cfg)).toBe(false);
    expect(ot.peakMcUsd).toBeCloseTo(0.0014901720290547192);
    expect(ot.peakPnlPct).toBeCloseTo(-18.02, 1);
  });
});
