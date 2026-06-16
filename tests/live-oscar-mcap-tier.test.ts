import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  liveOscarBelowMcapThresholdUsd,
  liveOscarTierDcaLevelsSpec,
  liveOscarTierEntryConfig,
  liveOscarTierPositionUsd,
  liveOscarTierStagedSplitLegUsd,
  resolveLiveOscarMcapTier,
} from '../src/papertrader/live-oscar-mcap-tier.js';

describe('live-oscar-mcap-tier', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = [
      'PAPER_STRATEGY_ID',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_DIP_MIN_DROP_PCT',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_DCA_LEVELS',
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT',
      'PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS',
      'PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT',
      'PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD',
      'PAPER_DIP_MIN_DROP_PCT',
      'PAPER_VOL_1H_MIN_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD',
      'PAPER_DCA_LEVELS',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD = '500000';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD = '1300000';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_DIP_MIN_DROP_PCT = '-30';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD = '75000';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD = '300';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD = '600';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_DCA_LEVELS = '';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD = '1300000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT = '-30';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD = '75000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '730';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '1460';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS = '-10:0.375,-20:0.375';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT = '-18';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD = '25000';
    process.env.PAPER_DIP_MIN_DROP_PCT = '-20';
    process.env.PAPER_VOL_1H_MIN_USD = '36000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '730';
    process.env.PAPER_DCA_LEVELS = '-10:0.266667,-20:0.266667';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves tiers at boundaries with micro lane', () => {
    const cfg = loadPaperTraderConfig();
    expect(liveOscarBelowMcapThresholdUsd(cfg)).toBe(500_000);
    expect(resolveLiveOscarMcapTier(cfg, 400_000)).toBe('below');
    expect(resolveLiveOscarMcapTier(cfg, 499_999)).toBe('below');
    expect(resolveLiveOscarMcapTier(cfg, 500_000)).toBe('micro');
    expect(resolveLiveOscarMcapTier(cfg, 800_000)).toBe('micro');
    expect(resolveLiveOscarMcapTier(cfg, 1_299_999)).toBe('micro');
    expect(resolveLiveOscarMcapTier(cfg, 1_300_000)).toBe('low');
    expect(resolveLiveOscarMcapTier(cfg, 2_999_999)).toBe('low');
    expect(resolveLiveOscarMcapTier(cfg, 3_000_000)).toBe('prod');
    expect(resolveLiveOscarMcapTier(cfg, 3_000_001)).toBe('prod');
  });

  it('overrides entry thresholds per tier (micro vs low vs prod)', () => {
    const cfg = loadPaperTraderConfig();
    const micro = liveOscarTierEntryConfig(cfg, 'micro');
    expect(micro.dipMinDropPct).toBe(-30);
    expect(micro.vol1hMinUsd).toBe(75_000);
    const low = liveOscarTierEntryConfig(cfg, 'low');
    expect(low.dipMinDropPct).toBe(-30);
    expect(low.vol1hMinUsd).toBe(75_000);
    const prod = liveOscarTierEntryConfig(cfg, 'prod');
    expect(prod.dipMinDropPct).toBe(-18);
    expect(prod.vol1hMinUsd).toBe(25_000);
  });

  it('uses tier-specific split leg and position sizing', () => {
    const cfg = loadPaperTraderConfig();
    expect(liveOscarTierStagedSplitLegUsd(cfg, 'micro')).toBe(300);
    expect(liveOscarTierPositionUsd(cfg, 'micro')).toBe(600);
    expect(liveOscarTierStagedSplitLegUsd(cfg, 'low')).toBe(730);
    expect(liveOscarTierPositionUsd(cfg, 'low')).toBe(1460);
    expect(liveOscarTierStagedSplitLegUsd(cfg, 'prod')).toBe(730);
    expect(liveOscarTierDcaLevelsSpec(cfg, 'low')).toBe('-10:0.375,-20:0.375');
    expect(liveOscarTierDcaLevelsSpec(cfg, 'micro')).toBe('');
  });
});
