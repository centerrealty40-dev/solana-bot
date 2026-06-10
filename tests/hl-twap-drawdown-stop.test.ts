import { describe, expect, it } from 'vitest';

import { resolveAccountEquityUsd } from '../src/hyperliquid/twap/hyperliquid-meta.js';
import {
  computeDrawdownUsd,
  shouldTriggerDrawdownStop,
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

describe('drawdown stop logic', () => {
  it('computes drawdown as baseline minus current equity', () => {
    expect(computeDrawdownUsd(5000, 4200)).toBe(800);
    expect(computeDrawdownUsd(5000, 5100)).toBe(0);
  });

  it('triggers at threshold inclusive', () => {
    expect(shouldTriggerDrawdownStop(5000, 4000, 1000)).toBe(true);
    expect(shouldTriggerDrawdownStop(5000, 4001, 1000)).toBe(false);
  });

  it('disabled when threshold is 0', () => {
    expect(shouldTriggerDrawdownStop(5000, 1000, 0)).toBe(false);
  });

  it('disabled when baseline is 0', () => {
    expect(shouldTriggerDrawdownStop(0, 1000, 1000)).toBe(false);
  });
});
