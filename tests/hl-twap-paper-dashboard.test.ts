import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHlTwapPaperDashboardRow,
  hlTwapDashboardJsonlPath,
} from '../src/hyperliquid/twap/dashboard-aggregate.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

describe('buildHlTwapPaperDashboardRow', () => {
  it('aggregates realized and open from paper journal', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-paper-dash-'));
    const fp = path.join(tmpDir, 'paper.jsonl');
    const t0 = Date.UTC(2026, 5, 4, 10, 0, 0);
    const openAt = t0 + 30_000;
    const closeAt = t0 + 5 * 60_000 - 30_000;
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          kind: 'open',
          ts: openAt + 1000,
          hash: 'twaphash111',
          coin: 'HYPE',
          displaySymbol: 'HYPE',
          side: 'buy',
          entryPx: 100,
          notionalUsd: 1000,
          impactPct: 1.2,
          whaleUser: '0xabc',
          minutes: 5,
          paperOpenAtMs: openAt,
          paperCloseAtMs: closeAt,
          twapStartMs: t0,
        }),
        JSON.stringify({
          kind: 'close',
          ts: closeAt,
          hash: 'twaphash111',
          exitPx: 105,
          pnlUsd: 50,
          pnlPct: 5,
          exitReason: 'before_last_cycle',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const row = await buildHlTwapPaperDashboardRow(fp);
    expect(row.strategyId).toBe('hl-twap-paper');
    expect(row.closedCount).toBe(1);
    expect(row.realizedPnlUsd).toBe(50);
    expect(row.openCount).toBe(0);
    const closed = (row.recentClosed as { pnlUsd: number; timeline: unknown[] }[])[0];
    expect(closed?.pnlUsd).toBe(50);
    expect((closed?.timeline as unknown[])?.length).toBeGreaterThanOrEqual(3);
  });

  it('aggregates live journal (avgEntryPx format)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-live-dash-'));
    const fp = path.join(tmpDir, 'live.jsonl');
    const t0 = Date.UTC(2026, 5, 5, 10, 0, 0);
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          kind: 'open',
          ts: t0 + 60_000,
          hash: 'livehash1',
          coin: 'ONDO',
          displaySymbol: 'ONDO',
          side: 'sell',
          entryAnchorPx: 0.32,
          avgEntryPx: 0.322,
          initialNotionalUsd: 500,
          currentNotionalUsd: 500,
          impactPct: 3,
          whaleUser: '0xwhale',
          minutes: 60,
          liveOpenAtMs: t0 + 55_000,
          liveCloseAtMs: t0 + 3_600_000,
          twapStartMs: t0,
          tpLevelsTaken: 0,
          dcaLevelsTaken: 0,
        }),
        JSON.stringify({
          kind: 'close',
          ts: t0 + 120_000,
          hash: 'livehash1',
          exitPx: 0.321,
          pnlUsd: 1.5,
          pnlPct: 0.3,
          exitReason: 'impact_edge_lost',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const row = await buildHlTwapPaperDashboardRow(fp);
    expect(row.closedCount).toBe(1);
    expect(row.openCount).toBe(0);
    expect(row.realizedPnlUsd).toBe(1.5);
    const closed = (row.recentClosed as { hlTwap?: { exitReasonShort?: string } }[])[0];
    expect(closed?.hlTwap?.exitReasonShort).toBe('impact edge lost');
  });

  it('defaults dashboard jsonl path to live.jsonl', () => {
    expect(hlTwapDashboardJsonlPath()).toContain('live.jsonl');
  });
});
