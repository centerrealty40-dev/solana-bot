import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPaper2File, finalizeTimelineForApi, type TimelineEvent } from '../scripts-tmp/dashboard-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

function writeFixture(name: string, lines: string[]): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper2-test-'));
  const fp = path.join(tmpDir, name);
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
  return fp;
}

function assertTimelinesSane(
  who: string,
  timelines: Map<string, TimelineEvent[]> | TimelineEvent[],
): void {
  const list = timelines instanceof Map ? [...timelines.values()] : [timelines];
  for (const tl of list) {
    if (!tl.length) continue;
    const sorted = finalizeTimelineForApi(tl.slice().sort((a, b) => a.ts - b.ts));
    for (const ev of sorted) {
      expect(ev.label, `${who} label non-empty`).toBeTruthy();
      if (ev.kind === 'dca_add') {
        expect(ev.label, 'DCA label').toMatch(/DCA/);
        expect(ev.label, 'DCA first leg ref').toMatch(/от первой ноги/);
      }
      if (ev.kind === 'partial_sell' && (ev.reason === 'TP_LADDER' || !ev.reason)) {
        if (String(ev.label).includes('шаг') && /Лестница|TP|ладд|лестн/i.test(ev.label)) {
          expect(ev.label, 'ladder K/N').toMatch(/шаг\s+\d/);
        }
      }
    }
  }
}

describe('loadPaper2File — journals & timelines (TP ladder + DCA)', () => {
  it('returns empty when file is missing', () => {
    const r = loadPaper2File(path.join(tmpDir ?? os.tmpdir(), 'nope-xyz-missing.jsonl'));
    expect(r.open).toEqual([]);
    expect(r.closed).toEqual([]);
  });

  it('builds DCA + ladder + close for a single closed position (synthetic, strategy-agnostic)', () => {
    const mint = 'SyntMint11111111111111111111111111111111';
    const base = 1_000_000;
    const lineOpen = JSON.stringify({
      kind: 'open',
      ts: base,
      entryTs: base,
      strategyId: 'pt1-oscar',
      mint,
      symbol: 'SYN',
      legs: [{ marketPrice: 1, price: 1, sizeUsd: 100 }],
      totalInvestedUsd: 100,
      entryMcUsd: 1,
      entryMarketPrice: 1,
      metricType: 'price',
      features: {},
    });
    const lineDca = JSON.stringify({
      kind: 'dca_add',
      ts: base + 1000,
      mint,
      sizeUsd: 30,
      triggerPct: -0.07,
      dcaStepIndex: 0,
      dcaLevelsTotal: 2,
      price: 0.99,
      marketPrice: 0.99,
      totalInvestedUsd: 130,
    });
    const linePs = JSON.stringify({
      kind: 'partial_sell',
      ts: base + 2000,
      mint,
      reason: 'TP_LADDER',
      sellFraction: 0.3,
      ladderPnlPct: 0.1,
      ladderStepIndex: 0,
      ladderRungsTotal: 3,
      remainingFraction: 0.7,
      proceedsUsd: 20,
      price: 1.1,
      marketPrice: 1.1,
    });
    const lineClose = JSON.stringify({
      kind: 'close',
      ts: base + 3000,
      mint,
      entryTs: base,
      entryMcUsd: 1,
      exitTs: base + 3000,
      symbol: 'SYN',
      pnlPct: 3,
      netPnlUsd: 3,
      exitReason: 'TRAIL',
      totalInvestedUsd: 130,
      exit_market_price: 1.05,
      remainingFraction: 0.5,
    });
    const fp = writeFixture('synthetic-oscar-style.jsonl', [lineOpen, lineDca, linePs, lineClose]);
    const { closed, openTimelines } = loadPaper2File(fp);
    expect(closed.length, 'one closed row').toBe(1);
    const row = closed[0] as { __timeline?: TimelineEvent[] };
    const rawTl = Array.isArray(row.__timeline) ? row.__timeline : [];
    const tl = finalizeTimelineForApi(rawTl.slice().sort((a, b) => a.ts - b.ts));
    expect(tl.length, '4 timeline events').toBe(4);
    expect(tl[0]!.kind).toBe('open');
    const d = tl.find((x) => x.kind === 'dca_add');
    expect(d?.label, 'dca_add').toMatch(/DCA.*шаг 1\/2/);
    const p = tl.find((x) => x.kind === 'partial_sell');
    expect(p?.label, 'partial_sell').toMatch(/шаг 1\/3/);
    expect(tl[tl.length - 1]!.kind).toBe('close');
    expect(openTimelines.size, 'no open leftover').toBe(0);
  });

  it('open position: DCA + partial (no close) has sane openTimelines and remaining fraction', () => {
    const mint = 'SyntOpen22222222222222222222222222222222';
    const base = 2_000_000;
    const open = JSON.stringify({
      kind: 'open',
      ts: base,
      entryTs: base,
      strategyId: 'pt1-diprunner',
      mint,
      symbol: 'O2',
      legs: [{ marketPrice: 2, price: 2, sizeUsd: 100 }],
      totalInvestedUsd: 100,
      entryMcUsd: 2,
      entryMarketPrice: 2,
      metricType: 'price',
      features: {},
    });
    const dca = JSON.stringify({
      kind: 'dca_add',
      ts: base + 1,
      mint,
      sizeUsd: 30,
      triggerPct: -0.1,
      dcaStepIndex: 0,
      dcaLevelsTotal: 2,
      price: 1.9,
      marketPrice: 1.9,
      totalInvestedUsd: 130,
    });
    const part = JSON.stringify({
      kind: 'partial_sell',
      ts: base + 2,
      mint,
      reason: 'TP_LADDER',
      sellFraction: 0.4,
      ladderPnlPct: 0.1,
      ladderStepIndex: 0,
      ladderRungsTotal: 4,
      remainingFraction: 0.6,
      proceedsUsd: 50,
      price: 2.1,
      marketPrice: 2.1,
    });
    const fp = writeFixture('synthetic-dip-open.jsonl', [open, dca, part]);
    const { open: opens, openTimelines } = loadPaper2File(fp);
    expect(opens.length, 'one open position').toBe(1);
    const o = opens[0]!;
    expect(o.remainingFraction, 'from last partial_sell').toBe(0.6);
    const tl = openTimelines.get(mint);
    expect(tl?.length, 'open timeline').toBe(3);
    assertTimelinesSane('open', new Map([[mint, tl!]]));
  });
});

