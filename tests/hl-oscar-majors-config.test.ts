import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultLegGrossUsd,
  hlMajorsSizingFromEnv,
  loadHlOscarMajorsConfig,
  toHlTwapLiveConfig,
} from '../src/hyperliquid/oscar-majors/config.js';

const ENV_KEYS = [
  'HL_MAJORS_POSITION_NOTIONAL_USD',
  'HL_MAJORS_NOTIONAL_USD',
  'HL_MAJORS_MARGIN_USD',
  'HL_MAJORS_STAGED_ENTRY',
  'HL_MAJORS_LEG1_USD',
  'HL_MAJORS_LEG2_USD',
  'HL_MAJORS_LEG3_USD',
  'HL_MAJORS_LEVERAGE',
  'HL_MAJORS_DIP_MIN_PCT',
  'HL_MAJORS_DIP_MIN_IMPULSE_PCT',
  'HL_MAJORS_BTC_TP_RUNGS',
  'HL_MAJORS_ETH_TP_RUNGS',
  'HL_MAJORS_MAX_OPEN_POSITIONS',
  'HL_MAJORS_WHITELIST',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('hl-oscar-majors config', () => {
  afterEach(() => clearEnv());

  it('defaults to Mode A knife params (BTC+ETH, −6%, impulse off, $100 gross)', () => {
    clearEnv();
    const cfg = loadHlOscarMajorsConfig();
    expect(cfg.dipMinDropPct).toBe(-6);
    expect(cfg.dipMinImpulsePct).toBe(0);
    expect(cfg.stagedEntryEnabled).toBe(false);
    expect(cfg.positionNotionalUsd).toBe(100);
    expect(cfg.positionMarginUsd).toBe(50);
    expect(cfg.leg1GrossUsd).toBe(100);
    expect(cfg.leverage).toBe(2);
    expect(cfg.positionKillDropPct).toBe(15);
    expect(cfg.stagedKillDropPct).toBe(10);
    expect(cfg.timeStopHours).toBe(12);
    expect(cfg.maxOpenPositions).toBe(2);
    expect(cfg.whitelist).toEqual(['BTC', 'ETH']);
    expect(cfg.btcTpRungs).toEqual([0.02, 0.03, 0.04]);
    expect(cfg.ethTpRungs).toEqual([0.015, 0.02, 0.025]);
    expect(cfg.btcTrailArmFrac).toBe(0.02);
    expect(cfg.btcTrailStepDropFrac).toBe(0.01);
    expect(cfg.ethTrailArmFrac).toBe(0.015);
    expect(cfg.ethTrailStepDropFrac).toBe(0.008);
    expect(cfg.tpSellFrac).toBe(0.5);
    expect(cfg.trailSellFrac).toBe(0.25);
    expect(cfg.dipLookbackWindowsMin).toEqual([120, 360, 720]);
    expect(cfg.dipCooldownMin).toBe(30);
    expect(cfg.minDayVolumeUsd).toBe(1_000_000);
    const twap = toHlTwapLiveConfig(cfg);
    expect(twap.notionalUsd).toBe(50);
  });

  it('single-shot when HL_MAJORS_STAGED_ENTRY=0', () => {
    clearEnv();
    process.env.HL_MAJORS_STAGED_ENTRY = '0';
    const cfg = loadHlOscarMajorsConfig();
    expect(cfg.stagedEntryEnabled).toBe(false);
    expect(cfg.leg1GrossUsd).toBe(100);
    expect(cfg.leg2GrossUsd).toBe(0);
    expect(cfg.leg3GrossUsd).toBe(0);
  });

  it('derives gross from HL_MAJORS_MARGIN_USD × leverage', () => {
    process.env.HL_MAJORS_MARGIN_USD = '50';
    process.env.HL_MAJORS_LEVERAGE = '2';
    const cfg = loadHlOscarMajorsConfig();
    expect(cfg.positionNotionalUsd).toBe(100);
    expect(cfg.positionMarginUsd).toBe(50);
  });

  it('hlMajorsSizingFromEnv matches loadHlOscarMajorsConfig defaults', () => {
    clearEnv();
    const sizing = hlMajorsSizingFromEnv();
    expect(sizing.leverage).toBe(2);
    expect(sizing.grossUsd).toBe(100);
    expect(sizing.marginUsd).toBe(50);
  });

  it('staged entry splits 30/30/40 when HL_MAJORS_STAGED_ENTRY=1', () => {
    process.env.HL_MAJORS_STAGED_ENTRY = '1';
    process.env.HL_MAJORS_POSITION_NOTIONAL_USD = '100';
    const cfg = loadHlOscarMajorsConfig();
    expect(cfg.stagedEntryEnabled).toBe(true);
    const legs = defaultLegGrossUsd(100);
    expect(cfg.leg1GrossUsd).toBe(legs.leg1);
    expect(cfg.leg2GrossUsd).toBe(legs.leg2);
    expect(cfg.leg3GrossUsd).toBe(legs.leg3);
    expect(cfg.leg1GrossUsd + cfg.leg2GrossUsd + cfg.leg3GrossUsd).toBe(100);
  });
});
