import { describe, expect, it } from 'vitest';
import {
  LIVE_LERA10_STRATEGY_ID,
  LIVE_LERA_STRATEGY_ID,
  LIVE_OSCAR_MAIN_STRATEGY_ID,
  LIVE_OSCAR_PRESET_C_STRATEGY_ID,
  isLiveLeraTradingStrategyId,
  isLiveOscarDiscoveryQuoteStrategyId,
  isLiveOscarFamilyTradingStrategyId,
  isLiveOscarTradingStrategyId,
} from '../src/preset-c/live-oscar-family.js';

describe('live-oscar-family', () => {
  it('recognizes Lera and Lera 10 trading ids', () => {
    expect(isLiveLeraTradingStrategyId(LIVE_LERA_STRATEGY_ID)).toBe(true);
    expect(isLiveLeraTradingStrategyId(LIVE_LERA10_STRATEGY_ID)).toBe(true);
    expect(isLiveLeraTradingStrategyId(LIVE_OSCAR_MAIN_STRATEGY_ID)).toBe(false);
  });

  it('includes Lera family in discovery quote and exit-family helpers', () => {
    expect(isLiveOscarFamilyTradingStrategyId(LIVE_LERA_STRATEGY_ID)).toBe(true);
    expect(isLiveOscarFamilyTradingStrategyId(LIVE_LERA10_STRATEGY_ID)).toBe(true);
    expect(isLiveOscarFamilyTradingStrategyId(LIVE_OSCAR_MAIN_STRATEGY_ID)).toBe(true);
    expect(isLiveOscarFamilyTradingStrategyId(LIVE_OSCAR_PRESET_C_STRATEGY_ID)).toBe(true);
    expect(isLiveOscarFamilyTradingStrategyId('live-oscar-risky')).toBe(false);
    expect(isLiveOscarDiscoveryQuoteStrategyId(LIVE_LERA10_STRATEGY_ID)).toBe(true);
    expect(isLiveOscarTradingStrategyId(LIVE_LERA_STRATEGY_ID)).toBe(false);
  });
});
