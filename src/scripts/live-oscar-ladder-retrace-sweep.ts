/**
 * Counterfactual sweep: ladder_retrace trail floor variants vs journal closes.
 *
 * Filters lifecycles with >= N partial sells tagged TP_LADDER (journal replay path).
 * Re-simulates exit logic on interpolated anchors (same limitation as paper2-strategy-backtest).
 *
 * Usage (repo root, load `.env` / LIVE_INHERIT so PAPER_* matches prod):
 *   npx tsx src/scripts/live-oscar-ladder-retrace-sweep.ts --jsonl data/live/pt1-oscar-live.jsonl
 *   npx tsx src/scripts/live-oscar-ladder-retrace-sweep.ts --jsonl path.jsonl --step-ms 60000 --winners-only
 *
 * Env:
 *   LIVE_TELEGRAM_* ignored here.
 *   Disable Telegram heartbeat separately: LIVE_TELEGRAM_HEARTBEAT=0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import type { LadderRetraceSpec } from '../papertrader/executor/tp-ladder-state.js';
import {
  anchorsFromJournalEvents,
  cloneOpenFromJournal,
  readJournalLifecycles,
  simulateLifecycle,
  type JournalLifecycle,
} from './paper2-strategy-backtest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function countTpLadderHits(lc: JournalLifecycle): number {
  let n = 0;
  for (const e of lc.events) {
    if (e.kind === 'partial_sell' && String((e as { reason?: unknown }).reason ?? '') === 'TP_LADDER') n++;
  }
  return n;
}

function actualNetFromClose(lc: JournalLifecycle): number {
  return Number((lc.close as { netPnlUsd?: unknown }).netPnlUsd ?? 0);
}

function exitReason(lc: JournalLifecycle): string {
  return String((lc.close as { exitReason?: unknown }).exitReason ?? '');
}

type LabeledSpec = { label: string; spec: LadderRetraceSpec };

/** Peak sorted index 3 = «четвёртая ступень» при 0-based нумерации в отсортированном ладдере. */
function buildSweepMatrix(): LabeledSpec[] {
  return [
    { label: 'baseline', spec: { kind: 'baseline' } },
    { label: 'from_r4_skip1', spec: { kind: 'adaptive', minPeakSortedIdx: 3, extraSkipRungs: 1 } },
    { label: 'from_r5_skip1', spec: { kind: 'adaptive', minPeakSortedIdx: 4, extraSkipRungs: 1 } },
    { label: 'from_r6_skip1', spec: { kind: 'adaptive', minPeakSortedIdx: 5, extraSkipRungs: 1 } },
    { label: 'from_r4_skip2', spec: { kind: 'adaptive', minPeakSortedIdx: 3, extraSkipRungs: 2 } },
    { label: 'from_r5_skip2', spec: { kind: 'adaptive', minPeakSortedIdx: 4, extraSkipRungs: 2 } },
    {
      label: 'from_r4_skip1_b075',
      spec: { kind: 'adaptive', minPeakSortedIdx: 3, extraSkipRungs: 1, blendWideFrac: 0.75 },
    },
    {
      label: 'from_r4_skip1_b050',
      spec: { kind: 'adaptive', minPeakSortedIdx: 3, extraSkipRungs: 1, blendWideFrac: 0.5 },
    },
    {
      label: 'from_r4_skip1_b025',
      spec: { kind: 'adaptive', minPeakSortedIdx: 3, extraSkipRungs: 1, blendWideFrac: 0.25 },
    },
    {
      label: 'from_r5_skip1_b050',
      spec: { kind: 'adaptive', minPeakSortedIdx: 4, extraSkipRungs: 1, blendWideFrac: 0.5 },
    },
    {
      label: 'from_r5_skip1_b025',
      spec: { kind: 'adaptive', minPeakSortedIdx: 4, extraSkipRungs: 1, blendWideFrac: 0.25 },
    },
  ];
}

