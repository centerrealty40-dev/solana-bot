import { describe, expect, it } from 'vitest';

import { resolveAccountEquityUsd } from '../src/hyperliquid/twap/hyperliquid-meta.js';
import {
  computeDrawdownUsd,
  shouldTriggerDrawdownStop,
  updateTrailingPeak,
} from '../src/hyperliquid/twap/live/drawdown-stop.js';

describe('resolveAccountEquityUsd', () => {
  it('unified account: spot USDC + uPnL (matches HL UI Total Balance)', () => {
    const equity = resolveAccountEquityUsd(
      {
        accountValueUsd: 5696.5,
        perpAccountValueUsd: 1991.29,
        spotUsdcTotalUsd: 5696.5,
      },
      [{ unrealizedPnlUsd: 79.86 }],
    );
    expect(equity).toBeCloseTo(5776.36, 1);
  });

  it('unified account ignores perp marginSummary.accountValue when spot is set', () => {
    const equity = resolveAccountEquityUsd(
      {
        accountValueUsd: 5000,
        perpAccountValueUsd: 4850,
        spotUsdcTotalUsd: 5000,
      },
      [{ unrealizedPnlUsd: -150 }],
    );
    expect(equity).toBe(4850);
  });

  it('unified fallback: spot USDC + sum unrealized PnL when perp accountValue is 0', () => {
    const equity = resolveAccountEquityUsd(
      {
        accountValueUsd: 5000,
        perpAccountValueUsd: 0,
        spotUsdcTotalUsd: 5000,
      },
      [{ unrealizedPnlUsd: -200 }, { unrealizedPnlUsd: -300 }],
    );
    expect(equity).toBe(4500);
  });

  it('perp-only account uses marginSummary.accountValue', () => {
    const equity = resolveAccountEquityUsd(
      { accountValueUsd: 3200, perpAccountValueUsd: 3200, spotUsdcTotalUsd: 0 },
      [{ unrealizedPnlUsd: -100 }],
    );
    expect(equity).toBe(3200);
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
  const threshold = 1000;

  it('raises peak on new equity high', () => {
    expect(updateTrailingPeak(5000, 6000)).toBe(6000);
    expect(updateTrailingPeak(6000, 5500)).toBe(6000);
  });

  it('peak=6000: current=5001 no stop, current=4999 stop', () => {
    const peak = 6000;
    expect(shouldTriggerDrawdownStop(peak, 5001, threshold)).toBe(false);
    expect(shouldTriggerDrawdownStop(peak, 4999, threshold)).toBe(true);
  });

  it('peak=5700 slow drop: 4701 no stop, 4699 stop', () => {
    const peak = 5700;
    expect(shouldTriggerDrawdownStop(peak, 4701, threshold)).toBe(false);
    expect(shouldTriggerDrawdownStop(peak, 4699, threshold)).toBe(true);
  });

  it('peak=5700 instant drop to 4699 in one check triggers stop (vs peak, not prev tick)', () => {
    const peak = 5700;
    const prevTick = 5700;
    const current = 4699;
    expect(computeDrawdownUsd(prevTick, current)).toBe(1001);
    expect(shouldTriggerDrawdownStop(peak, current, threshold)).toBe(true);
  });

  it('does not trigger inter-tick delta alone when still above peak drawdown floor', () => {
    const peak = 6000;
    const prevTick = 5800;
    const current = 5001;
    expect(computeDrawdownUsd(prevTick, current)).toBe(799);
    expect(shouldTriggerDrawdownStop(peak, current, threshold)).toBe(false);
  });

  it('computes drawdown from peak not initial balance', () => {
    let peak = 5000;
    peak = updateTrailingPeak(peak, 6000);
    expect(peak).toBe(6000);
    expect(computeDrawdownUsd(peak, 5000)).toBe(1000);
    expect(shouldTriggerDrawdownStop(peak, 5000, threshold)).toBe(true);
    expect(shouldTriggerDrawdownStop(peak, 5001, threshold)).toBe(false);
  });

  it('does not trigger from original start when peak grew (6000 peak, stop at 5000 not 4000)', () => {
    const startEquity = 5000;
    let peak = startEquity;
    peak = updateTrailingPeak(peak, 6000);
    const current = 5000;
    expect(shouldTriggerDrawdownStop(startEquity, current, threshold)).toBe(false);
    expect(shouldTriggerDrawdownStop(peak, current, threshold)).toBe(true);
  });

  it('floor ratchets with peak: 6000 peak → stop level 5000', () => {
    const peak = updateTrailingPeak(5700, 6000);
    expect(peak - threshold).toBe(5000);
    expect(shouldTriggerDrawdownStop(peak, 5000, threshold)).toBe(true);
    expect(shouldTriggerDrawdownStop(peak, 5001, threshold)).toBe(false);
  });

  it('disabled when threshold is 0', () => {
    expect(shouldTriggerDrawdownStop(6000, 1000, 0)).toBe(false);
  });

  it('disabled when peak is 0', () => {
    expect(shouldTriggerDrawdownStop(0, 1000, threshold)).toBe(false);
  });
});
