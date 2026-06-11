import { describe, expect, it } from 'vitest';

import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
import {
  createLeverageForCoin,
  effectiveLeverage,
  marginUsdForMaxLev,
  openGrossUsdForCoin,
  openGrossUsdForMaxLev,
  openMarginUsdForCoin,
} from '../src/hyperliquid/twap/live/margin-by-leverage.js';
import { newLegGrossUsd, stackCfgFromLiveConfig } from '../src/hyperliquid/twap/live/coin-stack-policy.js';

const tiers = { lev3Usd: 1500, lev5Usd: 1000, lev7Usd: 800 };

describe('marginUsdForMaxLev', () => {
  it('maps leverage tiers to collateral', () => {
    expect(marginUsdForMaxLev(3, tiers)).toBe(1500);
    expect(marginUsdForMaxLev(2, tiers)).toBe(1500);
    expect(marginUsdForMaxLev(4, tiers)).toBe(1000);
    expect(marginUsdForMaxLev(5, tiers)).toBe(1000);
    expect(marginUsdForMaxLev(6, tiers)).toBe(800);
    expect(marginUsdForMaxLev(7, tiers)).toBe(800);
  });
});

describe('openGrossUsdForMaxLev', () => {
  it('targets uniform gross across leverage caps', () => {
    expect(openGrossUsdForMaxLev(3, tiers)).toBe(4500);
    expect(openGrossUsdForMaxLev(5, tiers)).toBe(5000);
    expect(openGrossUsdForMaxLev(7, tiers)).toBe(5600);
  });
});

describe('effectiveLeverage + createLeverageForCoin', () => {
  it('caps requested leverage by HL coin max', () => {
    expect(effectiveLeverage(3, 7)).toBe(3);
    expect(effectiveLeverage(10, 7)).toBe(7);
    expect(effectiveLeverage(undefined, 7)).toBe(7);
  });

  it('resolves per-coin leverage from cache map', () => {
    const levForCoin = createLeverageForCoin(7, new Map([['GRASS', 3], ['ETH', 7]]));
    expect(levForCoin('GRASS')).toBe(3);
    expect(levForCoin('ETH')).toBe(7);
    expect(levForCoin('UNKNOWN')).toBe(7);
  });
});

describe('open sizing helpers', () => {
  const cfg = {
    ...loadHlTwapLiveConfig(),
    marginLev3Usd: 1500,
    marginLev5Usd: 1000,
    marginLev7Usd: 800,
    leverage: 7,
  };

  it('computes margin and gross per coin', () => {
    const levForCoin = createLeverageForCoin(cfg.leverage, new Map([['GRASS', 3]]));
    expect(openMarginUsdForCoin('GRASS', cfg, levForCoin)).toBe(1500);
    expect(openGrossUsdForCoin('GRASS', cfg, levForCoin)).toBe(4500);
    expect(openGrossUsdForCoin('BTC', cfg, levForCoin)).toBe(5600);
  });
});

describe('newLegGrossUsd stack cap', () => {
  it('uses per-coin margin×leverage for stack gross', () => {
    const stackCfg = stackCfgFromLiveConfig(
      {
        ...loadHlTwapLiveConfig(),
        marginLev3Usd: 1500,
        marginLev5Usd: 1000,
        marginLev7Usd: 800,
        leverage: 7,
        coinMaxLegs: 2,
        coinMaxGrossUsd: 12_000,
      },
      createLeverageForCoin(7, new Map([['GRASS', 3], ['ENA', 7]])),
    );
    expect(newLegGrossUsd(stackCfg, 'GRASS')).toBe(4500);
    expect(newLegGrossUsd(stackCfg, 'ENA')).toBe(5600);
  });
});
