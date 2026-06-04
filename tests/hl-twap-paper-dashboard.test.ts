import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildHlTwapPaperDashboardRow } from '../src/hyperliquid/twap/dashboard-aggregate.js';

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
});
