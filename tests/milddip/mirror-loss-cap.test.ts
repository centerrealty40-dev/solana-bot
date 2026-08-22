import { describe, expect, it } from 'vitest';
import {
  buyCashDeltaUsd,
  confirmLossCapObservation,
  mirrorOpenMarkValueUsd,
  replayMirrorTradingCash,
  sellCashDeltaUsd,
} from '../../src/milddip/mirror-loss-cap.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMildDipState, saveMildDipState } from '../../src/milddip/state.js';

describe('mirror loss cap cash and mark accounting', () => {
  it('uses cash deltas for executed buys and sells', () => {
    expect(buyCashDeltaUsd({ usdcBefore: 100, usdcAfter: 70 })).toBe(-30);
    expect(sellCashDeltaUsd({ usdcBefore: 70, usdcAfter: 90 })).toBe(20);
    expect(buyCashDeltaUsd({ quoteSpentUsd: 12 })).toBe(-12);
    expect(sellCashDeltaUsd({ quoteReceivedUsd: 8 })).toBe(8);
  });

  it('replays the trading cash component and ignores failed executions', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cap-')), 'journal.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ kind: 'copy_buy', mint: 'A', ok: true, usdcBefore: 100, usdcAfter: 50 }),
      JSON.stringify({ kind: 'copy_sell', mint: 'A', ok: true, usdcBefore: 50, usdcAfter: 70 }),
      JSON.stringify({ kind: 'copy_buy', mint: 'A', ok: false, usdcBefore: 70, usdcAfter: 60 }),
    ].join('\n'));
    expect(replayMirrorTradingCash(file)).toBe(-30);
  });

  it('falls back to the position cost when no confirmed mark exists', () => {
    expect(mirrorOpenMarkValueUsd({
      sizeUsd: 40,
      entryPriceUsd: 2,
      tokenRaw: '20',
    })).toBe(40);
    expect(mirrorOpenMarkValueUsd({
      sizeUsd: 40,
      entryPriceUsd: 2,
      tokenRaw: '20',
    }, 1.5)).toBe(30);
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
      mirrorLossCapBackfilled: true,
      mirrorLossCapBackfillVersion: 2,
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
});
