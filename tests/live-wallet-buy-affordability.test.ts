import { describe, expect, it } from 'vitest';
import {
  estimateLamportsForBuyUsd,
  isInsufficientFundsSimError,
  isLiveBuyDiscoveryTelegramSuppressed,
  requiredLamportsForBuyQuote,
  resolveBuyAffordRequiredLamports,
  resetLiveBuyTelegramSuppressTick,
} from '../src/live/wallet-buy-affordability.js';

describe('isInsufficientFundsSimError', () => {
  it('detects Jupiter sim Custom:1', () => {
    expect(
      isInsufficientFundsSimError(
        'sim_failed:{"InstructionError":[3,{"Custom":1}]}',
      ),
    ).toBe(true);
  });

  it('ignores other instruction errors', () => {
    expect(isInsufficientFundsSimError('sim_failed:{"InstructionError":[3,{"Custom":6024}]}')).toBe(
      false,
    );
  });
});

describe('lamports helpers', () => {
  it('adds buffer to quote in amount', () => {
    expect(requiredLamportsForBuyQuote(5_000_000_000n, 10_000_000)).toBe(5_010_000_000n);
  });

  it('estimates swap lamports from USD', () => {
    const lam = estimateLamportsForBuyUsd(500, 100);
    expect(Number(lam)).toBeGreaterThan(4_900_000_000);
    expect(Number(lam)).toBeLessThan(5_100_000_000);
  });

  it('detects inflated quote from stale solUsd and uses estimate for afford', () => {
    const estimate = estimateLamportsForBuyUsd(730, 150);
    const inflatedQuote = estimate * 2n;
    const resolved = resolveBuyAffordRequiredLamports({
      intendedUsd: 730,
      solUsd: 150,
      quoteInLamports: inflatedQuote,
      bufferLamports: 10_000_000,
    });
    expect(resolved.sane).toBe(false);
    expect(resolved.source).toBe('estimate');
    expect(resolved.requiredLamports).toBe(estimate + 10_000_000n);
  });

  it('trusts quote when within drift band', () => {
    const estimate = estimateLamportsForBuyUsd(730, 150);
    const quote = (estimate * 105n) / 100n;
    const resolved = resolveBuyAffordRequiredLamports({
      intendedUsd: 730,
      solUsd: 150,
      quoteInLamports: quote,
      bufferLamports: 10_000_000,
    });
    expect(resolved.sane).toBe(true);
    expect(resolved.source).toBe('quote');
    expect(resolved.requiredLamports).toBe(quote + 10_000_000n);
  });
});

describe('telegram suppress tick flag', () => {
  it('resets each tick without cross-tick cooldown', () => {
    resetLiveBuyTelegramSuppressTick();
    expect(isLiveBuyDiscoveryTelegramSuppressed()).toBe(false);
  });
});
