import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBasePulseForDashboard } from '../scripts-tmp/basepulse-dashboard.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  delete process.env.DASHBOARD_BASEPULSE_TAIL_BYTES;
  delete process.env.DASHBOARD_BASEPULSE_FULL_SCAN_MAX_BYTES;
});

describe('loadBasePulseForDashboard', () => {
  it('shows only the latest open token after close+reopen', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    const tokenA = '0xaaaa0000000000000000000000000000000001';
    const tokenB = '0x9126236476efba9ad8ab77855c60eb5bf37586eb';
    const rows = [
      JSON.stringify({
        type: 'live_open',
        kind: 'open',
        token: tokenA,
        pair: '0xpairA',
        positionUsd: 10,
        fillPriceUsd: 1,
        ts: 1_000_000,
      }),
      JSON.stringify({
        type: 'live_close',
        kind: 'close',
        token: tokenA,
        pair: '0xpairA',
        exitReason: 'timeout',
        pnlPct: -1,
        pnlUsd: -0.1,
        ts: 2_000_000,
      }),
      JSON.stringify({
        type: 'live_open',
        kind: 'open',
        token: tokenB,
        pair: '0xpairB',
        symbol: 'CHECK',
        positionUsd: 10,
        fillPriceUsd: 0.03,
        ts: 3_000_000,
      }),
    ];
    fs.writeFileSync(fp, `${rows.join('\n')}\n`, 'utf8');

    const load = loadBasePulseForDashboard(fp);
    expect(load.open).toHaveLength(1);
    expect(load.open[0]?.symbol).toBe('CHECK');
    expect(load.open[0]?.mint.toLowerCase()).toBe(tokenB);
    expect(load.closed).toHaveLength(1);
  });

  it('full scan resolves open state when close predates tail window', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-tail-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    const tokenA = '0xaaaa0000000000000000000000000000000001';
    const tokenB = '0x9126236476efba9ad8ab77855c60eb5bf37586eb';
    const pad = 'x'.repeat(400);
    const head = [
      JSON.stringify({
        type: 'live_open',
        kind: 'open',
        token: tokenA,
        pair: '0xpairA',
        positionUsd: 10,
        fillPriceUsd: 1,
        ts: 1_000_000,
      }),
      JSON.stringify({
        type: 'live_close',
        kind: 'close',
        token: tokenA,
        pair: '0xpairA',
        exitReason: 'timeout',
        pnlPct: 0,
        pnlUsd: 0,
        ts: 2_000_000,
      }),
    ];
    const filler = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({ type: 'quality_skip', kind: 'eval-skip-open', pad, i, ts: `2026-06-28T21:${String(i % 60).padStart(2, '0')}:00.000Z` }),
    );
    const tail = [
      JSON.stringify({
        type: 'live_open',
        kind: 'open',
        token: tokenA,
        pair: '0xpairA',
        positionUsd: 10,
        fillPriceUsd: 1,
        ts: 9_000_000,
      }),
      JSON.stringify({
        type: 'live_close',
        kind: 'close',
        token: tokenA,
        pair: '0xpairA',
        exitReason: 'timeout',
        pnlPct: 0,
        pnlUsd: 0,
        ts: 9_500_000,
      }),
      JSON.stringify({
        type: 'live_open',
        kind: 'open',
        token: tokenB,
        pair: '0xpairB',
        symbol: 'CHECK',
        positionUsd: 10,
        fillPriceUsd: 0.03,
        ts: 10_000_000,
      }),
    ];
    fs.writeFileSync(fp, `${[...head, ...filler, ...tail].join('\n')}\n`, 'utf8');

    const load = loadBasePulseForDashboard(fp);
    expect(load.open.map((o) => o.symbol)).toEqual(['CHECK']);
  });
});
