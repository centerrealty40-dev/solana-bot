import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultLegGrossUsd,
  hlOscarSizingFromEnv,
  hlOscarStrategyLabelsFromEnv,
  loadHlOscarPerpConfig,
  parseFracCsv,
  toHlTwapLiveConfig,
} from '../src/hyperliquid/oscar-perp/config.js';

const ENV_KEYS = [
  'HL_OSCAR_POSITION_NOTIONAL_USD',
  'HL_OSCAR_NOTIONAL_USD',
  'HL_OSCAR_MARGIN_USD',
  'HL_OSCAR_STAGED_ENTRY',
  'HL_OSCAR_DIP_MIN_PCT',
  'HL_OSCAR_DIP_MAX_PCT',
  'HL_OSCAR_DIP_MIN_IMPULSE_PCT',
  'HL_OSCAR_MAX_OPEN_POSITIONS',
  'HL_OSCAR_LEG1_USD',
  'HL_OSCAR_LEG2_USD',
  'HL_OSCAR_LEG3_USD',
  'HL_OSCAR_LEVERAGE',
  'HL_OSCAR_TIME_STOP_HOURS',
  'HL_OSCAR_TIME_STOP_ENABLED',
  'HL_OSCAR_TP_RUNGS',
  'HL_OSCAR_TRAIL_ARM_PCT',
  'HL_OSCAR_RECOVERY_VETO_ENABLED',
  'HL_OSCAR_LOCAL_HIGH_VETO_ENABLED',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('hl-oscar-perp config sizing', () => {
  afterEach(() => clearEnv());

  it('defaults to staged $100 gross ($50 margin) at 2x with dip −12% and impulse 8%', () => {
    clearEnv();
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.dipMinDropPct).toBe(-12);
    expect(cfg.dipMinImpulsePct).toBe(8);
    expect(cfg.dipMaxDropPct).toBe(-50);
    expect(cfg.timeStopHours).toBe(12);
    expect(cfg.maxOpenPositions).toBe(4);
    expect(cfg.stagedEntryEnabled).toBe(true);
    expect(cfg.leg2DropPct).toBe(5);
    expect(cfg.leg3DropPct).toBe(10);
    expect(cfg.tpRungs).toEqual([0.05, 0.075, 0.1]);
    expect(cfg.trailArmFrac).toBeCloseTo(0.08);
    expect(cfg.recoveryVetoEnabled).toBe(false);
    expect(cfg.localHighVetoEnabled).toBe(false);
    expect(cfg.positionNotionalUsd).toBe(100);
    expect(cfg.positionMarginUsd).toBe(50);
    const legs = defaultLegGrossUsd(100);
    expect(cfg.leg1GrossUsd).toBe(legs.leg1);
    expect(cfg.leg2GrossUsd).toBe(legs.leg2);
    expect(cfg.leg3GrossUsd).toBe(legs.leg3);
    expect(cfg.leg1GrossUsd + cfg.leg2GrossUsd + cfg.leg3GrossUsd).toBe(100);
    expect(cfg.leverage).toBe(2);
    const twap = toHlTwapLiveConfig(cfg);
    expect(twap.notionalUsd).toBe(15);
  });

  it('single-shot when HL_OSCAR_STAGED_ENTRY=0', () => {
    clearEnv();
    process.env.HL_OSCAR_STAGED_ENTRY = '0';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.stagedEntryEnabled).toBe(false);
    expect(cfg.leg1GrossUsd).toBe(100);
    expect(cfg.leg2GrossUsd).toBe(0);
    expect(cfg.leg3GrossUsd).toBe(0);
    const twap = toHlTwapLiveConfig(cfg);
    expect(twap.notionalUsd).toBe(50);
  });

  it('derives gross from HL_OSCAR_MARGIN_USD × leverage', () => {
    process.env.HL_OSCAR_MARGIN_USD = '50';
    process.env.HL_OSCAR_LEVERAGE = '2';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.positionNotionalUsd).toBe(100);
    expect(cfg.positionMarginUsd).toBe(50);
  });

  it('accepts HL_OSCAR_NOTIONAL_USD alias for gross', () => {
    process.env.HL_OSCAR_NOTIONAL_USD = '150';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.positionNotionalUsd).toBe(150);
    const legs = defaultLegGrossUsd(150);
    expect(cfg.leg1GrossUsd).toBe(legs.leg1);
    expect(cfg.leg2GrossUsd).toBe(legs.leg2);
    expect(cfg.leg3GrossUsd).toBe(legs.leg3);
    expect(cfg.positionMarginUsd).toBe(75);
  });

  it('HL_OSCAR_MARGIN_USD takes precedence over notional env', () => {
    process.env.HL_OSCAR_MARGIN_USD = '40';
    process.env.HL_OSCAR_NOTIONAL_USD = '999';
    process.env.HL_OSCAR_LEVERAGE = '2';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.positionNotionalUsd).toBe(80);
    expect(cfg.positionMarginUsd).toBe(40);
  });

  it('staged entry splits 30/30/40 when HL_OSCAR_STAGED_ENTRY=1', () => {
    process.env.HL_OSCAR_STAGED_ENTRY = '1';
    process.env.HL_OSCAR_POSITION_NOTIONAL_USD = '100';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.stagedEntryEnabled).toBe(true);
    const legs = defaultLegGrossUsd(100);
    expect(cfg.leg1GrossUsd).toBe(legs.leg1);
    expect(cfg.leg2GrossUsd).toBe(legs.leg2);
    expect(cfg.leg3GrossUsd).toBe(legs.leg3);
    expect(cfg.leg1GrossUsd + cfg.leg2GrossUsd + cfg.leg3GrossUsd).toBe(100);
  });

  it('hlOscarSizingFromEnv matches loadHlOscarPerpConfig defaults', () => {
    clearEnv();
    const sizing = hlOscarSizingFromEnv();
    expect(sizing.leverage).toBe(2);
    expect(sizing.grossUsd).toBe(100);
    expect(sizing.marginUsd).toBe(50);
  });

  it('loads marginReserveUsd from HL_OSCAR_MARGIN_RESERVE_USD', () => {
    clearEnv();
    process.env.HL_OSCAR_MARGIN_RESERVE_USD = '30';
    expect(loadHlOscarPerpConfig().marginReserveUsd).toBe(30);
  });

  it('disables time stop when HL_OSCAR_TIME_STOP_ENABLED=0', () => {
    clearEnv();
    process.env.HL_OSCAR_TIME_STOP_ENABLED = '0';
    process.env.HL_OSCAR_TIME_STOP_HOURS = '12';
    expect(loadHlOscarPerpConfig().timeStopHours).toBe(0);
  });

  it('enables time stop when HL_OSCAR_TIME_STOP_ENABLED=1', () => {
    clearEnv();
    process.env.HL_OSCAR_TIME_STOP_ENABLED = '1';
    process.env.HL_OSCAR_TIME_STOP_HOURS = '12';
    expect(loadHlOscarPerpConfig().timeStopHours).toBe(12);
  });

  it('loads TP rungs from HL_OSCAR_TP_RUNGS percent syntax', () => {
    clearEnv();
    process.env.HL_OSCAR_TP_RUNGS = '8,12,16';
    expect(loadHlOscarPerpConfig().tpRungs).toEqual([0.08, 0.12, 0.16]);
  });

  it('parseFracCsv accepts fraction and percent forms', () => {
    expect(parseFracCsv('0.08,0.12,0.16', [])).toEqual([0.08, 0.12, 0.16]);
    expect(parseFracCsv('8,12,16', [])).toEqual([0.08, 0.12, 0.16]);
  });

  it('loads recovery veto from env', () => {
    clearEnv();
    process.env.HL_OSCAR_RECOVERY_VETO_ENABLED = '1';
    process.env.HL_OSCAR_RECOVERY_VETO_WINDOWS_MIN = '30,60';
    process.env.HL_OSCAR_RECOVERY_VETO_MAX_BOUNCE_PCT = '12';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.recoveryVetoEnabled).toBe(true);
    expect(cfg.recoveryVetoWindowsMin).toEqual([30, 60]);
    expect(cfg.recoveryVetoMaxBouncePct).toBe(12);
  });

  it('hlOscarStrategyLabelsFromEnv reflects loaded config', () => {
    clearEnv();
    process.env.HL_OSCAR_RECOVERY_VETO_ENABLED = '1';
    const labels = hlOscarStrategyLabelsFromEnv();
    expect(labels.dipMinPct).toBe(-12);
    expect(labels.impulseMinPct).toBe(8);
    expect(labels.tpRungsPct).toEqual([5, 7.5, 10]);
    expect(labels.trailArmPct).toBe(8);
    expect(labels.timeStopHours).toBe(12);
    expect(labels.recoveryVeto).toBe(true);
  });
});
