import { describe, expect, it } from 'vitest';

import {
  avgEntryAfterAdd,
  favorableMovePct,
  hlRoePct,
  ladderSliceGrossUsd,
  nextLadderAction,
  PRICE_LADDER_DCA_THRESHOLD_PCT,
  sliceMarginUsd,
  tpPriceSlicePct,
  tpPriceThresholdPct,
  unrealizedUsd,
  type LadderConfig,
} from '../src/hyperliquid/twap/live/position-ladder.js';

describe('hl-twap live ladder — price mode (default prod)', () => {
  const priceCfg: LadderConfig = {
    mode: 'price',
    stepPct: 2,
    slicePctOfInitial: 30,
    dcaPctOfInitial: 50,
  };

  it('TP tiers: +0.3%→20%, +0.5%→30%, +1%→30%, then +0.5% steps', () => {
    expect(tpPriceThresholdPct(1)).toBe(0.3);
    expect(tpPriceSlicePct(1)).toBe(20);
    expect(tpPriceThresholdPct(2)).toBe(0.5);
    expect(tpPriceSlicePct(2)).toBe(30);
    expect(tpPriceThresholdPct(3)).toBe(1);
    expect(tpPriceThresholdPct(4)).toBe(1.5);
    expect(tpPriceThresholdPct(5)).toBe(2);
  });

  it('TP L1 at +0.3% takes 20% of gross', () => {
    const action = nextLadderAction('buy', 100.31, 100, 100, 1000, 1000, 0, 0, priceCfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 200 });
  });

  it('TP L2 at +0.5% takes 30% after L1', () => {
    const action = nextLadderAction('buy', 100.5, 100, 100, 1000, 800, 1, 0, priceCfg);
    expect(action).toEqual({ kind: 'take_profit', level: 2, notionalUsd: 240 });
  });

  it('TP L3 at +1% takes 30%', () => {
    const action = nextLadderAction('sell', 99, 100, 100, 1000, 500, 2, 0, priceCfg);
    expect(action).toEqual({ kind: 'take_profit', level: 3, notionalUsd: 150 });
  });

  it('DCA once at −0.5% adds 50% of initial gross', () => {
    const mark = 100 * (1 - PRICE_LADDER_DCA_THRESHOLD_PCT / 100);
    const action = nextLadderAction('buy', mark, 100, 100, 1000, 1000, 0, 0, priceCfg);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 500 });
  });

  it('no second DCA', () => {
    const mark = 100 * (1 - PRICE_LADDER_DCA_THRESHOLD_PCT / 100);
    expect(nextLadderAction('buy', mark, 100, 100, 1000, 1500, 0, 1, priceCfg)).toBeNull();
  });

  it('no action between +0.3% and +0.5% after L1', () => {
    expect(nextLadderAction('buy', 100.4, 100, 100, 1000, 800, 1, 0, priceCfg)).toBeNull();
  });
});

describe('hl-twap live ladder — legacy ROE mode', () => {
  const roeCfg: LadderConfig = {
    mode: 'roe',
    stepPct: 2,
    slicePctOfInitial: 30,
    dcaPctOfInitial: 50,
  };

  it('favorable move: long +3%, short -3%', () => {
    expect(favorableMovePct('buy', 103, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('sell', 97, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('buy', 97, 100)).toBeCloseTo(-3, 5);
  });

  it('HL ROE = uPnL / margin (matches clearinghouse UI)', () => {
    const pnl = unrealizedUsd('sell', 0.727, 10_500, 0.718);
    expect(pnl).toBeCloseTo(130, 0);
    expect(hlRoePct('sell', 0.718, 0.727, 10_500, 1_500)).toBeCloseTo(8.67, 1);
  });

  it('TP at +2% HL ROE takes 30% of current gross', () => {
    const action = nextLadderAction('buy', 102, 100, 100, 100, 100, 0, 0, roeCfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 30 });
  });

  it('TP on stacked short $6k: +2% ROE at 7x (~0.29% price) → $1.8k slice', () => {
    const markPx = 100 * (1 - 0.02 / 7);
    const action = nextLadderAction('sell', markPx, 100, 500, 6000, 6000, 0, 0, roeCfg, 7);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 1800 });
  });

  it('DCA at −2% HL ROE adds 30% of current gross', () => {
    const action = nextLadderAction('sell', 102, 100, 100, 100, 100, 0, 0, roeCfg);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 30 });
  });

  it('second TP at +4% HL ROE cumulative', () => {
    const action = nextLadderAction('buy', 105, 100, 100, 100, 90, 1, 0, roeCfg);
    expect(action).toEqual({ kind: 'take_profit', level: 2, notionalUsd: 27 });
  });

  it('ladderSliceGrossUsd and sliceMarginUsd', () => {
    expect(ladderSliceGrossUsd(6000, roeCfg)).toBe(1800);
    expect(sliceMarginUsd(500, roeCfg)).toBe(150);
  });

  it('avgEntryAfterAdd weights by notional', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 110);
    expect(avg).toBeCloseTo(100.909, 2);
  });
});
