import { describe, expect, it } from 'vitest';
import { scaleBuyUsdToWalletSol } from '../../src/copytrader/buy-affordability.js';

describe('scaleBuyUsdToWalletSol', () => {
  it('passes through when wallet has enough SOL', () => {
    const r = scaleBuyUsdToWalletSol({
      sizeUsd: 902.15,
      lamports: 15_000_000_000n,
      requiredLamports: 14_000_000_000n,
      minUsd: 10,
    });
    expect(r).toEqual({
      ok: true,
      sizeUsd: 902.15,
      scaled: false,
      lamports: 15_000_000_000n,
      requiredLamports: 14_000_000_000n,
    });
  });

  it('shrinks add when SOL is short (HUNTER incident shape)', () => {
    const r = scaleBuyUsdToWalletSol({
      sizeUsd: 902.15,
      lamports: 9_567_723_522n,
      requiredLamports: 14_922_586_981n,
      minUsd: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scaled).toBe(true);
    expect(r.sizeUsd).toBeGreaterThan(550);
    expect(r.sizeUsd).toBeLessThan(650);
  });

  it('fails when scaled size is below minimum', () => {
    const r = scaleBuyUsdToWalletSol({
      sizeUsd: 902.15,
      lamports: 100_000_000n,
      requiredLamports: 14_922_586_981n,
      minUsd: 50,
    });
    expect(r).toEqual({
      ok: false,
      reason: 'insufficient_wallet_sol',
      lamports: 100_000_000n,
      requiredLamports: 14_922_586_981n,
    });
  });
});
