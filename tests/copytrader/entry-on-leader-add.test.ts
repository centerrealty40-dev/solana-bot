import { describe, expect, it } from 'vitest';
import {
  enterOnLeaderAddSizeUsd,
  leaderTotalBagUsdAfterBuy,
  shouldIgnoreFurtherAddsAfterBagEntry,
  shouldIgnoreLeaderFirstBuyForAddEntry,
  usesEnterOnlyOnLeaderAdd,
} from '../../src/copytrader/entry-on-leader-add.js';
import { COPY_TRADER_TOKEN_UI_SCALE } from '../../src/copytrader/position-reconcile.js';

describe('enter only on leader add', () => {
  const on = { enterOnlyOnLeaderAdd: true, enterOnLeaderAddBagRatio: 0.7, minLeaderBuyUsd: 50 };
  const off = { enterOnlyOnLeaderAdd: false, enterOnLeaderAddBagRatio: 0.7, minLeaderBuyUsd: 50 };

  it('flags mode', () => {
    expect(usesEnterOnlyOnLeaderAdd(on)).toBe(true);
    expect(usesEnterOnlyOnLeaderAdd(off)).toBe(false);
  });

  it('ignores leader first buy when mode on', () => {
    expect(shouldIgnoreLeaderFirstBuyForAddEntry(on, 0n)).toBe(true);
    expect(shouldIgnoreLeaderFirstBuyForAddEntry(on, 1_000_000n)).toBe(false);
    expect(shouldIgnoreLeaderFirstBuyForAddEntry(off, 0n)).toBe(false);
  });

  it('blocks further adds after bag entry', () => {
    expect(shouldIgnoreFurtherAddsAfterBagEntry(on)).toBe(true);
    expect(shouldIgnoreFurtherAddsAfterBagEntry(off)).toBe(false);
  });

  it('sizes entry as 70% of leader total bag after add', () => {
    // 100k tokens pre + 50k buy @ $0.01 → bag $1500 → 70% = $1050
    const pre = 100_000n * BigInt(COPY_TRADER_TOKEN_UI_SCALE);
    const buy = 50_000n * BigInt(COPY_TRADER_TOKEN_UI_SCALE);
    expect(leaderTotalBagUsdAfterBuy({ preLeaderRaw: pre, buyRaw: buy, priceUsd: 0.01 })).toBe(1500);
    expect(
      enterOnLeaderAddSizeUsd(on, { preLeaderRaw: pre, buyRaw: buy, priceUsd: 0.01 }),
    ).toBe(1050);
    expect(
      enterOnLeaderAddSizeUsd(off, { preLeaderRaw: pre, buyRaw: buy, priceUsd: 0.01 }),
    ).toBe(0);
  });
});
