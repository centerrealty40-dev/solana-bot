/**
 * Counterfactual sweep: ladder_retrace trail floor variants vs journal closes.
 *
 * Supports **live-oscar** JSONL (`live_position_*`) and classic **paper** journal (`open` / `close`).
 * When run via `npx tsx` without PM2 env, fills missing `PAPER_TP_GRID_*` / `PAPER_TRAIL_*`
 * from live-oscar defaults (same as ecosystem.config.cjs block).
 *
 * Usage:
 *   npx tsx src/scripts/live-oscar-ladder-retrace-sweep.ts --jsonl data/live/pt1-oscar-live.jsonl
 *   npx tsx ... --strategy-id live-oscar --step-ms 60000 --winners-only
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import dotenv from 'dotenv';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { restoreOpenTradeFromJson } from '../papertrader/executor/store-restore.js';
import type { LadderRetraceSpec } from '../papertrader/executor/tp-ladder-state.js';
import type { OpenTrade } from '../papertrader/types.js';
import {
  anchorsFromJournalEvents,
  cloneOpenFromJournal,
  readJournalLifecycles,
  simulateLifecycle,
  type JournalLifecycle,
} from './paper2-strategy-backtest.js';

/** Live rows attach full `openTrade` JSON suitable for `restoreOpenTradeFromJson`. */
type SweepLifecycle = JournalLifecycle & { liveEntrySnap?: Record<string, unknown> };

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const inherit = process.env.LIVE_INHERIT_ENV_FILE?.trim();
if (inherit) {
  dotenv.config({ path: path.isAbsolute(inherit) ? inherit : path.resolve(process.cwd(), inherit) });
}

/** Defaults aligned with `ecosystem.config.cjs` live-oscar when env is not injected by PM2. */
function applyPm2LessPaperDefaults(): void {
  const setIfEmpty = (k: string, v: string): void => {
    if (!process.env[k]?.trim()) process.env[k] = v;
  };
  setIfEmpty('PAPER_TP_GRID_STEP_PNL', '0.05');
  setIfEmpty('PAPER_TP_GRID_SELL_FRACTION', '0.15');
  setIfEmpty('PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL', '0.025');
  setIfEmpty('PAPER_TP_X', '100');
  setIfEmpty('PAPER_TRAIL_MODE', 'ladder_retrace');
  setIfEmpty('PAPER_TRAIL_DROP', '0.10');
  setIfEmpty('PAPER_TRAIL_TRIGGER_X', '1.10');
  if (!process.env.PAPER_TP_LADDER?.trim()) process.env.PAPER_TP_LADDER = '';
}

applyPm2LessPaperDefaults();

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

function numUsd(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function actualNetFromClose(lc: JournalLifecycle): number {
  return numUsd((lc.close as { netPnlUsd?: unknown }).netPnlUsd);
}

function exitReason(lc: JournalLifecycle): string {
  return String((lc.close as { exitReason?: unknown }).exitReason ?? '');
}

function detectJournalFamily(absPath: string): 'live' | 'paper' {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(262_144, fs.statSync(absPath).size || 262_144));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.slice(0, n).toString('utf8');
    if (s.includes('"live_position_close"') || s.includes('"live_position_open"')) return 'live';
  } finally {
    fs.closeSync(fd);
  }
  return 'paper';
}

interface SortRow {
  ts: number;
  lineIdx: number;
  kind: string;
  mint: string;
  row: Record<string, unknown>;
}

function liveBufferToPaperLikeEvents(buf: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of buf) {
    const k = String(row.kind ?? '');
    const ts = Number(row.ts ?? 0);
    const ot = row.openTrade as Record<string, unknown> | undefined;
    if (k === 'live_position_open' && ot) {
      out.push({
        kind: 'open',
        mint: row.mint,
        entryTs: ot.entryTs,
        legs: ot.legs,
        entryMcUsd: ot.entryMcUsd,
        dex: ot.dex,
        symbol: ot.symbol,
        lane: ot.lane,
        features: ot.entryMetrics,
      });
    } else if ((k === 'live_position_scale_in' || k === 'live_position_dca') && ot) {
      const legs = ot.legs as Record<string, unknown>[] | undefined;
      const last = legs && legs.length ? legs[legs.length - 1] : undefined;
      const mkt = Number(last?.marketPrice ?? last?.price ?? 0);
      out.push({ kind: 'dca_add', ts, marketPrice: mkt });
    } else if (k === 'live_position_partial_sell' && ot) {
      const ps = ot.partialSells as Record<string, unknown>[] | undefined;
      const last = ps && ps.length ? ps[ps.length - 1] : undefined;
      const mkt = Number(last?.marketPrice ?? 0);
      out.push({ kind: 'partial_sell', ts, marketPrice: mkt, reason: last?.reason });
    } else if (k === 'live_position_close') {
      const ct = row.closedTrade as Record<string, unknown> | undefined;
      const exitTs = Number(ct?.exitTs ?? ts);
      const mkt = Number(ct?.theoretical_exit_price ?? ct?.exitMcUsd ?? 0);
      out.push({
        kind: 'close',
        ts: exitTs,
        exitTs,
        exit_market_price: mkt,
        exitMcUsd: mkt,
        netPnlUsd: ct?.netPnlUsd,
        exitReason: ct?.exitReason,
      });
    }
  }
  return out;
}