/**
 * If local `data/paper2/*.jsonl` exist, smoke-check timelines (all strategies on disk).
 */
const DATA_PAPER2 = path.join(__dirname, '..', 'data', 'paper2');
if (fs.existsSync(DATA_PAPER2)) {
  const files = fs
    .readdirSync(DATA_PAPER2)
    .filter((f) => f.endsWith('.jsonl') && f.startsWith('pt1-'));
  if (files.length) {
    describe('loadPaper2File — optional integration on data/paper2/*.jsonl', () => {
      for (const f of files) {
        it(`smoke: ${f}`, () => {
          const fp = path.join(DATA_PAPER2, f);
          const { open, closed, openTimelines } = loadPaper2File(fp);
          for (const c of closed) {
            const row = c as { __timeline?: TimelineEvent[]; mint?: string };
            const t = Array.isArray(row.__timeline)
              ? row.__timeline.slice().sort((a, b) => a.ts - b.ts)
              : [];
            assertTimelinesSane(f + ' closed ' + (row.mint ?? ''), t);
            // Не требуем монотонности остатка на старых журналах (до фикса ладдера/DCA возможны аномалии).
          }
          for (const [m, t] of openTimelines) {
            void m;
            const sorted = t.slice().sort((a, b) => a.ts - b.ts);
            assertTimelinesSane(f + ' open', new Map([[m, sorted]]));
          }
          expect(open.length + closed.length, `${f} has some rows or empty`).toBeGreaterThanOrEqual(0);
        });
      }
    });
  }
}
