import { describe, expect, it } from 'vitest';
import {
  mirrorAverageDeepDiscountTarget,
  mirrorAverageLevel,
  mirrorAverageSizeUsd,
  mirrorAverageHoldAllowed,
  mirrorAveragePriceAllowed,
  recentMirrorLocalLow,
  recentMirrorLocalLowCascade,
  parseMirrorOhlcvList,
  mirrorAverageReference,
  shouldJournalMirrorAverageSkip,
} from '../../src/milddip/mirror-averaging.js';
import { resolveBuyMaxPriceImpactPct } from '../../src/copytrader/live-exec.js';

describe('mirror averaging local low', () => {
  it('uses the entry base for the first average and the prior fill for the next', () => {
    expect(mirrorAverageReference({
      entryPriceUsd: 100,
      lastAverageFillPriceUsd: undefined,
      attempts: 0,
      initialDiscountPct: 10,
      nextDiscountPct: 15,
    })).toEqual({ entryPriceUsd: 100, minDiscountPct: 10 });
    expect(mirrorAverageReference({
      entryPriceUsd: 90,
      lastAverageFillPriceUsd: 80,
      attempts: 1,
      initialDiscountPct: 10,
      nextDiscountPct: 15,
    })).toEqual({ entryPriceUsd: 80, minDiscountPct: 15 });
    expect(mirrorAverageReference({
      entryPriceUsd: 90,
      lastAverageFillPriceUsd: undefined,
      attempts: 1,
      initialDiscountPct: 10,
      nextDiscountPct: 15,
    })).toBeNull();
  });
  it('parses candles, excludes the tail, and finds the minimum low', () => {
    const now = 10_000_000;
    const candles = parseMirrorOhlcvList([
      [Math.floor((now - 3_600_000) / 1000), 10, 11, 7, 9, 1],
      [Math.floor((now - 1_200_000) / 1000), 10, 11, 6, 9, 1],
      [Math.floor((now - 300_000) / 1000), 10, 11, 2, 9, 1],
    ]);
    expect(recentMirrorLocalLow({
      candles,
      nowMs: now,
      windowMs: 3_600_000,
      excludeTailMs: 900_000,
    })).toBe(6);
  });

  it('returns null when the valid window is empty', () => {
    expect(recentMirrorLocalLow({
      candles: [{ tsMs: 9_900_000, low: 1 }],
      nowMs: 10_000_000,
      windowMs: 3_600_000,
      excludeTailMs: 900_000,
    })).toBeNull();
  });

  it('uses the first window whose low clears the entry discount', () => {
    const now = 10_000_000;
    const candles = [
      { tsMs: now - 30 * 60_000, low: 75 },
      { tsMs: now - 2 * 3_600_000, low: 10 },
    ];
    expect(recentMirrorLocalLowCascade({
      candles,
      nowMs: now,
      windowsMs: [3_600_000, 7_200_000, 10_800_000],
      excludeTailMs: 120_000,
      entryPriceUsd: 100,
      minDiscountPct: 10,
    })).toBe(75);
  });

  it('falls through to a longer window when the short window is too shallow', () => {
    const now = 10_000_000;
    const candles = [
      { tsMs: now - 30 * 60_000, low: 95 },
      { tsMs: now - 2 * 3_600_000, low: 85 },
    ];
    expect(recentMirrorLocalLowCascade({
      candles,
      nowMs: now,
      windowsMs: [3_600_000, 7_200_000, 10_800_000],
      excludeTailMs: 120_000,
      entryPriceUsd: 100,
      minDiscountPct: 10,
    })).toBe(85);
  });

  it('returns no target when no window reaches the required discount', () => {
    const now = 10_000_000;
    expect(recentMirrorLocalLowCascade({
      candles: [
        { tsMs: now - 30 * 60_000, low: 95 },
        { tsMs: now - 2 * 3_600_000, low: 91 },
      ],
      nowMs: now,
      windowsMs: [3_600_000, 7_200_000, 10_800_000],
      excludeTailMs: 120_000,
      entryPriceUsd: 100,
      minDiscountPct: 10,
    })).toBeNull();
  });

  it('excludes only the latest two minutes from each window', () => {
    const now = 10_000_000;
    expect(recentMirrorLocalLow({
      candles: [
        { tsMs: now - 60_000, low: 50 },
        { tsMs: now - 180_000, low: 60 },
      ],
      nowMs: now,
      windowMs: 3_600_000,
      excludeTailMs: 120_000,
    })).toBe(60);
  });

  it('requires a discount below the position entry and the local-low condition', () => {
    const base = {
      entryPriceUsd: 100,
      targetPriceUsd: 98,
      tolerancePct: 0.5,
      minDiscountPct: 2,
    };
    expect(mirrorAveragePriceAllowed({ ...base, markPriceUsd: 101 })).toBe(false);
    expect(mirrorAveragePriceAllowed({ ...base, markPriceUsd: 99 })).toBe(false);
    expect(mirrorAveragePriceAllowed({ ...base, markPriceUsd: 97 })).toBe(true);
    expect(mirrorAveragePriceAllowed({ ...base, markPriceUsd: 99 })).toBe(false);
  });

  it('falls back to the mark price when it is already below the discount target', () => {
    const base = { entryPriceUsd: 100, minDiscountPct: 30 };
    expect(mirrorAverageDeepDiscountTarget({ ...base, markPriceUsd: 71 })).toBeNull();
    expect(mirrorAverageDeepDiscountTarget({ ...base, markPriceUsd: 70 })).toBe(70);
    expect(mirrorAverageDeepDiscountTarget({ ...base, markPriceUsd: 46 })).toBe(46);
    expect(mirrorAverageDeepDiscountTarget({ ...base, markPriceUsd: 0 })).toBeNull();
  });

  it('waits for the minimum hold after opening', () => {
    expect(mirrorAverageHoldAllowed({
      openedAtMs: 1_000,
      nowMs: 120_999,
      minHoldMs: 120_000,
    })).toBe(false);
    expect(mirrorAverageHoldAllowed({
      openedAtMs: 1_000,
      nowMs: 121_000,
      minHoldMs: 120_000,
    })).toBe(true);
  });

  it('throttles repeated skip reasons while allowing changes and expiry', () => {
    const mint = 'mirror-average-throttle-test';
    expect(shouldJournalMirrorAverageSkip(mint, 'price_not_at_low', 1_000)).toBe(true);
    expect(shouldJournalMirrorAverageSkip(mint, 'price_not_at_low', 299_000)).toBe(false);
    expect(shouldJournalMirrorAverageSkip(mint, 'hold_not_reached', 299_000)).toBe(true);
    expect(shouldJournalMirrorAverageSkip(mint, 'hold_not_reached', 598_999)).toBe(false);
    expect(shouldJournalMirrorAverageSkip(mint, 'hold_not_reached', 599_000)).toBe(true);
  });

  it('uses the average override only when it is positive', () => {
    expect(resolveBuyMaxPriceImpactPct(5, 3)).toBe(5);
    expect(resolveBuyMaxPriceImpactPct(0, 3)).toBe(3);
    expect(resolveBuyMaxPriceImpactPct(undefined, 3)).toBe(3);
  });

  it('selects configured levels once from the original entry', () => {
    const first = mirrorAverageLevel({
      levelsPct: [25, 50],
      completedLevelsPct: [],
      attempts: 0,
      entryPriceUsd: 100,
      initialDiscountPct: 15,
      nextDiscountPct: 15,
    });
    const second = mirrorAverageLevel({
      levelsPct: [25, 50],
      completedLevelsPct: [25],
      attempts: 1,
      entryPriceUsd: 100,
      lastAverageFillPriceUsd: 75,
      initialDiscountPct: 15,
      nextDiscountPct: 15,
    });
    expect(first).toEqual({ level: 25, minDiscountPct: 25 });
    expect(second).toEqual({ level: 50, minDiscountPct: 50 });
    expect(mirrorAverageLevel({
      levelsPct: [25, 50],
      completedLevelsPct: [25, 50],
      attempts: 2,
      entryPriceUsd: 100,
      initialDiscountPct: 15,
      nextDiscountPct: 15,
    })).toBeNull();
  });

  it('sizes bag-mark averages with fallback, free balance, and hard cap', () => {
    expect(mirrorAverageSizeUsd({
      mode: 'bag_mark',
      flatUsd: 10,
      bagMarkUsd: 65,
      maxUsd: 200,
      freeUsd: 100,
    })).toBe(65);
    expect(mirrorAverageSizeUsd({
      mode: 'bag_mark',
      flatUsd: 10,
      bagMarkUsd: 0,
      maxUsd: 200,
      freeUsd: 100,
    })).toBe(10);
    expect(mirrorAverageSizeUsd({
      mode: 'bag_mark',
      flatUsd: 50,
      bagMarkUsd: 300,
      maxUsd: 200,
      freeUsd: 80,
    })).toBe(80);
  });
});
