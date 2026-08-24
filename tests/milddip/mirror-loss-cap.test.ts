import { describe, expect, it } from 'vitest';
import {
  buyCashDeltaUsd,
  confirmLossCapObservation,
  mirrorOpenMarkValueUsd,
  sellCashDeltaUsd,
  syncMirrorLossCapBaseline,
} from '../../src/milddip/mirror-loss-cap.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMildDipState, saveMildDipState } from '../../src/milddip/state.js';

describe('mirror loss cap cash and mark accounting', () => {
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
    expect(reloaded.mirrorLossCapPendingDrawdownUsd).toBe(-101);
    expect(reloaded.mirrorLossCapTriggeredAtMs).toBe(2_000);
  });

  it('rebaselines and clears the latch when the saved threshold is stale', () => {
    const state = {
      mirrorTradingCashUsd: -900,
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
    expect(result.reason).toBe('unknown_threshold');
    expect(result.previousLossCapUsd).toBeNull();
    expect(state.mirrorTradingCashUsd).toBe(-75);
    expect(state.mirrorLossCapBaselineUsd).toBe(120);
    expect(state.mirrorLossCapTriggeredAtMs).toBeUndefined();
  });

  it('does not reset a baseline when the threshold is unchanged', () => {
    const state = {
      mirrorTradingCashUsd: -80,
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
    expect(state).toEqual({});
  });
});
