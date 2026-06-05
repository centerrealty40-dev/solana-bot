import { describe, expect, it } from 'vitest';
import {
  addPriceAboveLeaderCap,
  buyQuoteGateReason,
  partialSellQuoteGateReason,
  isQuoteGateDeferReason,
} from '../../src/copytrader/mirror-price-gates.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';

const baseCfg = {
  buyPriceMaxPremiumPct: 3,
  addMaxPremiumPct: 5,
  partialSellMaxDrawdownPct: 5,
} as CopyTraderConfig;

describe('addPriceAboveLeaderCap', () => {
  it('blocks when price is +5% above leader', () => {
    expect(addPriceAboveLeaderCap(1, 1.051, 5)).toBe(true);
    expect(addPriceAboveLeaderCap(1, 1.049, 5)).toBe(false);
  });
});

describe('buyQuoteGateReason', () => {
  it('blocks entry when Jupiter quote is +5.5% above leader (308 vs 325)', () => {
    const leader = 308;
    const quote = 325;
    const r = buyQuoteGateReason(baseCfg, 'entry', leader, quote);
    expect(r).toMatch(/^quote_entry_price_too_high/);
  });

  it('blocks add when quote is +5.5% above leader', () => {
    const r = buyQuoteGateReason(baseCfg, 'add', 308, 325);
    expect(r).toMatch(/^quote_add_price_too_high/);
  });

  it('allows entry within +3%', () => {
    expect(buyQuoteGateReason(baseCfg, 'entry', 308, 317)).toBeNull();
  });
});

describe('partialSellQuoteGateReason', () => {
  it('blocks partial sell when quote is -5% below leader', () => {
    const r = partialSellQuoteGateReason(baseCfg, 1, 0.949);
    expect(r).toMatch(/^quote_partial_sell_price_too_low/);
  });
});

describe('isQuoteGateDeferReason', () => {
  it('recognizes quote gate defer reasons', () => {
    expect(isQuoteGateDeferReason('quote_add_price_too_high quote=1')).toBe(true);
    expect(isQuoteGateDeferReason('sim_failed')).toBe(false);
  });
});