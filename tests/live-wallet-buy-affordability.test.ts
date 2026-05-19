import { describe, expect, it } from 'vitest';
import {
  estimateLamportsForBuyUsd,
  isInsufficientFundsSimError,
  isLiveBuyDiscoveryTelegramSuppressed,
  markLiveWalletInsufficientForBuy,
  requiredLamportsForBuyQuote,
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
});

describe('telegram suppress flag', () => {
  it('marks and reads suppress window', () => {
    markLiveWalletInsufficientForBuy(120_000);
    expect(isLiveBuyDiscoveryTelegramSuppressed()).toBe(true);
  });
});
