import { describe, expect, it } from 'vitest';
import { decideFeeSolTopup } from '../../src/milddip/fee-sol-topup.js';

const base = {
  enabled: true,
  inFlight: false,
  nowMs: 1_000_000,
  lastCheckAtMs: 0,
  intervalMs: 1_800_000,
  executionMode: 'live',
  solUsd: 150,
  solBal: 0.02,
  usdcBal: 100,
  minUsd: 5,
  buyUsd: 20,
};

describe('decideFeeSolTopup', () => {
  it('tops up when SOL value is below floor and USDC covers buy', () => {
    // 0.02 SOL * $150 = $3 < $5
    const d = decideFeeSolTopup(base);
    expect(d.action).toBe('topup');
    if (d.action === 'topup') {
      expect(d.solValueUsd).toBeCloseTo(3, 5);
      expect(d.buyUsd).toBe(20);
    }
  });

  it('skips when SOL value is at/above floor', () => {
    const d = decideFeeSolTopup({ ...base, solBal: 0.04 }); // $6
    expect(d).toEqual({ action: 'skip', reason: 'ok' });
  });

  it('respects 30m interval after a prior check', () => {
    const d = decideFeeSolTopup({
      ...base,
      lastCheckAtMs: 50_000_000,
      nowMs: 50_000_000 + 900_000,
    });
    expect(d).toEqual({ action: 'skip', reason: 'interval' });
  });

  it('urgent bypasses interval when fee SOL is already low', () => {
    const d = decideFeeSolTopup({
      ...base,
      lastCheckAtMs: 50_000_000,
      nowMs: 50_000_000 + 900_000,
      urgent: true,
    });
    expect(d.action).toBe('topup');
  });

  it('allows check when interval elapsed', () => {
    const d = decideFeeSolTopup({
      ...base,
      lastCheckAtMs: 50_000_000,
      nowMs: 50_000_000 + 1_800_000,
    });
    expect(d.action).toBe('topup');
  });

  it('skips when USDC cannot fund the top-up', () => {
    const d = decideFeeSolTopup({ ...base, usdcBal: 10 });
    expect(d).toEqual({ action: 'skip', reason: 'insufficient_usdc' });
  });

  it('skips when disabled', () => {
    const d = decideFeeSolTopup({ ...base, enabled: false });
    expect(d).toEqual({ action: 'skip', reason: 'disabled' });
  });

  it('skips when SOL/USD mark missing', () => {
    const d = decideFeeSolTopup({ ...base, solUsd: 0 });
    expect(d).toEqual({ action: 'skip', reason: 'no_price' });
  });
});