/** `openTrade` immediately before the first partial TP — correct legs + avg after scale-in, empty partials. */
function entryOpenTradeSnapshot(buf: Record<string, unknown>[]): Record<string, unknown> | null {
  const partialIdx = buf.findIndex((r) => r.kind === 'live_position_partial_sell');
  const closeIdx = buf.findIndex((r) => r.kind === 'live_position_close');
  if (closeIdx < 0) return null;
  const anchorRow =
    partialIdx >= 1
      ? buf[partialIdx - 1]
      : partialIdx === -1 && closeIdx >= 1
        ? buf[closeIdx - 1]
        : buf[0];
  const ot = anchorRow?.openTrade;
  if (typeof ot !== 'object' || ot === null) return null;
  return ot as Record<string, unknown>;
}

function prepareReplayOpenFromLiveSnap(raw: Record<string, unknown>): OpenTrade | null {
  const mint = String(raw.mint ?? '');
  if (!mint) return null;
  const ot = restoreOpenTradeFromJson(raw as Partial<OpenTrade> & { mint: string });
  if (!ot) return null;
  ot.partialSells = [];
  ot.ladderUsedLevels = new Set();
  ot.ladderUsedIndices = new Set();
  ot.remainingFraction = 1;
  const leg0 = ot.legs[0];
  if (leg0) {
    ot.peakMcUsd = Number(leg0.marketPrice ?? leg0.price);
    ot.peakPnlPct = 0;
    ot.trailingArmed = false;
  }
  return ot;
}

function buildLiveJournalLifecycle(mint: string, buf: Record<string, unknown>[]): SweepLifecycle | null {
  const openRow = buf.find((r) => r.kind === 'live_position_open');
  const closeRow = buf.find((r) => r.kind === 'live_position_close');
  if (!openRow || !closeRow) return null;
  const otFirst = openRow.openTrade as Record<string, unknown>;
  const entrySnap = entryOpenTradeSnapshot(buf);
  const paperOpen: Record<string, unknown> = {
    kind: 'open',
    mint,
    entryTs: otFirst.entryTs,
    legs: otFirst.legs,
    entryMcUsd: otFirst.entryMcUsd,
    dex: otFirst.dex,
    symbol: otFirst.symbol,
    lane: otFirst.lane,
    features: otFirst.entryMetrics,
  };
  const ct = closeRow.closedTrade as Record<string, unknown>;
  const paperClose: Record<string, unknown> = {
    kind: 'close',
    mint,
    ts: numUsd(ct.exitTs) || Number(closeRow.ts ?? 0),
    exitTs: numUsd(ct.exitTs),
    netPnlUsd: numUsd(ct.netPnlUsd),
    exitReason: ct.exitReason,
    theoretical_exit_price: numUsd(ct.theoretical_exit_price),
    exitMcUsd: numUsd(ct.exitMcUsd),
    totalProceedsUsd: numUsd(ct.totalProceedsUsd),
  };
  const events = liveBufferToPaperLikeEvents(buf);
  return { mint, open: paperOpen, close: paperClose, events, liveEntrySnap: entrySnap ?? undefined };
}

