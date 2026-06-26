import { describe, expect, it } from 'vitest';
import {
  estimateLamportsForBuyUsd,
  maxAffordableBuyUsd,
  resolveBuyAffordRequiredLamports,
  resolvePartialBuyNotional,
  spendableLamportsForBuy,
} from '../src/live/wallet-buy-affordability.js';

describe('wallet-buy-affordability partial slice', () => {
  const buffer = 50_000_000; // 0.05 SOL

  it('spendableLamportsForBuy keeps reserve', () => {
    expect(spendableLamportsForBuy(1_840_000_000n, buffer)).toBe(1_790_000_000n);
    expect(spendableLamportsForBuy(40_000_000n, buffer)).toBe(0n);
  });

  it('maxAffordableBuyUsd from wallet minus reserve', () => {
    const wallet = 1_840_000_000n; // 1.84 SOL
    const solUsd = 150;
    expect(maxAffordableBuyUsd(wallet, buffer, solUsd)).toBeCloseTo(268.5, 1);
  });

  it('1.84 SOL wallet partials $300 leg instead of full skip', () => {
    const wallet = 1_840_000_000n;
    const solUsd = 150;
    const partial = resolvePartialBuyNotional({
      plannedUsd: 300,
      walletLamports: wallet,
      bufferLamports: buffer,
      solUsd,
      minUsd: 50,
    });
    expect(partial.ok).toBe(true);
    expect(partial.usdNotional).toBeCloseTo(268.5, 0);
    expect(partial.usdNotional).toBeLessThan(300);

    const required = resolveBuyAffordRequiredLamports({
      intendedUsd: 300,
      solUsd,
      quoteInLamports: estimateLamportsForBuyUsd(300, solUsd),
      bufferLamports: buffer,
    });
    expect(wallet < required.requiredLamports).toBe(true);
    expect(partial.usdNotional).toBeGreaterThanOrEqual(50);
  });

  it('52 SOL wallet passes afford gate for $300 leg at fresh SOL/USD', () => {
    const wallet = 52_000_000_000n;
    const solUsd = 136;
    const resolved = resolveBuyAffordRequiredLamports({
      intendedUsd: 300,
      solUsd,
      quoteInLamports: estimateLamportsForBuyUsd(300, 68),
      bufferLamports: buffer,
    });
    expect(wallet >= resolved.requiredLamports).toBe(true);
    const partial = resolvePartialBuyNotional({
      plannedUsd: 300,
      walletLamports: wallet,
      bufferLamports: buffer,
      solUsd,
      minUsd: 50,
    });
    expect(partial.ok).toBe(false);
  });

  it('resolvePartialBuyNotional rejects when below minimum', () => {
    const wallet = 400_000_000n; // 0.4 SOL
    const r = resolvePartialBuyNotional({
      plannedUsd: 300,
      walletLamports: wallet,
      bufferLamports: buffer,
      solUsd: 100,
      minUsd: 50,
    });
    expect(r.ok).toBe(false);
    expect(r.maxAffordableUsd).toBeLessThan(50);
  });

  it('resolvePartialBuyNotional ok when wallet can fund full slice', () => {
    const wallet = 3_000_000_000n;
    const r = resolvePartialBuyNotional({
      plannedUsd: 250,
      walletLamports: wallet,
      bufferLamports: buffer,
      solUsd: 150,
      minUsd: 50,
    });
    expect(r.ok).toBe(false);
    expect(r.usdNotional).toBe(250);
  });
});
