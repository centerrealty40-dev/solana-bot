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
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT',
      'PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS',
      'PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT',
      'PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD',
      'PAPER_DCA_LEVELS',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED = '0';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD = '2000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT = '-30';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD = '60000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '250';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD = '250';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG3_USD = '250';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '900';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS = '';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT = '-18';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD = '100000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '300';
    process.env.PAPER_DCA_LEVELS = '-10:0.266667,-20:0.266667';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves tiers at boundaries with $2M floor', () => {
    const cfg = loadPaperTraderConfig();
    expect(liveOscarBelowMcapThresholdUsd(cfg)).toBe(2_000_000);
    expect(resolveLiveOscarMcapTier(cfg, 1_999_999)).toBe('below');
    expect(resolveLiveOscarMcapTier(cfg, 2_000_000)).toBe('low');
    expect(resolveLiveOscarMcapTier(cfg, 2_500_000)).toBe('low');
    expect(resolveLiveOscarMcapTier(cfg, 2_999_999)).toBe('low');
    expect(resolveLiveOscarMcapTier(cfg, 3_000_000)).toBe('prod');
  });

  it('overrides entry thresholds per tier (low vs prod)', () => {
    const cfg = loadPaperTraderConfig();
    const low = liveOscarTierEntryConfig(cfg, 'low');
    expect(low.dipMinDropPct).toBe(-30);
    expect(low.vol1hMinUsd).toBe(60_000);
    const prod = liveOscarTierEntryConfig(cfg, 'prod');
    expect(prod.dipMinDropPct).toBe(-18);
    expect(prod.vol1hMinUsd).toBe(100_000);
  });

  it('defaults prod vol1h to $100k when env unset', () => {
    delete process.env.PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD;
    const cfg = loadPaperTraderConfig();
    expect(liveOscarTierEntryConfig(cfg, 'prod').vol1hMinUsd).toBe(100_000);
  });

  it('uses tier-specific split leg and position sizing', () => {
    const cfg = loadPaperTraderConfig();
    expect(liveOscarTierStagedSplitLegUsd(cfg, 'low')).toBe(250);
    expect(liveOscarTierPositionUsd(cfg, 'low')).toBe(900);
    expect(liveOscarTierStagedSplitLegUsd(cfg, 'prod')).toBe(300);
    expect(liveOscarTierDcaLevelsSpec(cfg, 'low')).toBe('');
  });

  it('resolves scalp_wave tier sizing when lane enabled', () => {
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_POSITION_USD = '300';
    const cfg = loadPaperTraderConfig();
    expect(liveOscarTierStagedSplitLegUsd(cfg, 'scalp_wave')).toBe(300);
    expect(liveOscarTierPositionUsd(cfg, 'scalp_wave')).toBe(300);
    expect(liveOscarTierDcaLevelsSpec(cfg, 'scalp_wave')).toBe('');
  });
});