async function readLiveOscarJournalLifecycles(jsonlPath: string, strategyId: string): Promise<SweepLifecycle[]> {
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const batch: SortRow[] = [];
  let lineIdx = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const sid = row.strategyId != null ? String(row.strategyId) : '';
    if (sid !== strategyId) continue;
    const ch = row.channel;
    if (ch !== undefined && ch !== null && ch !== 'live') continue;

    const kind = row.kind != null ? String(row.kind) : '';
    if (!kind.startsWith('live_position_')) continue;

    const tsRaw = row.ts;
    const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) ? tsRaw : 0;
    const mint = row.mint != null ? String(row.mint) : '';
    if (!mint) continue;

    batch.push({ ts, lineIdx: lineIdx++, kind, mint, row });
  }

  batch.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.lineIdx - b.lineIdx));

  const bufByMint = new Map<string, Record<string, unknown>[]>();
  const completed: SweepLifecycle[] = [];

  for (const { kind, mint, row } of batch) {
    if (kind === 'live_position_open') {
      bufByMint.set(mint, [row]);
      continue;
    }
    const b = bufByMint.get(mint);
    if (!b) continue;
    b.push(row);
    if (kind === 'live_position_close') {
      const lc = buildLiveJournalLifecycle(mint, b);
      if (lc) completed.push(lc);
      bufByMint.delete(mint);
    }
  }

  return completed;
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
      'Usage: tsx src/scripts/live-oscar-ladder-retrace-sweep.ts --jsonl <journal.jsonl> [--strategy-id live-oscar] [--step-ms MS] [--min-tp-hits N] [--winners-only] [--trail-only]',
    );
    console.error('Or set LIVE_TRADES_PATH to an existing file.');
    process.exit(1);
  }

  const absJsonl = path.resolve(jsonlPath);
  const strategyId = arg('--strategy-id') ?? process.env.LIVE_STRATEGY_ID ?? 'live-oscar';
  /** Coarser step = faster sweep (journal anchors are sparse anyway). */
  const stepMs = Number(arg('--step-ms') ?? 120_000);
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

  /** Counterfactual always uses ladder_retrace for trailing semantics (even if env says peak). */
  const cfgSim = { ...cfg, trailMode: 'ladder_retrace' as const };

  const dcaLevels = parseDcaLevels(process.env.PAPER_DCA_LEVELS);
  const tpLadder = cfgSim.tpGridStepPnl > 0 ? [] : parseTpLadder(process.env.PAPER_TP_LADDER);

  const family = detectJournalFamily(absJsonl);
  let lifecycles: SweepLifecycle[];
  if (family === 'live') {
    lifecycles = await readLiveOscarJournalLifecycles(absJsonl, strategyId);
  } else {
    lifecycles = await readJournalLifecycles(absJsonl);
  }

  lifecycles = lifecycles.filter((lc) => countTpLadderHits(lc) >= minTpHits);
  if (winnersOnly) lifecycles = lifecycles.filter((lc) => actualNetFromClose(lc) > 0);
  if (trailOnly) lifecycles = lifecycles.filter((lc) => exitReason(lc) === 'TRAIL');

  const skipOutliers = !flag('--keep-outliers');
  const maxAbsNet = Math.max(50_000, cfgSim.positionUsd * 500);
  if (skipOutliers && lifecycles.length) {
    const bad = lifecycles.filter((lc) => Math.abs(actualNetFromClose(lc)) > maxAbsNet);
    if (bad.length) {
      console.warn(
        `Dropping ${bad.length} close(s) with |netPnlUsd|>${maxAbsNet} (bad journal math); pass --keep-outliers to retain.`,
      );
      for (const lc of bad) {
        const net = actualNetFromClose(lc);
        console.warn(`  outlier mint=${String(lc.mint).slice(0, 12)} netPnlUsd=${net}`);
      }
      lifecycles = lifecycles.filter((lc) => Math.abs(actualNetFromClose(lc)) <= maxAbsNet);
    }
  }

  console.log('\n=== live-oscar-ladder-retrace-sweep ===');
  console.log(`journal: ${absJsonl}`);
  console.log(`detected family: ${family}  strategyId filter: ${strategyId}`);
  console.log(`stepMs: ${stepMs}  minTpLadderHits: ${minTpHits}  winnersOnly: ${winnersOnly}  trailOnly: ${trailOnly}`);
  console.log(`matching lifecycles: ${lifecycles.length}`);
  console.log(
    `trailMode(sim forced): ${cfgSim.trailMode}  tpGridStepPnl: ${cfgSim.tpGridStepPnl}  discrete ladder rows: ${tpLadder.length}`,
  );

  if (lifecycles.length === 0) {
    console.warn('\nNo trades after filters — nothing to sweep (exit 0).');
    process.exit(0);
  }

  const nets = lifecycles.map(actualNetFromClose);
  if (nets.length) {
    console.log(
      `actual netPnlUsd range: ${Math.min(...nets).toFixed(4)} .. ${Math.max(...nets).toFixed(4)} (n=${nets.length})`,
    );
  }
  const actualSum = nets.reduce((s, v) => s + v, 0);
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
      const baseOt =
        lc.liveEntrySnap != null
          ? prepareReplayOpenFromLiveSnap(lc.liveEntrySnap)
          : cloneOpenFromJournal(lc.open);
      if (!baseOt) continue;
      const ct = simulateLifecycle({
        baseOt,
        anchors,
        cfg: cfgSim,
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
  const w = { rank: 6, label: 22, num: 14 };
  console.log(
    `${'rank'.padEnd(w.rank)}${'label'.padEnd(w.label)}${'sumSim'.padEnd(w.num)}${'vsActual'.padEnd(w.num)}${'meanΔ/jrnl'.padEnd(w.num)}${'n'.padEnd(w.num)}${'wins'.padEnd(w.num)}`,
  );
  let rank = 1;
  for (const r of rows) {
    const vsActual = r.sumSim - actualSum;
    console.log(
      `${String(rank++).padEnd(w.rank)}${r.label.padEnd(w.label)}${r.sumSim.toFixed(4).padEnd(w.num)}${vsActual.toFixed(4).padEnd(w.num)}${r.meanDeltaVsJournal.toFixed(4).padEnd(w.num)}${String(r.n).padEnd(w.num)}${String(r.wins).padEnd(w.num)}`,
    );
  }

  const best = rows[0];
  if (best) {
    console.log(
      `\nBest label by total PnL: ${best.label}  sumSim=${best.sumSim.toFixed(4)}  vs journal sum=${(best.sumSim - actualSum).toFixed(4)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
