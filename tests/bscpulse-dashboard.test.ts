import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bscPulseDexScreenerUrl, loadBscPulseForDashboard } from '../scripts-tmp/bscpulse-dashboard.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

/** Realistic fixture lines from prod BscPulse journal (72.62.152.201). */
const PROD_LIVE_OPEN = {
  type: 'live_open',
  kind: 'open',
  pair: '0xbc42145d5a574ede9b8860fca2a49eb7b239efa5',
  token: '0x92aa03137385f18539301349dcfc9ebc923ffb10',
  priceUsd: 0.352066629998303,
  spotPxUsd: 0.352066629998303,
  sizeBnb: 0.017764513607617424,
  positionUsd: 10,
  dropPct: 3.402,
  txHash: '0xec0424449d26cf1f5a1a26b56c4b818308a412ed16fedcc25f74d8baeef5e112',
  ts: 1782559028572,
};

const PROD_LIVE_CLOSE = {
  type: 'live_close',
  kind: 'close',
  id: '1',
  pair: '0x44dfec2cfa2bcf21b9d5f4d0bb383f69c2a2e1f8',
  token: '0xe89b607c551ae413907fe428e82873af430e95c6',
  reason: 'manual_force_close',
  exitReason: 'manual_force_close',
  pnlPct: -100,
  pnlUsd: -10,
  txHash: '0xf03c27de1e581c2002130e87cc6bc95d716d548860b8e2940ee7d506701975d0',
  ts: 1782554000745,
};

const PROD_FILTER_REJECT = {
  type: 'filter_reject',
  kind: 'eval-skip-open',
  reason: 'not_large_cap',
  pair: '0xc2e72a2e26347fe540451ea7ab0fea0cfc5ec866',
  token: '0xf916c5a30c3e3921c706b06c102078bce3c03479',
  dropPct: 6.136,
  liquidityUsd: 30191.7979,
  fdvUsd: 118054.5362,
  ts: '2026-06-27T11:30:42.707Z',
};

const PROD_PARTIALS = [
  {
    type: 'live_partial',
    kind: 'partial_exit',
    token: PROD_LIVE_OPEN.token,
    pair: PROD_LIVE_OPEN.pair,
    fraction: 0.05,
    reason: 'tp',
    exitReason: 'tp',
    pnlPct: 4.6,
    ts: 1782564719843,
  },
  {
    type: 'live_partial',
    kind: 'partial_exit',
    token: PROD_LIVE_OPEN.token,
    pair: PROD_LIVE_OPEN.pair,
    fraction: 0.2,
    reason: 'trail',
    exitReason: 'trail',
    pnlPct: -16.3,
    ts: 1782570469580,
  },
];

function writeJournal(fp: string, lines: unknown[]): void {
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

describe('loadBscPulseForDashboard', () => {
  it('builds DexScreener BSC URL (pair preferred, token fallback)', () => {
    const token = '0x92aa03137385f18539301349dcfc9ebc923ffb10';
    const pair = '0xbc42145d5a574ede9b8860fca2a49eb7b239efa5';
    expect(bscPulseDexScreenerUrl(token, pair)).toBe(
      `https://dexscreener.com/bsc/${encodeURIComponent(pair)}`,
    );
    expect(bscPulseDexScreenerUrl(token)).toBe(
      `https://dexscreener.com/bsc/${encodeURIComponent(token)}`,
    );
  });

  it('returns empty load when journal file is missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'missing.jsonl');
    const r = loadBscPulseForDashboard(fp);
    expect(r.open).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.failReasons).toEqual([]);
  });

  it('parses prod live_open into Paper2OpenItem with mint, symbol, baselinePriceUsd', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    writeJournal(fp, [PROD_LIVE_OPEN]);

    const r = loadBscPulseForDashboard(fp);
    expect(r.open.length).toBe(1);
    const o = r.open[0]!;
    expect(o.mint).toBe(PROD_LIVE_OPEN.token);
    expect(o.symbol).toBe('?');
    expect(o.baselinePriceUsd).toBeCloseTo(0.352066629998303);
    expect(o.totalInvestedUsd).toBe(10);
    expect(o.lane).toBe('bsc-pulse');
    expect(o.source).toBe('bsc');
    expect(o.metricType).toBe('price');
    expect(o.pairAddress).toBe(PROD_LIVE_OPEN.pair);
    expect(r.openTimelines.get(o.mint)?.length).toBe(1);
    expect(r.openTimelines.get(o.mint)?.[0]?.kind).toBe('open');
  });

  it('parses live_open + live_close cycle with closed trade stats fields', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    const openEv = {
      ...PROD_LIVE_OPEN,
      token: '0xe89b607c551ae413907fe428e82873af430e95c6',
      pair: '0x44dfec2cfa2bcf21b9d5f4d0bb383f69c2a2e1f8',
      spotPxUsd: 0.000230886247379533,
      priceUsd: 0.000230886247379533,
      ts: 1782553446607,
    };
    writeJournal(fp, [openEv, PROD_LIVE_CLOSE]);

    const r = loadBscPulseForDashboard(fp);
    expect(r.open.length).toBe(0);
    expect(r.closed.length).toBe(1);
    const c = r.closed[0]!;
    expect(c.mint).toBe('0xe89b607c551ae413907fe428e82873af430e95c6');
    expect(c.symbol).toBeTruthy();
    expect(c.exitReason).toBe('manual_force_close');
    expect(c.pnlPct).toBe(-100);
    expect(c.pnlUsd).toBe(-10);
    expect(c.durationMin).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(c.__timeline)).toBe(true);
    expect(c.pairAddress).toBe('0x44dfec2cfa2bcf21b9d5f4d0bb383f69c2a2e1f8');
  });

  it('counts filter_reject as eval-skip-open fail reasons', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    writeJournal(fp, [{ ...PROD_FILTER_REJECT, ts: Date.now() - 60_000 }]);

    const r = loadBscPulseForDashboard(fp);
    expect(r.evals1h).toBeGreaterThanOrEqual(1);
    expect(r.failReasons.some((f) => f.reason === 'not_large_cap')).toBe(true);
  });

  it('tracks live_partial remainingFraction and timeline events', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    writeJournal(fp, [PROD_LIVE_OPEN, ...PROD_PARTIALS]);

    const r = loadBscPulseForDashboard(fp);
    expect(r.open.length).toBe(1);
    const o = r.open[0]!;
    expect(o.remainingFraction).toBeCloseTo(0.76, 5);
    const tl = r.openTimelines.get(o.mint) ?? [];
    expect(tl.filter((e) => e.kind === 'partial_sell').length).toBe(2);
    expect(tl.some((e) => e.pnlPct != null)).toBe(true);
  });

  it('uses symbol from journal when present', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    writeJournal(fp, [{ ...PROD_LIVE_OPEN, symbol: 'UB' }]);

    const r = loadBscPulseForDashboard(fp);
    expect(r.open[0]!.symbol).toBe('UB');
  });

  it('resolves baseTokenAddress when token field is absent', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    const addr = '0xdef4567890123456789012345678901234567890';
    writeJournal(fp, [
      {
        type: 'live_open',
        kind: 'open',
        baseTokenAddress: addr,
        symbol: 'BEAT',
        spotPxUsd: 0.05,
        positionUsd: 10,
        ts: Date.now() - 60_000,
      },
    ]);

    const r = loadBscPulseForDashboard(fp);
    expect(r.open.length).toBe(1);
    expect(r.open[0]!.mint).toBe(addr);
    expect(r.open[0]!.symbol).toBe('BEAT');
  });
});