async function main(): Promise<void> {
  const jsonlArg = arg('--jsonl');
  const jsonlPath = jsonlArg ?? process.env.LIVE_TRADES_PATH;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    console.error(
      'Usage: tsx src/scripts/live-oscar-ladder-retrace-sweep.ts --jsonl <journal.jsonl> [--step-ms MS] [--min-tp-hits N] [--winners-only] [--trail-only]',
    );
    console.error('Or set LIVE_TRADES_PATH to an existing file.');
    process.exit(1);
  }

  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const minTpHits = Number(arg('--min-tp-hits') ?? 3);
  const winnersOnly = flag('--winners-only');
  const trailOnly = flag('--trail-only');

  let cfg;
  try {
    cfg = loadPaperTraderConfig();
  } catch (e) {
    console.error('loadPaperTraderConfig failed:', (e as Error).message);
    process.exit(1);
  }

  if (cfg.trailMode !== 'ladder_retrace') {
    console.warn(
      `WARN: PAPER_TRAIL_MODE is "${cfg.trailMode}" — sweep only affects ladder_retrace. Results are for analysis only.`,
    );
  }

  const dcaLevels = parseDcaLevels(process.env.PAPER_DCA_LEVELS);
  const tpLadder = cfg.tpGridStepPnl > 0 ? [] : parseTpLadder(process.env.PAPER_TP_LADDER);

  let lifecycles = await readJournalLifecycles(path.resolve(jsonlPath));
  lifecycles = lifecycles.filter((lc) => countTpLadderHits(lc) >= minTpHits);
  if (winnersOnly) lifecycles = lifecycles.filter((lc) => actualNetFromClose(lc) > 0);
  if (trailOnly) lifecycles = lifecycles.filter((lc) => exitReason(lc) === 'TRAIL');

  console.log('\n=== live-oscar-ladder-retrace-sweep ===');
  console.log(`journal: ${jsonlPath}`);
  console.log(`stepMs: ${stepMs}  minTpLadderHits: ${minTpHits}  winnersOnly: ${winnersOnly}  trailOnly: ${trailOnly}`);
  console.log(`matching lifecycles: ${lifecycles.length}`);
  console.log(`tpGridStepPnl: ${cfg.tpGridStepPnl}  discrete ladder rows: ${tpLadder.length}`);

  if (lifecycles.length === 0) {
    console.error('No trades after filters.');
    process.exit(1);
  }

  const actualSum = lifecycles.reduce((s, lc) => s + actualNetFromClose(lc), 0);
  console.log(`sum actual netPnlUsd (journal closes): ${actualSum.toFixed(4)}`);

  const specs = buildSweepMatrix();
  const rows: {
    label: string;
    sumSim: number;
    n: number;
    meanDeltaVsJournal: number;
    wins: number;
  }[] = [];

  for (const { label, spec } of specs) {
    let sumSim = 0;
    let n = 0;
    let deltaSum = 0;
    let wins = 0;
    for (const lc of lifecycles) {
      const anchors = anchorsFromJournalEvents(lc.events);
      if (anchors.length < 2) continue;
      const baseOt = cloneOpenFromJournal(lc.open);
      const ct = simulateLifecycle({
        baseOt,
        anchors,
        cfg,
        dcaLevels,
        tpLadder,
        stepMs,
        ladderRetraceSpec: spec,
      });
      if (!ct) continue;
      sumSim += ct.netPnlUsd;
      deltaSum += ct.netPnlUsd - actualNetFromClose(lc);
      if (ct.netPnlUsd > 0) wins++;
      n++;
    }
    const meanDelta = n > 0 ? deltaSum / n : 0;
    rows.push({ label, sumSim, n, meanDeltaVsJournal: meanDelta, wins });
  }

  rows.sort((a, b) => b.sumSim - a.sumSim);

  console.log('\n=== sweep results (sorted by sum sim netPnlUsd desc) ===');
  console.log(
    ['rank', 'label', 'sumSim', 'vsActual', 'meanΔ/jrnl', 'n', 'wins']
      .map((h) => h.padEnd(14))
      .join(''),
  );
  let rank = 1;
  for (const r of rows) {
    const vsActual = r.sumSim - actualSum;
    console.log(
      [
        String(rank++).padEnd(14),
        r.label.padEnd(14),
        r.sumSim.toFixed(4).padEnd(14),
        vsActual.toFixed(4).padEnd(14),
        r.meanDeltaVsJournal.toFixed(4).padEnd(14),
        String(r.n).padEnd(14),
        String(r.wins).padEnd(14),
      ].join(''),
    );
  }

  const best = rows[0];
  if (best) {
    console.log(`\nBest label by total PnL: ${best.label}  sumSim=${best.sumSim.toFixed(4)}  vs journal sum=${(best.sumSim - actualSum).toFixed(4)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
