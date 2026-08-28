import { describe, expect, it } from 'vitest';
import {
  buyCashDeltaUsd,
  confirmLossCapObservation,
  mirrorOpenMarkValueUsd,
  mirrorLossCapDayKey,
  maybeResetMirrorLossCapDay,
  sellCashDeltaUsd,
  syncMirrorLossCapBaseline,
} from '../../src/milddip/mirror-loss-cap.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMildDipState, saveMildDipState } from '../../src/milddip/state.js';
import { mirrorLossCapValues } from '../../src/milddip/loop.js';

describe('mirror loss cap cash and mark accounting', () => {
  const openMirrorState = (sizeUsd: number, markPriceUsd: number, cashUsd: number) =>
    ({
      open: {
        mint: {
          lane: 'leader_mirror',
          sizeUsd,
          entryPriceUsd: 1,
          lastMarkPriceUsd: markPriceUsd,
        },
      },
      mirrorTradingCashUsd: cashUsd,
    }) as Parameters<typeof mirrorLossCapValues>[0];

  it('uses open cost basis instead of mark value for drawdown', () => {
    expect(mirrorLossCapValues(openMirrorState(100, 0.5, -100))).toEqual({
      cashUsd: -100,
      bagsUsd: 100,
      bagsMarkUsd: 50,
      drawdownUsd: 0,
    });
    expect(mirrorLossCapValues(openMirrorState(0, 0.5, -50))).toMatchObject({
      bagsUsd: 0,
      bagsMarkUsd: 0,
      drawdownUsd: -50,
    });
    expect(mirrorLossCapValues(openMirrorState(50, 0.5, -75))).toMatchObject({
      bagsUsd: 50,
      bagsMarkUsd: 25,
      drawdownUsd: -25,
    });
  });

  it('treats averaging as cost basis growth, not a loss', () => {
    expect(mirrorLossCapValues(openMirrorState(150, 0.5, -150))).toMatchObject({
      bagsUsd: 150,
      bagsMarkUsd: 75,
      drawdownUsd: 0,
    });
  });

  it('resets the loss-cap window at the Moscow calendar boundary', () => {
    const before = Date.parse('2026-08-14T20:59:59.000Z');
    const after = Date.parse('2026-08-14T21:00:00.000Z');
    expect(mirrorLossCapDayKey(before, 180)).toBe('2026-08-14');
    expect(mirrorLossCapDayKey(after, 180)).toBe('2026-08-15');
    const state = {
      mirrorTradingCashUsd: -500,
      mirrorLossCapDayKey: '2026-08-14',
      mirrorLossCapBaselineAtMs: 1,
      mirrorLossCapBaselineUsd: 150,
      mirrorLossCapTriggeredAtMs: 2,
      mirrorLossCapTriggeredPnlUsd: -151,
      mirrorLossCapPendingDrawdownUsd: -150,
      mirrorLossCapPendingAtMs: 2,
    };
    const result = maybeResetMirrorLossCapDay({
      state,
      lossCapUsd: 150,
      bagsUsd: 80,
      nowMs: after,
      tzOffsetMinutes: 180,
      enabled: true,
    });
    expect(result).toMatchObject({
      reset: true,
      previousDayKey: '2026-08-14',
      dayKey: '2026-08-15',
    });
    expect(state).toMatchObject({
      mirrorTradingCashUsd: -80,
      mirrorLossCapBaselineAtMs: after,
      mirrorLossCapBaselineUsd: 150,
      mirrorLossCapDayKey: '2026-08-15',
    });
    expect(state.mirrorLossCapTriggeredAtMs).toBeUndefined();
    expect(state.mirrorLossCapPendingAtMs).toBeUndefined();
  });

  it('records the first day without resetting and is a no-op when disabled', () => {
    const state = { mirrorTradingCashUsd: -40 };
    const first = maybeResetMirrorLossCapDay({
      state,
      lossCapUsd: 150,
      bagsUsd: 40,
      nowMs: Date.parse('2026-08-14T21:00:00.000Z'),
      tzOffsetMinutes: 180,
      enabled: true,
    });
    expect(first.reset).toBe(false);
    expect(state.mirrorLossCapDayKey).toBe('2026-08-15');
    const same = maybeResetMirrorLossCapDay({
      state,
      lossCapUsd: 150,
      bagsUsd: 99,
      nowMs: Date.parse('2026-08-15T00:00:00.000Z'),
      tzOffsetMinutes: 180,
      enabled: true,
    });
    expect(same.reset).toBe(false);
    expect(state.mirrorTradingCashUsd).toBe(-40);
    const disabled = maybeResetMirrorLossCapDay({
      state,
      lossCapUsd: 150,
      bagsUsd: 99,
      nowMs: Date.parse('2026-08-15T21:00:00.000Z'),
      tzOffsetMinutes: 180,
      enabled: false,
    });
    expect(disabled.reset).toBe(false);
    expect(state.mirrorLossCapDayKey).toBe('2026-08-15');
  });
  it('uses cash deltas for executed buys and sells', () => {
    expect(buyCashDeltaUsd({ usdcBefore: 100, usdcAfter: 70 })).toBe(-30);
    expect(sellCashDeltaUsd({ usdcBefore: 70, usdcAfter: 90 })).toBe(20);
    expect(buyCashDeltaUsd({ quoteSpentUsd: 12, usdcBefore: 100, usdcAfter: 130 })).toBe(-12);
    expect(sellCashDeltaUsd({ quoteReceivedUsd: 8, usdcBefore: 70, usdcAfter: 50 })).toBe(8);
    expect(buyCashDeltaUsd({ cashDeltaUsd: -9, quoteSpentUsd: 12 })).toBe(-9);
    expect(sellCashDeltaUsd({ cashDeltaUsd: 7, quoteReceivedUsd: 8 })).toBe(7);
    expect(buyCashDeltaUsd({ sizeUsd: 12 })).toBe(-12);
    expect(sellCashDeltaUsd({ sizeUsd: 8 })).toBe(8);
  });

  it('falls back to the position cost when no confirmed mark exists', () => {
    expect(mirrorOpenMarkValueUsd({
      sizeUsd: 40,
      entryPriceUsd: 2,
    })).toBe(40);
    expect(mirrorOpenMarkValueUsd({
      sizeUsd: 10,
      entryPriceUsd: 0.00013581,
      tokenRaw: '73628247970',
    }, 0.00013581)).toBeCloseTo(10, 8);
  });

  it('requires two consecutive below-cap observations', () => {
    const first = confirmLossCapObservation({
      drawdownUsd: -101,
      capUsd: 100,
      nowMs: 1_000,
    });
    expect(first.confirmed).toBe(false);
    expect(confirmLossCapObservation({
      drawdownUsd: -20,
      capUsd: 100,
      pendingDrawdownUsd: first.pendingDrawdownUsd,
      pendingAtMs: first.pendingAtMs,
      nowMs: 6_000,
    }).confirmed).toBe(false);
    expect(confirmLossCapObservation({
      drawdownUsd: -102,
      capUsd: 100,
      pendingDrawdownUsd: first.pendingDrawdownUsd,
      pendingAtMs: first.pendingAtMs,
      nowMs: 6_000,
    }).confirmed).toBe(true);
  });

  it('preserves the pending observation and latch across state reload', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cap-state-')), 'state.json');
    const state = {
      open: {},
      cooldownUntilMs: {},
      lastExitByMint: {},
      leaderSeenMints: {},
      knifeWatch: {},
      waitDipWatch: {},
      leaderMirrorWatches: {},
      leaderMirrorDecisions: {},
      recentEntryMsByMint: {},
      mirrorTradingCashUsd: -120,
      mirrorLossCapBasis: 'mark',
      mirrorLossCapBaselineUsd: 100,
      mirrorLossCapPendingDrawdownUsd: -101,
      mirrorLossCapPendingAtMs: 1_000,
      mirrorLossCapTriggeredAtMs: 2_000,
      mirrorLossCapTriggeredPnlUsd: -102,
      updatedAtMs: 2_000,
    };
    saveMildDipState(file, state);
    const reloaded = loadMildDipState(file);
    expect(reloaded.mirrorTradingCashUsd).toBe(-120);
    expect(reloaded.mirrorLossCapBasis).toBe('mark');
    expect(reloaded.mirrorLossCapPendingDrawdownUsd).toBe(-101);
    expect(reloaded.mirrorLossCapTriggeredAtMs).toBe(2_000);
  });

  it('rebaselines and clears the latch when the saved threshold is stale', () => {
    const state = {
      mirrorTradingCashUsd: -900,
      mirrorLossCapBasis: 'realized',
      mirrorLossCapBaselineAtMs: 1_000,
      mirrorLossCapBaselineUsd: 100,
      mirrorLossCapTriggeredAtMs: 2_000,
      mirrorLossCapTriggeredPnlUsd: -105,
      mirrorLossCapPendingDrawdownUsd: -101,
      mirrorLossCapPendingAtMs: 1_500,
    };
    const result = syncMirrorLossCapBaseline({
      state,
      lossCapUsd: 120,
      bagsUsd: 80,
      nowMs: 3_000,
    });
    expect(result).toEqual({
      changed: true,
      reason: 'threshold_changed',
      previousLossCapUsd: 100,
    });
    expect(state).toMatchObject({
      mirrorTradingCashUsd: -80,
      mirrorLossCapBaselineAtMs: 3_000,
      mirrorLossCapBaselineUsd: 120,
    });
    expect(state.mirrorLossCapTriggeredAtMs).toBeUndefined();
    expect(state.mirrorLossCapTriggeredPnlUsd).toBeUndefined();
    expect(state.mirrorLossCapPendingDrawdownUsd).toBeUndefined();
    expect(state.mirrorLossCapPendingAtMs).toBeUndefined();
  });

  it('rebaselines a legacy baseline with no saved threshold', () => {
    const state = {
      mirrorTradingCashUsd: -900,
      mirrorLossCapBaselineAtMs: 1_000,
      mirrorLossCapTriggeredAtMs: 2_000,
      mirrorLossCapTriggeredPnlUsd: -105,
    };
    const result = syncMirrorLossCapBaseline({
      state,
      lossCapUsd: 120,
      bagsUsd: 75,
      nowMs: 3_000,
    });
    expect(result.reason).toBe('basis_changed');
    expect(result.previousLossCapUsd).toBeNull();
    expect(state.mirrorTradingCashUsd).toBe(-75);
    expect(state.mirrorLossCapBaselineUsd).toBe(120);
    expect(state.mirrorLossCapTriggeredAtMs).toBeUndefined();
  });

  it('rebaselines a legacy mark basis once and persists realized basis', () => {
    const state = {
      mirrorTradingCashUsd: -900,
      mirrorLossCapBasis: 'mark' as const,
      mirrorLossCapBaselineAtMs: 1_000,
      mirrorLossCapBaselineUsd: 150,
      mirrorLossCapTriggeredAtMs: 2_000,
      mirrorLossCapPendingDrawdownUsd: -151,
      mirrorLossCapPendingAtMs: 1_500,
    };
    const result = syncMirrorLossCapBaseline({
      state,
      lossCapUsd: 150,
      bagsUsd: 100,
      nowMs: 3_000,
    });
    expect(result).toEqual({
      changed: true,
      reason: 'basis_changed',
      previousLossCapUsd: 150,
    });
    expect(state).toMatchObject({
      mirrorTradingCashUsd: -100,
      mirrorLossCapBasis: 'realized',
      mirrorLossCapBaselineAtMs: 3_000,
      mirrorLossCapBaselineUsd: 150,
    });
    expect(state.mirrorLossCapTriggeredAtMs).toBeUndefined();
    expect(state.mirrorLossCapPendingAtMs).toBeUndefined();

    const second = syncMirrorLossCapBaseline({
      state,
      lossCapUsd: 150,
      bagsUsd: 80,
      nowMs: 4_000,
    });
    expect(second.changed).toBe(false);
    expect(state.mirrorTradingCashUsd).toBe(-100);
  });

  it('rebaselines a legacy baseline with no basis marker', () => {
    const state = {
      mirrorTradingCashUsd: -900,
      mirrorLossCapBaselineAtMs: 1_000,
      mirrorLossCapBaselineUsd: 150,
    };
    const result = syncMirrorLossCapBaseline({
      state,
      lossCapUsd: 150,
      bagsUsd: 100,
      nowMs: 3_000,
    });
    expect(result.reason).toBe('basis_changed');
    expect(state.mirrorTradingCashUsd).toBe(-100);
    expect(state.mirrorLossCapBasis).toBe('realized');
  });

  it('does not reset a baseline when the threshold is unchanged', () => {
    const state = {
      mirrorTradingCashUsd: -80,
      mirrorLossCapBasis: 'realized',
      mirrorLossCapBaselineAtMs: 1_000,
      mirrorLossCapBaselineUsd: 120,
      mirrorLossCapTriggeredAtMs: 2_000,
    };
    const result = syncMirrorLossCapBaseline({
      state,
      lossCapUsd: 120,
      bagsUsd: 95,
      nowMs: 3_000,
    });
    expect(result).toEqual({
      changed: false,
      reason: null,
      previousLossCapUsd: 120,
    });
    expect(state).toEqual({
      mirrorTradingCashUsd: -80,
      mirrorLossCapBasis: 'realized',
      mirrorLossCapBaselineAtMs: 1_000,
      mirrorLossCapBaselineUsd: 120,
      mirrorLossCapTriggeredAtMs: 2_000,
    });
  });

  it('clears the latch and baseline metadata while disabled', () => {
    const state = {
      mirrorLossCapBaselineAtMs: 1_000,
      mirrorLossCapBaselineUsd: 120,
      mirrorLossCapTriggeredAtMs: 2_000,
      mirrorLossCapTriggeredPnlUsd: -121,
      mirrorLossCapPendingDrawdownUsd: -120,
      mirrorLossCapPendingAtMs: 1_500,
    };
    const result = syncMirrorLossCapBaseline({
      state,
      lossCapUsd: 0,
      bagsUsd: 80,
      nowMs: 3_000,
    });
    expect(result.reason).toBe('disabled');
    expect(state).toMatchObject({
      mirrorLossCapBasis: 'realized',
    });
    expect(state.mirrorLossCapBaselineAtMs).toBeUndefined();
  });
});
