import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  liveOscarScalpWaveAgeMeetsMin,
  liveOscarMintOpenSkipReason,
  liveOscarScalpWaveEntryConfig,
  resolveLiveOscarScalpWaveMcapTier,
  resolveLiveOscarTradeLaneFromOpen,
} from '../src/papertrader/live-oscar-scalp-wave.js';
import {
  isScalpWaveExitPolicy,
  scalpWaveEffectiveExitParams,
  stampScalpWaveExitPolicyOnOpen,
} from '../src/papertrader/executor/exit-policy-scalp-wave.js';
import type { OpenTrade } from '../src/papertrader/types.js';

describe('live-oscar-scalp-wave', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = [
      'PAPER_STRATEGY_ID',
      'PAPER_MIN_TOKEN_AGE_MIN',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_AGE_MIN',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_MCAP_USD',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MIN_DROP_PCT',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MAX_DROP_PCT',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_POSITION_USD',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_TP_PCT',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_KILL_PCT',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_TIME_STOP_HOURS',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_MIN_TOKEN_AGE_MIN = '2160';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_AGE_MIN = '720';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_MCAP_USD = '800000';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD = '2000000';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MIN_DROP_PCT = '-15';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MAX_DROP_PCT = '-8';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_POSITION_USD = '300';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_TP_PCT = '0.1';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_KILL_PCT = '0.1';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_TIME_STOP_HOURS = '3';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves scalp_wave mcap corridor and min age (no max cap)', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarScalpWaveMcapTier(cfg, 750_000)).toBe('below');
    expect(resolveLiveOscarScalpWaveMcapTier(cfg, 800_000)).toBe('scalp_wave');
    expect(resolveLiveOscarScalpWaveMcapTier(cfg, 1_500_000)).toBe('scalp_wave');
    expect(resolveLiveOscarScalpWaveMcapTier(cfg, 2_000_000)).toBe('scalp_wave');
    expect(resolveLiveOscarScalpWaveMcapTier(cfg, 2_000_001)).toBe('below');
    expect(liveOscarScalpWaveAgeMeetsMin(cfg, 719)).toBe(false);
    expect(liveOscarScalpWaveAgeMeetsMin(cfg, 720)).toBe(true);
    expect(liveOscarScalpWaveAgeMeetsMin(cfg, 1500)).toBe(true);
    expect(liveOscarScalpWaveAgeMeetsMin(cfg, 2160)).toBe(true);
    expect(liveOscarScalpWaveAgeMeetsMin(cfg, 10_000)).toBe(true);
  });

  it('uses shallow dip entry config, one-shot $300, scalp min age not global 36h', () => {
    const cfg = loadPaperTraderConfig();
    const scalpCfg = liveOscarScalpWaveEntryConfig(cfg);
    expect(scalpCfg.dipMinDropPct).toBe(-15);
    expect(scalpCfg.dipMaxDropPct).toBe(-8);
    expect(scalpCfg.positionUsd).toBe(300);
    expect(scalpCfg.dipMinAgeMin).toBe(720);
    expect(scalpCfg.globalMinTokenAgeMin).toBe(720);
    expect(cfg.globalMinTokenAgeMin).toBeGreaterThanOrEqual(2160);
  });

  it('mutex: different trade lane on same mint → lane_mint_mutex', () => {
    const open = new Map<string, OpenTrade>();
    open.set('mintA', {
      liveOscarTradeLane: 'scalp_wave',
    } as OpenTrade);
    expect(
      liveOscarMintOpenSkipReason({
        open,
        mint: 'mintA',
        incomingTradeLane: 'prod',
      }),
    ).toBe('lane_mint_mutex');
    expect(
      liveOscarMintOpenSkipReason({
        open,
        mint: 'mintA',
        incomingTradeLane: 'scalp_wave',
      }),
    ).toBe('already_open');
  });

  it('stamps scalp_wave_v1 exit policy with TP +10%, kill −10%, timestop 3h', () => {
    const cfg = loadPaperTraderConfig();
    const ot = {
      liveOscarTradeLane: 'scalp_wave',
      liveOscarMcapTier: 'scalp_wave',
    } as OpenTrade;
    expect(stampScalpWaveExitPolicyOnOpen(ot, cfg)).toBe(true);
    expect(ot.liveExitPolicyId).toBe('scalp_wave_v1');
    expect(isScalpWaveExitPolicy(ot)).toBe(true);
    expect(resolveLiveOscarTradeLaneFromOpen(ot)).toBe('scalp_wave');
    const eff = scalpWaveEffectiveExitParams(cfg);
    expect(eff.tpX).toBeCloseTo(1.1);
    expect(eff.dcaKillstop).toBeCloseTo(-0.1);
    expect(eff.timeoutHours).toBe(3);
    expect(eff.tpGridStepPnl).toBe(0);
  });
});
