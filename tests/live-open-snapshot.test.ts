import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  applyLiveOpenSnapshotEvent,
  configureLiveOpenSnapshot,
  emptyLiveOpenSnapshot,
  isLiveOpenSnapshotFresh,
  mergeLiveOpenSnapshotIntoBootReplay,
  readLiveOpenSnapshot,
  writeLiveOpenSnapshotFromMap,
  type LiveOpenSnapshot,
} from '../src/live/open-snapshot.js';
import {
  mergeLiveOscarOpenSnapshotIntoLoad,
  paper2OpenItemFromLiveOpenTrade,
} from '../scripts-tmp/dashboard-server.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
  configureLiveOpenSnapshot({ path: '/dev/null', strategyId: 'live-oscar' });
});

function mkOpen(mint: string, entryTs: number): OpenTrade {
  return {
    mint,
    symbol: 'TEST',
    lane: 'live',
    source: 'dip',
    metricType: 'price',
    dex: 'pump',
    entryTs,
    entryMcUsd: 100_000,
    entryMetrics: null,
    peakMcUsd: 100_000,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ reason: 'entry', sizeUsd: 100, price: 0.001, marketPrice: 0.001, ts: entryTs }],
    partialSells: [],
    totalInvestedUsd: 100,
    avgEntry: 0.001,
    avgEntryMarket: 0.001,
    remainingFraction: 1,
    dcaUsedLevels: [],
    dcaUsedIndices: [],
    ladderUsedLevels: [],
    ladderUsedIndices: [],
    pairAddress: null,
    entryLiqUsd: null,
    dcaLastEvalDropFromFirstPct: null,
    liqWatchConsecutiveFailures: 0,
    liqWatchLastLiqUsd: null,
    liqWatchLastDropPct: null,
    lastObservedPriceUsd: 0.001,
    tokenDecimals: 6,
  };
}

describe('live open snapshot', () => {
  it('writes and reads open positions from map', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-snap-'));
    const fp = path.join(tmpDir, 'live-oscar-open-snapshot.json');
    configureLiveOpenSnapshot({ path: fp, strategyId: 'live-oscar' });

    const open = new Map<string, OpenTrade>([
      ['MintA', mkOpen('MintA', 1000)],
      ['MintB', mkOpen('MintB', 2000)],
    ]);
    writeLiveOpenSnapshotFromMap(open);

    const snap = readLiveOpenSnapshot(fp);
    expect(snap?.openCount).toBe(2);
    expect(snap?.positions.map((p) => p.mint)).toEqual(['MintB', 'MintA']);
  });

  it('applies live_position_open and live_position_close incrementally', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-snap-'));
    const fp = path.join(tmpDir, 'live-oscar-open-snapshot.json');
    configureLiveOpenSnapshot({ path: fp, strategyId: 'live-oscar' });

    applyLiveOpenSnapshotEvent({
      kind: 'live_position_open',
      mint: 'MintA',
      openTrade: { mint: 'MintA', symbol: 'A', entryTs: 1, entryMcUsd: 1, totalInvestedUsd: 10 },
    });
    applyLiveOpenSnapshotEvent({
      kind: 'live_position_open',
      mint: 'MintB',
      openTrade: { mint: 'MintB', symbol: 'B', entryTs: 2, entryMcUsd: 2, totalInvestedUsd: 20 },
    });
    expect(readLiveOpenSnapshot(fp)?.openCount).toBe(2);

    applyLiveOpenSnapshotEvent({
      kind: 'live_position_close',
      mint: 'MintA',
      closedTrade: { mint: 'MintA', exitTs: 3 },
    });
    expect(readLiveOpenSnapshot(fp)?.openCount).toBe(1);
    expect(readLiveOpenSnapshot(fp)?.positions[0]?.mint).toBe('MintB');
  });

  it('detects stale snapshots', () => {
    const snap = emptyLiveOpenSnapshot();
    snap.updatedAtMs = Date.now() - 60_000;
    expect(isLiveOpenSnapshotFresh(snap, 30_000)).toBe(false);
    expect(isLiveOpenSnapshotFresh(snap, 120_000)).toBe(true);
  });

  it('merges pre-boot snapshot into truncated tail replay', () => {
    const openA = mkOpen('MintA', 1000);
    const openB = mkOpen('MintB', 2000);
    const snap: LiveOpenSnapshot = {
      version: 1,
      strategyId: 'live-oscar',
      updatedAtMs: Date.now(),
      openCount: 2,
      positions: [
        { mint: 'MintA', openTrade: { mint: 'MintA', symbol: 'A', entryTs: 1000, entryMcUsd: 1, totalInvestedUsd: 10 } },
        { mint: 'MintB', openTrade: { mint: 'MintB', symbol: 'B', entryTs: 2000, entryMcUsd: 2, totalInvestedUsd: 20 } },
      ],
    };
    const replayOpen = new Map<string, OpenTrade>([['MintC', mkOpen('MintC', 3000)]]);
    const merged = mergeLiveOpenSnapshotIntoBootReplay(
      {
        open: replayOpen,
        replaySeenMints: new Set(['MintC']),
        journalTruncated: true,
      },
      snap,
    );
    expect(merged.restoredMints).toEqual(['MintA', 'MintB']);
    expect([...merged.open.keys()].sort()).toEqual(['MintA', 'MintB', 'MintC']);
  });

  it('does not resurrect snapshot mint closed in tail replay window', () => {
    const snap: LiveOpenSnapshot = {
      version: 1,
      strategyId: 'live-oscar',
      updatedAtMs: Date.now(),
      openCount: 1,
      positions: [
        { mint: 'MintX', openTrade: { mint: 'MintX', symbol: 'X', entryTs: 1, entryMcUsd: 1, totalInvestedUsd: 10 } },
      ],
    };
    const merged = mergeLiveOpenSnapshotIntoBootReplay(
      {
        open: new Map(),
        replaySeenMints: new Set(['MintX']),
        journalTruncated: true,
      },
      snap,
    );
    expect(merged.restoredMints).toEqual([]);
    expect(merged.skippedSeenInReplay).toEqual(['MintX']);
    expect(merged.open.size).toBe(0);
  });
});

describe('mergeLiveOscarOpenSnapshotIntoLoad', () => {
  it('replaces tail-replay open list when snapshot is fresh', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-dash-'));
    const fp = path.join(tmpDir, 'live-oscar-open-snapshot.json');
    configureLiveOpenSnapshot({ path: fp, strategyId: 'live-oscar' });

    writeLiveOpenSnapshotFromMap(
      new Map([
        ['MintA', mkOpen('MintA', 1000)],
        ['MintB', mkOpen('MintB', 2000)],
        ['MintC', mkOpen('MintC', 3000)],
        ['MintD', mkOpen('MintD', 4000)],
      ]),
    );

    const merged = mergeLiveOscarOpenSnapshotIntoLoad(
      {
        open: [{ ...paper2OpenItemFromLiveOpenTrade('OnlyTail', { symbol: 'X', entryTs: 1 }) }],
        closed: [],
        firstTs: 1,
        lastTs: 2,
        resetTs: 0,
        evals1h: 0,
        passed1h: 0,
        failReasons: [],
        openTimelines: new Map(),
        hbOpen: 3,
        hbClosed: 0,
      },
      fp,
      24 * 3_600_000,
    );

    expect(merged.open.map((o) => o.mint)).toEqual(['MintD', 'MintC', 'MintB', 'MintA']);
    expect(merged.hbOpen).toBe(3);
  });
});
