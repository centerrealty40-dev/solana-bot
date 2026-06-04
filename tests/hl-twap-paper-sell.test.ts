import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildHlTwapPaperDashboardRow } from '../src/hyperliquid/twap/dashboard-aggregate.js';
import { schedulePaperTrade } from '../src/hyperliquid/twap/paper-trader.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

function sig(overrides: Partial<NormalizedTwapSignal>): NormalizedTwapSignal {
  return {
    hash: '0xsell',
    twapId: null,
    user: '0xwhale',
    side: 'sell',
    coin: 'ATOM',
    displaySymbol: 'ATOM',
    isSpot: false,
    size: 5000,
    minutes: 15,
    randomize: true,
    reduceOnly: false,
    notionalUsd: 18_000,
    midPx: 1.81,
    dayNtlVlmUsd: 679_000,
    volumeSharePct: 2.66,
    startedAtMs: Date.UTC(2026, 5, 4, 14, 3, 0),
    block: 1,
    ended: null,
    ...overrides,
  };
}

describe('hl-twap paper sell reversal', () => {
  it('schedulePaperTrade writes sell schedule to journal', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-paper-sell-'));
    const fp = path.join(tmpDir, 'paper.jsonl');
    process.env.HL_TWAP_PAPER_JSONL = fp;

    schedulePaperTrade(sig({}));

    const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!) as { kind: string; side: string };
    expect(row.kind).toBe('schedule');
    expect(row.side).toBe('sell');

    delete process.env.HL_TWAP_PAPER_JSONL;
  });

  it('dashboard shows open SHORT rows', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-paper-sell-dash-'));
    const fp = path.join(tmpDir, 'paper.jsonl');
    const t0 = Date.UTC(2026, 5, 4, 14, 3, 0);
    fs.writeFileSync(
      fp,
      JSON.stringify({
        kind: 'open',
        ts: t0 + 35_000,
        hash: '0xsellopen',
        coin: 'ATOM',
        displaySymbol: 'ATOM',
        side: 'sell',
        entryPx: 1.81,
        notionalUsd: 1000,
        impactPct: 2.66,
        whaleUser: '0xwhale',
        minutes: 15,
        paperOpenAtMs: t0 + 30_000,
        paperCloseAtMs: t0 + 15 * 60_000 - 30_000,
        twapStartMs: t0,
      }) + '\n',
      'utf8',
    );

    const row = await buildHlTwapPaperDashboardRow(fp);
    expect(row.openCount).toBe(1);
    const open = (row.open as { side: string; symbol: string }[])[0];
    expect(open?.side).toBe('sell');
    expect(open?.symbol).toBe('ATOM');
  });
});
