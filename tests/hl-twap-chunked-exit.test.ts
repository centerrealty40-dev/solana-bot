import { describe, expect, it } from 'vitest';

import {
  buildExitScheduleAnchor,
  chunkedExitEnabled,
  exitScheduleTriggerMs,
  exitSliceCountForSide,
  exitSliceDueAtMs,
  exitWindowMs,
  firstWhaleSliceIndexAtOrAfter,
  loadChunkedExitConfig,
  nextDueSliceIndex,
  resolveExitScheduleAnchor,
  sliceTargetBase,
  vwapExitPx,
  whaleAlignedExitAtMs,
  whaleSliceBoundaryMs,
} from '../src/hyperliquid/twap/live/chunked-exit.js';
import { isShortTwapMinutes } from '../src/hyperliquid/twap/twap-duration.js';
import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
import { loadPendingLiveExits } from '../src/hyperliquid/twap/live/journal.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('chunked-exit', () => {
  const twapStart = 1_000_000;
  const interval = 30_000;

  it('whale slice boundaries match HL 30s cycles', () => {
    expect(whaleSliceBoundaryMs(twapStart, 1, interval)).toBe(twapStart + 30_000);
    expect(whaleSliceBoundaryMs(twapStart, 2, interval)).toBe(twapStart + 60_000);
  });

  it('firstWhaleSliceIndexAtOrAfter aligns to next whale tick', () => {
    expect(firstWhaleSliceIndexAtOrAfter(twapStart, twapStart, interval)).toBe(1);
    expect(firstWhaleSliceIndexAtOrAfter(twapStart, twapStart + 30_000, interval)).toBe(1);
    expect(firstWhaleSliceIndexAtOrAfter(twapStart, twapStart + 30_001, interval)).toBe(2);
    expect(firstWhaleSliceIndexAtOrAfter(twapStart, twapStart + 90_000, interval)).toBe(3);
  });

  it('exit slices fire on whale TWAP ticks after trigger', () => {
    const trigger = twapStart + 45_000; // between k=1 and k=2
    const anchor = buildExitScheduleAnchor(twapStart, trigger, trigger, interval);
    expect(anchor.firstWhaleSliceIndex).toBe(2);
    expect(exitSliceDueAtMs(anchor, 0)).toBe(twapStart + 60_000);
    expect(exitSliceDueAtMs(anchor, 1)).toBe(twapStart + 90_000);
    expect(whaleAlignedExitAtMs(twapStart, 2, 0, interval)).toBe(twapStart + 60_000);
  });

  it('nextDueSliceIndex waits for whale boundary', () => {
    const trigger = twapStart + 45_000;
    const anchor = buildExitScheduleAnchor(twapStart, trigger, trigger, interval);
    expect(nextDueSliceIndex(anchor, 0, 10, twapStart + 59_999)).toBeNull();
    expect(nextDueSliceIndex(anchor, 0, 10, twapStart + 60_000)).toBe(0);
    expect(nextDueSliceIndex(anchor, 1, 10, twapStart + 90_000)).toBe(1);
  });

  it('sliceTargetBase splits remaining evenly', () => {
    expect(sliceTargetBase(100, 0, 5)).toBe(20);
    expect(sliceTargetBase(80, 1, 5)).toBe(20);
  });

  it('vwapExitPx weights by size', () => {
    expect(vwapExitPx([
      { fillPx: 100, sizeBase: 1 },
      { fillPx: 110, sizeBase: 1 },
    ])).toBe(105);
  });

  it('exitSliceCountForSide: long fewer than short by default', () => {
    const cfg = loadHlTwapLiveConfig();
    expect(exitSliceCountForSide('buy', cfg)).toBe(cfg.exitSlicesLong);
    expect(exitSliceCountForSide('sell', cfg)).toBe(cfg.exitSlicesShort);
    expect(loadChunkedExitConfig(cfg, 'buy').sliceCount).toBe(cfg.exitSlicesLong);
    expect(loadChunkedExitConfig(cfg, 'sell').sliceCount).toBe(cfg.exitSlicesShort);
  });

  it('isShortTwapMinutes: short lane 9–14m; ultra-short <9m and long ≥16m excluded', () => {
    process.env.HL_TWAP_SHORT_ENABLED = '1';
    expect(isShortTwapMinutes(10)).toBe(true);
    expect(isShortTwapMinutes(5)).toBe(false);
    expect(isShortTwapMinutes(16)).toBe(false);
  });

  it('chunkedExitEnabled when sliceCount > 1', () => {
    expect(chunkedExitEnabled({ sliceCount: 1, sliceIntervalMs: 30_000 })).toBe(false);
    expect(chunkedExitEnabled({ sliceCount: 10, sliceIntervalMs: 30_000 })).toBe(true);
  });

  it('exitWindowMs for N slices', () => {
    expect(exitWindowMs(10, 30_000)).toBe(270_000);
  });

  it('exitScheduleTriggerMs: early exit uses now, timer exit uses liveCloseAtMs', () => {
    const liveClose = 10_000_000;
    const startedEarly = 1_000_000;
    const startedAtTimer = 10_000_500;
    expect(exitScheduleTriggerMs(startedEarly, liveClose)).toBe(startedEarly);
    expect(exitScheduleTriggerMs(startedAtTimer, liveClose)).toBe(startedAtTimer);
  });

  it('resolveExitScheduleAnchor repairs far-future whale alignment on stale exit_start', () => {
    const startedAtMs = 5_000_000;
    const interval = 30_000;
    const twapStart = 1_000_000;
    const stale = resolveExitScheduleAnchor({
      twapStartMs: twapStart,
      firstWhaleSliceIndex: 200,
      startedAtMs,
      sliceIntervalMs: interval,
      slicesSent: 0,
    });
    expect(stale.twapStartMs).toBeUndefined();
    expect(exitSliceDueAtMs(stale, 0)).toBe(startedAtMs);
    expect(nextDueSliceIndex(stale, 0, 3, startedAtMs)).toBe(0);

    const dueSoon = buildExitScheduleAnchor(twapStart, startedAtMs, startedAtMs, interval);
    const kept = resolveExitScheduleAnchor({
      ...dueSoon,
      slicesSent: 0,
    });
    expect(kept.firstWhaleSliceIndex).toBe(dueSoon.firstWhaleSliceIndex);
  });

  it('loadPendingLiveExits recovers whale-aligned exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-exit-'));
    const file = path.join(dir, 'live.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          kind: 'open',
          ts: 1,
          hash: '0xabc',
          coin: 'BTC',
          displaySymbol: 'BTC',
          side: 'buy',
          entryAnchorPx: 1,
          avgEntryPx: 1,
          initialNotionalUsd: 100,
          currentNotionalUsd: 100,
          whaleUser: '0x1',
          minutes: 30,
          liveOpenAtMs: 1,
          liveCloseAtMs: 2,
          twapStartMs: 1_000_000,
          tpLevelsTaken: 0,
          dcaLevelsTaken: 0,
        }),
        JSON.stringify({
          kind: 'exit_start',
          ts: 100,
          hash: '0xabc',
          exitReason: 'twap_early_exit',
          sliceCount: 5,
          sliceIntervalMs: 30_000,
          startedAtMs: 1_045_000,
          exitStartNotionalUsd: 100,
          twapStartMs: 1_000_000,
          firstWhaleSliceIndex: 2,
        }),
      ].join('\n') + '\n',
    );
    const pending = loadPendingLiveExits(file);
    const p = pending.get('0xabc')!;
    expect(p.firstWhaleSliceIndex).toBe(2);
    expect(p.twapStartMs).toBe(1_000_000);
  });
});
