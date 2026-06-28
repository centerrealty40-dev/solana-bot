import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultLegGrossUsd,
  hlOscarSizingFromEnv,
  loadHlOscarPerpConfig,
  toHlTwapLiveConfig,
} from '../src/hyperliquid/oscar-perp/config.js';

const ENV_KEYS = [
  'HL_OSCAR_POSITION_NOTIONAL_USD',
  'HL_OSCAR_NOTIONAL_USD',
  'HL_OSCAR_MARGIN_USD',
  'HL_OSCAR_STAGED_ENTRY',
  'HL_OSCAR_LEG1_USD',
  'HL_OSCAR_LEG2_USD',
  'HL_OSCAR_LEG3_USD',
  'HL_OSCAR_LEVERAGE',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('hl-oscar-perp config sizing', () => {
  afterEach(() => clearEnv());

  it('defaults to single-shot $100 gross ($50 margin) at 2x', () => {
    clearEnv();
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.dipMinDropPct).toBe(-7);
    expect(cfg.dipMinImpulsePct).toBe(10);
    expect(cfg.stagedEntryEnabled).toBe(false);
    expect(cfg.leg2DropPct).toBe(5);
    expect(cfg.leg3DropPct).toBe(10);
    expect(cfg.positionNotionalUsd).toBe(100);
    expect(cfg.positionMarginUsd).toBe(50);
    expect(cfg.leg1GrossUsd).toBe(100);
    expect(cfg.leg2GrossUsd).toBe(0);
    expect(cfg.leg3GrossUsd).toBe(0);
    expect(cfg.leverage).toBe(2);
    const twap = toHlTwapLiveConfig(cfg);
    expect(twap.notionalUsd).toBe(50);
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
    expect(cfg.leg1GrossUsd).toBe(150);
    expect(cfg.leg2GrossUsd).toBe(0);
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
});
