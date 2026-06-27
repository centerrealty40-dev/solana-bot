import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultLegGrossUsd,
  loadHlOscarPerpConfig,
  toHlTwapLiveConfig,
} from '../src/hyperliquid/oscar-perp/config.js';

const ENV_KEYS = [
  'HL_OSCAR_POSITION_NOTIONAL_USD',
  'HL_OSCAR_NOTIONAL_USD',
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

  it('defaults to single $50 entry at 2x (no staged DCA)', () => {
    clearEnv();
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.stagedEntryEnabled).toBe(false);
    expect(cfg.positionNotionalUsd).toBe(50);
    expect(cfg.leg1GrossUsd).toBe(50);
    expect(cfg.leg2GrossUsd).toBe(0);
    expect(cfg.leg3GrossUsd).toBe(0);
    expect(cfg.leverage).toBe(2);
    const twap = toHlTwapLiveConfig(cfg);
    expect(twap.notionalUsd).toBe(25);
  });

  it('accepts HL_OSCAR_NOTIONAL_USD alias', () => {
    process.env.HL_OSCAR_NOTIONAL_USD = '75';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.positionNotionalUsd).toBe(75);
    expect(cfg.leg1GrossUsd).toBe(75);
  });

  it('staged entry splits 30/30/40 when HL_OSCAR_STAGED_ENTRY=1', () => {
    process.env.HL_OSCAR_STAGED_ENTRY = '1';
    process.env.HL_OSCAR_POSITION_NOTIONAL_USD = '50';
    const cfg = loadHlOscarPerpConfig();
    expect(cfg.stagedEntryEnabled).toBe(true);
    const legs = defaultLegGrossUsd(50);
    expect(cfg.leg1GrossUsd).toBe(legs.leg1);
    expect(cfg.leg2GrossUsd).toBe(legs.leg2);
    expect(cfg.leg3GrossUsd).toBe(legs.leg3);
    expect(cfg.leg1GrossUsd + cfg.leg2GrossUsd + cfg.leg3GrossUsd).toBe(50);
  });
});
