import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateLiveOscarFastDipScalpDiscovery,
  isFastDipScalpEligibleSource,
  liveOscarFastDipScalpAgeMeetsMin,
  liveOscarFastDipScalpEntryConfig,
  parseFastDipScalpTpLadder,
  resolveLiveOscarFastDipScalpInMcapBand,
} from '../src/papertrader/live-oscar-fast-dip-scalp.js';
import {
  fastDipScalpEffectiveExitParams,
  isFastDipScalpExitPolicy,
  stampFastDipScalpExitPolicyOnOpen,
} from '../src/papertrader/executor/exit-policy-fast-dip-scalp.js';
import { resolveLiveOscarTradeLaneFromOpen } from '../src/papertrader/live-oscar-scalp-wave.js';
import type { DipContextByWindows } from '../src/papertrader/dip-detector.js';
import type { OpenTrade, SnapshotCandidateRow } from '../src/papertrader/types.js';

function row(overrides: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'm1', symbol: 'T', ts: new Date(), launch_ts: null, source: 'pumpswap',
    age_min: 200, price_usd: 0.07, liquidity_usd: 50_000, volume_5m: 3000, volume_1h: 200_000,
    buys_5m: 20, sells_5m: 15, holder_count: 5000, token_age_min: 200, market_cap_usd: 5e6,
    pair_address: null, ...overrides,
  };
}

describe('live-oscar-fast-dip-scalp', () => {
  const envBackup: Record<string, string | undefined> = {};
  const KEYS = [
    'PAPER_STRATEGY_ID', 'PAPER_MIN_TOKEN_AGE_MIN',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_LANE_ENABLED',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_WINDOW_MIN',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_MIN_DROP_PCT',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_MCAP_USD',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MAX_MCAP_USD',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_AGE_MIN',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_KILL_PCT',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TIME_STOP_MIN',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_RUNGS_PCT',
    'PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_SELL_FRACS',
  ];

  beforeEach(() => {
    for (const k of KEYS) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_MIN_TOKEN_AGE_MIN = '60';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_WINDOW_MIN = '15';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_MIN_DROP_PCT = '-25';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_MCAP_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MAX_MCAP_USD = '1000000000';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_AGE_MIN = '60';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_KILL_PCT = '0.15';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TIME_STOP_MIN = '30';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_RUNGS_PCT = '0.10,0.22';
    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_SELL_FRACS = '0.50,0.30';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('parses env flags and short dip window into aggregation', () => {
    const cfg = loadPaperTraderConfig();
    expect(cfg.liveOscarFastDipScalpLaneEnabled).toBe(true);
    expect(cfg.liveOscarFastDipScalpDipWindowMin).toBe(15);
    expect(cfg.dipAggregationWindowsMin).toContain(15);
  });

  it('mcap band + age gates', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarFastDipScalpInMcapBand(cfg, 2_999_999)).toBe(false);
    expect(resolveLiveOscarFastDipScalpInMcapBand(cfg, 3_000_000)).toBe(true);
    expect(liveOscarFastDipScalpAgeMeetsMin(cfg, 59)).toBe(false);
    expect(liveOscarFastDipScalpAgeMeetsMin(cfg, 60)).toBe(true);
  });

  it('only pumpswap source is eligible', () => {
    expect(isFastDipScalpEligibleSource('pumpswap')).toBe(true);
    expect(isFastDipScalpEligibleSource('raydium')).toBe(false);
    expect(isFastDipScalpEligibleSource(undefined)).toBe(false);
  });

  it('entry config overlays deep-flush dip thresholds', () => {
    const cfg = loadPaperTraderConfig();
    const eff = liveOscarFastDipScalpEntryConfig(cfg);
    expect(eff.dipMinDropPct).toBe(-25);
    expect(eff.dipMinAgeMin).toBe(60);
    expect(eff.positionUsd).toBe(cfg.liveOscarFastDipScalpPositionUsd);
  });

  it('parses TP ladder and caps remainder', () => {
    const cfg = loadPaperTraderConfig();
    const ladder = parseFastDipScalpTpLadder(cfg);
    expect(ladder).toEqual([
      { gainFrac: 0.1, sellFrac: 0.5 },
      { gainFrac: 0.22, sellFrac: 0.3 },
    ]);
  });

  it('discovery rejects when disabled / wrong source / mcap outside', () => {
    const cfg = loadPaperTraderConfig();
    const dipCtx: DipContextByWindows = new Map([[15, { high_px: 0.1, low_px: 0.06 }]]);
    const base = { cfg, lane: 'post_migration' as const, ageMin: 200, dipCtx };

    process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_LANE_ENABLED = '0';
    const disabledCfg = loadPaperTraderConfig();
    expect(
      evaluateLiveOscarFastDipScalpDiscovery({ ...base, cfg: disabledCfg, row: row(), refMcap: 5e6 }).reasons,
    ).toContain('fast_dip_scalp_lane_disabled');

    const wrongSrc = evaluateLiveOscarFastDipScalpDiscovery({ ...base, row: row({ source: 'raydium' }), refMcap: 5e6 });
    expect(wrongSrc.reasons).toContain('fast_dip_scalp_source_not_pumpswap');

    const lowMcap = evaluateLiveOscarFastDipScalpDiscovery({ ...base, row: row(), refMcap: 1e6 });
    expect(lowMcap.pass).toBe(false);
    expect(lowMcap.reasons.some((r) => r.startsWith('fast_dip_scalp_mcap_outside'))).toBe(true);
  });

  it('exit policy stamps fast_dip_scalp_v1 with real SL and time-stop', () => {
    const cfg = loadPaperTraderConfig();
    const ot = { liveOscarTradeLane: 'fast_dip_scalp' } as unknown as OpenTrade;
    expect(resolveLiveOscarTradeLaneFromOpen(ot)).toBe('fast_dip_scalp');
    expect(stampFastDipScalpExitPolicyOnOpen(ot, cfg)).toBe(true);
    expect(ot.liveExitPolicyId).toBe('fast_dip_scalp_v1');
    expect(ot.tpGridOverrides?.dcaKillstop).toBeCloseTo(-0.15, 5);
    expect(isFastDipScalpExitPolicy(ot)).toBe(true);

    const eff = fastDipScalpEffectiveExitParams(cfg);
    expect(eff.dcaKillstop).toBeCloseTo(-0.15, 5);
    expect(eff.timeoutHours).toBeCloseTo(0.5, 5);
    expect(eff.tpX).toBeCloseTo(1.1, 5);
  });
});
