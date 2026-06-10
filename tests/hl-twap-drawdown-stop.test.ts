import { describe, expect, it } from 'vitest';

import { resolveAccountEquityUsd } from '../src/hyperliquid/twap/hyperliquid-meta.js';
import {
  computeDrawdownUsd,
  shouldTriggerDrawdownStop,
  updateTrailingPeak,
} from '../src/hyperliquid/twap/live/drawdown-stop.js';

describe('resolveAccountEquityUsd', () => {
  it('uses perp accountValue when populated (includes uPnL)', () => {
    const equity = resolveAccountEquityUsd(
      {
        accountValueUsd: 1000,
        perpAccountValueUsd: 4850,
        spotUsdcTotalUsd: 5000,
      },
      [{ unrealizedPnlUsd: -150 }],
    );
    expect(equity).toBe(4850);
  });

  it('unified fallback: spot USDC + sum unrealized PnL', () => {
    const equity = resolveAccountEquityUsd(
      {
        accountValueUsd: 5000,
        perpAccountValueUsd: 0,
        spotUsdcTotalUsd: 5000,
      },
      [
        { unrealizedPnlUsd: -200 },
        { unrealizedPnlUsd: -300 },
      ],
    );
    expect(equity).toBe(4500);
  });

  it('falls back to accountValueUsd when no spot/perp split', () => {
    const equity = resolveAccountEquityUsd(
      { accountValueUsd: 3200, perpAccountValueUsd: 0, spotUsdcTotalUsd: 0 },
      [],
    );
    expect(equity).toBe(3200);
  });
});

describe('trailing peak drawdown stop', () => {
  it('raises peak on new equity high', () => {
    expect(updateTrailingPeak(5000, 6000)).toBe(6000);
    expect(updateTrailingPeak(6000, 5500)).toBe(6000);
  });

  it('computes drawdown from peak not initial balance', () => {
    let peak = 5000;
    peak = updateTrailingPeak(peak, 6000);
    expect(peak).toBe(6000);
    expect(computeDrawdownUsd(peak, 5000)).toBe(1000);
    expect(shouldTriggerDrawdownStop(peak, 5000, 1000)).toBe(true);
    expect(shouldTriggerDrawdownStop(peak, 5001, 1000)).toBe(false);
  });

  it('does not trigger from original start when peak grew (6000 peak, stop at 5000 not 4000)', () => {
    const startEquity = 5000;
    let peak = startEquity;
    peak = updateTrailingPeak(peak, 6000);
    const current = 5000;
    expect(computeDrawdownUsd(startEquity, current)).toBe(0);
    expect(shouldTriggerDrawdownStop(startEquity, current, 1000)).toBe(false);
    expect(computeDrawdownUsd(peak, current)).toBe(1000);
    expect(shouldTriggerDrawdownStop(peak, current, 1000)).toBe(true);
  });

  it('disabled when threshold is 0', () => {
    expect(shouldTriggerDrawdownStop(6000, 1000, 0)).toBe(false);
  });

  it('disabled when peak is 0', () => {
    expect(shouldTriggerDrawdownStop(0, 1000, 1000)).toBe(false);
  });
});
