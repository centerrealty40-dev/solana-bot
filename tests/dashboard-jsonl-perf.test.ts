import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateLiveOscarJsonlForDashboard,
  dashboardJsonlLineFastSkip,
  dashboardRecentClosedLimit,
  loadLiveOscarJsonlAsPaper2,
  loadLiveOscarOpensOnlyFromSnapshot,
  selectRecentClosedRowsForDashboard,
} from '../scripts-tmp/dashboard-server.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

describe('dashboardJsonlLineFastSkip', () => {
  it('skips live discovery audit kinds before JSON.parse', () => {
    expect(
      dashboardJsonlLineFastSkip(
        JSON.stringify({ kind: 'live_discovery_eval', channel: 'live', mint: 'x' }),
      ),
    ).toBe(true);
    expect(
      dashboardJsonlLineFastSkip(
        JSON.stringify({ kind: 'live_discovery_tick_skip', channel: 'live', mint: 'x' }),
      ),
    ).toBe(true);
    expect(
      dashboardJsonlLineFastSkip(
        JSON.stringify({ kind: 'live_position_open', channel: 'live', mint: 'x' }),
      ),
    ).toBe(false);
  });
});

describe('dashboardRecentClosedLimit', () => {
  it('defaults to a positive limit', () => {
    expect(dashboardRecentClosedLimit()).toBeGreaterThan(0);
  });
});

describe('loadLiveOscarJsonlAsPaper2 skip discovery eval', () => {
  it('still parses opens when journal is mostly discovery_eval noise', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-perf-'));
    const fp = path.join(tmpDir, 'live.jsonl');
    const base = Date.now() - 120_000;
    const mint = 'So11111111111111111111111111111111111111112';
    const lines: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      lines.push(
        JSON.stringify({
          ts: base + i,
          channel: 'live',
          kind: 'live_discovery_eval',
          pass: false,
          mint: `NoiseMint${i}`,
          reasons: ['test'],
        }),
      );
    }
    lines.push(
      JSON.stringify({
        ts: base + 600_000,
        channel: 'live',
        kind: 'live_position_open',
        mint,
        openTrade: {
          symbol: 'TEST',
          entryTs: base + 600_000,
          entryMcUsd: 1,
          totalInvestedUsd: 100,
          legs: [{ sizeUsd: 100, marketPrice: 1 }],
        },
      }),
    );
    fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');

    const ll = loadLiveOscarJsonlAsPaper2(fp);
    expect(ll.open.some((o) => o.mint === mint)).toBe(true);
    const agg = aggregateLiveOscarJsonlForDashboard(fp);
    expect(agg.openCount).toBeGreaterThanOrEqual(1);
  });
});

describe('loadLiveOscarOpensOnlyFromSnapshot', () => {
  it('returns opens from fresh sidecar without parsing journal', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-snap-'));
    const jsonl = path.join(tmpDir, 'live.jsonl');
    const snapPath = path.join(tmpDir, 'live-oscar-open-snapshot.json');
    fs.writeFileSync(
      jsonl,
      JSON.stringify({
        ts: Date.now(),
        channel: 'live',
        kind: 'live_position_open',
        mint: 'ShouldNotParseMint111111111111111111111',
        openTrade: { symbol: 'NO', entryTs: 1, legs: [{ sizeUsd: 1 }] },
      }) + '\n',
      'utf8',
    );
    const mint = 'SnapMint111111111111111111111111111111';
    fs.writeFileSync(
      snapPath,
      JSON.stringify({
        version: 1,
        strategyId: 'live-oscar',
        updatedAtMs: Date.now(),
        openCount: 1,
        positions: [
          {
            mint,
            openTrade: {
              symbol: 'SNAP',
              entryTs: Date.now(),
              totalInvestedUsd: 100,
              legs: [{ sizeUsd: 100, marketPrice: 1 }],
            },
          },
        ],
      }),
      'utf8',
    );

    const prevJsonl = process.env.DASHBOARD_LIVE_OSCAR_JSONL;
    const prevSnap = process.env.DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT;
    process.env.DASHBOARD_LIVE_OSCAR_JSONL = jsonl;
    process.env.DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT = snapPath;
    try {
      const load = loadLiveOscarOpensOnlyFromSnapshot(jsonl);
      expect(load).not.toBeNull();
      expect(load!.open.some((o) => o.mint === mint)).toBe(true);
      expect(load!.open.some((o) => o.mint.includes('ShouldNotParse'))).toBe(false);
    } finally {
      if (prevJsonl === undefined) delete process.env.DASHBOARD_LIVE_OSCAR_JSONL;
      else process.env.DASHBOARD_LIVE_OSCAR_JSONL = prevJsonl;
      if (prevSnap === undefined) delete process.env.DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT;
      else process.env.DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT = prevSnap;
    }
  });
});

describe('selectRecentClosedRowsForDashboard limit', () => {
  it('respects explicit small limits for UI', () => {
    const base = Date.UTC(2026, 5, 20, 12, 0, 0);
    const rows = Array.from({ length: 10 }, (_, i) => ({
      mint: `Mint${i}`,
      exitTs: base + i * 60_000,
    }));
    expect(selectRecentClosedRowsForDashboard(rows, 3)).toHaveLength(3);
    expect(selectRecentClosedRowsForDashboard(rows, 3)[0]!.exitTs).toBe(base + 9 * 60_000);
  });
});
