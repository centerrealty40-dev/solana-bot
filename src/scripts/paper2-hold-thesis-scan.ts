/**
 * Tests the thesis «quality liquid names recover — maybe longer timeout / looser kill»
 * vs scalp-style Oscar on **the same buy universe** as `paper2-universe-strategy-matrix`.
 *
 * 1. **Oracle bounds from PG** (same fee model, no timing skill):
 *    - exit at **peak** price in the window after entry;
 *    - exit at **last** price in the window (naive hold-to-horizon).
 * 2. **Brute sweep** `timeoutHours × dcaKillstop` while keeping **the rest of pt1-oscar PM2** (grid, trail, DCA levels).
 *
 * The old “ideal grid” in `paper2-universe-strategy-matrix` only searched tpX≈2–3 — it never explored
 * your production geometry (tpX=100, +5% grid, 4h timeout). This script searches the knobs that match
 * your narrative (time + kill).
 *
 *   npx tsx src/scripts/paper2-hold-thesis-scan.ts --since-hours 168 --hold-horizon-hours 336 \
 *     --dir data/paper2 --jsonl data/live/pt1-oscar-live.jsonl --step-ms 60000
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import {
  cloneOpenFromJournal,
  oracleFullExitNetPnlUsd,
  simulateLifecycle,
} from './paper2-strategy-backtest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ecosystem = require(path.join(repoRoot, 'ecosystem.config.cjs')) as {
  apps: Array<{ name?: string; env?: Record<string, unknown> }>;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function collectJsonlPaths(): string[] {
  const i = process.argv.indexOf('--jsonl');
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < process.argv.length; k++) {
    const p = process.argv[k];
    if (p.startsWith('--')) break;
    out.push(p);
  }
  return out;
}

function stringifyEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function withEnvPatch<T>(patch: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k] of Object.entries(patch)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchMintPriceAnchorsPg(args: {
  mint: string;
  source: string;
  entryTs: number;
  endTs: number;
}): Promise<Anchor[]> {
  const table = sourceSnapshotTable(args.source);
  if (!table) return [];
  const mint = sqlQuote(args.mint);
  const t0 = args.entryTs / 1000;
  const t1 = args.endTs / 1000;
  const q = `
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::double precision AS ts_ms,
           price_usd::double precision AS p
    FROM ${table}
    WHERE base_mint = ${mint}
      AND ts >= to_timestamp(${t0})
      AND ts <= to_timestamp(${t1})
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `;
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Array<{ ts_ms: unknown; p: unknown }>;
  const out: Anchor[] = [];
  for (const row of rows) {
    const ts = Number(row.ts_ms);
    const p = Number(row.p);
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) continue;
    out.push({ ts, p });
  }
  return out;
}

function journalOpenToPaperShape(raw: Record<string, unknown>): Record<string, unknown> {
  const legs = raw.legs as Array<Record<string, unknown>> | undefined;
  const leg0 = legs?.[0];
  if (!leg0) throw new Error('open missing legs[0]');
  return {
    ...raw,
    mint: raw.mint,
    symbol: raw.symbol,
    lane: raw.lane,
    source: raw.source,
    dex: raw.dex,
    entryTs: raw.entryTs,
    entryMcUsd: raw.entryMcUsd,
    entryMarketPrice: raw.entryMarketPrice ?? leg0.marketPrice,
    legs,
    tpRegime: raw.tpRegime,
    tpGridOverrides: raw.tpGridOverrides,
    tpRegimeFeatures: raw.tpRegimeFeatures,
  };
}

function extractOpenFromLine(e: Record<string, unknown>): {
  strategyId: string;
  open: Record<string, unknown>;
} | null {
  const kind = e.kind as string | undefined;
  const sid = typeof e.strategyId === 'string' ? e.strategyId : '';
  if (kind === 'open') return { strategyId: sid, open: e };
  if (kind === 'live_position_open') {
    const ot = e.openTrade as Record<string, unknown> | undefined;
    if (!ot) return null;
    return { strategyId: sid || 'live-oscar', open: journalOpenToPaperShape(ot) };
  }
  return null;
}

async function scanOpensFromFile(
  filePath: string,
  sinceTs: number,
): Promise<Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string }>> {
  const pathLabel = path.basename(filePath);
  const out: Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string }> = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ex = extractOpenFromLine(e);
    if (!ex) continue;
    const entryTs = Number(ex.open.entryTs ?? 0);
    if (entryTs < sinceTs) continue;
    out.push({ strategyId: ex.strategyId, open: ex.open, pathLabel });
  }
  return out;
}

function pm2Pt1OscarEnv(): Record<string, string> {
  const apps = ecosystem.apps ?? [];
  const app = apps.find((a) => a.name === 'pt1-oscar');
  if (!app?.env) throw new Error('ecosystem.config.cjs: pt1-oscar env block not found');
  return stringifyEnv(app.env as Record<string, unknown>);
}

function clipAnchors(anchors: Anchor[], entryTs: number, endTs: number): Anchor[] {
  return anchors.filter((a) => a.ts >= entryTs && a.ts <= endTs);
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 168);
  const holdHorizonH = Number(arg('--hold-horizon-hours') ?? 168);
  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);

  if (!Number.isFinite(sinceH) || sinceH <= 0 || !Number.isFinite(holdHorizonH) || holdHorizonH <= 0) {
    console.error(
      'Usage: tsx src/scripts/paper2-hold-thesis-scan.ts --since-hours 168 [--hold-horizon-hours 336] [--dir data/paper2] [--jsonl ...] [--step-ms 60000]',
    );
    process.exit(1);
  }

  let paths = collectJsonlPaths();
  const dir = arg('--dir');
  if (dir && fs.existsSync(dir)) {
    paths.push(
      ...fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f)),
    );
  }
  const seenPath = new Set<string>();
  paths = [...new Set(paths.map((p) => path.resolve(p)))].filter((p) => {
    if (seenPath.has(p)) return false;
    seenPath.add(p);
    return fs.existsSync(p);
  });
  if (paths.length === 0) {
    console.error('No jsonl paths.');
    process.exit(1);
  }

  const oscarEnv = pm2Pt1OscarEnv();
  const { cfg: oscarCfg, dcaLevels: oscarDca, tpLadder: oscarTp } = withEnvPatch(oscarEnv, () => ({
    cfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));

  const sinceTs = Date.now() - sinceH * 3_600_000;
  const rawOpens: Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string }> = [];
  for (const p of paths) {
    rawOpens.push(...(await scanOpensFromFile(p, sinceTs)));
  }
  const dedupe = new Map<string, { strategyId: string; open: Record<string, unknown>; pathLabel: string }>();
  for (const row of rawOpens) {
    const mint = String(row.open.mint ?? '');
    const entryTs = Number(row.open.entryTs ?? 0);
    const k = `${mint}:${entryTs}`;
    if (!mint || !Number.isFinite(entryTs)) continue;
    if (!dedupe.has(k)) dedupe.set(k, row);
  }
  const universe = [...dedupe.values()];

  console.log(`\n=== Hold thesis scan (Oscar PM2 base, PG path) ===`);
  console.log(`Entry window: last ${sinceH}h   PG horizon after entry: ${holdHorizonH}h   stepMs=${stepMs}`);
  console.log(`Unique opens: ${universe.length}`);
  console.log(
    `PM2 pt1-oscar baseline: timeout=${oscarCfg.timeoutHours}h kill=${oscarCfg.dcaKillstop} tpGrid=${oscarCfg.tpGridStepPnl} trail=${oscarCfg.trailMode}\n`,
  );

  type Prep = {
    baseOt: ReturnType<typeof cloneOpenFromJournal>;
    anchors: Anchor[];
    mintShort: string;
  };
  const prepared: Prep[] = [];
  let skipped = 0;

  const fetchEndTs = (entryTs: number) => entryTs + holdHorizonH * 3_600_000;

  for (const row of universe) {
    let baseOt: ReturnType<typeof cloneOpenFromJournal>;
    try {
      baseOt = cloneOpenFromJournal(row.open);
    } catch {
      skipped++;
      continue;
    }
    const src = String(row.open.source ?? '').trim();
    if (!sourceSnapshotTable(src)) {
      skipped++;
      continue;
    }
    const anchors = await fetchMintPriceAnchorsPg({
      mint: baseOt.mint,
      source: src,
      entryTs: baseOt.entryTs,
      endTs: fetchEndTs(baseOt.entryTs),
    });
    const slice = clipAnchors(anchors, baseOt.entryTs, fetchEndTs(baseOt.entryTs));
    if (slice.length < 2) {
      skipped++;
      continue;
    }
    prepared.push({ baseOt, anchors: slice, mintShort: baseOt.mint.slice(0, 8) });
  }

  let oraclePeakSum = 0;
  let oracleTailSum = 0;
  let nPeakProfit = 0;
  let nTailProfit = 0;
  let maxDdSumPct = 0;

  for (const p of prepared) {
    const entryPx = p.anchors[0]?.p ?? p.baseOt.avgEntryMarket;
    let peak = entryPx;
    let trough = entryPx;
    for (const a of p.anchors) {
      if (a.p > peak) peak = a.p;
      if (a.p < trough) trough = a.p;
    }
    const tail = p.anchors[p.anchors.length - 1]!.p;
    if (entryPx > 0) {
      maxDdSumPct += ((trough - entryPx) / entryPx) * 100;
    }
    const pk = oracleFullExitNetPnlUsd(oscarCfg, p.baseOt, peak);
    const tl = oracleFullExitNetPnlUsd(oscarCfg, p.baseOt, tail);
    oraclePeakSum += pk;
    oracleTailSum += tl;
    if (pk > 0) nPeakProfit++;
    if (tl > 0) nTailProfit++;
  }

  console.log('--- Oracle (knowing PG path; not tradeable as systematic strategy) ---');
  console.log(
    `Sum if exit at max price in window: $${oraclePeakSum.toFixed(2)}  (${nPeakProfit}/${prepared.length} mints > 0 at peak)`,
  );
  console.log(
    `Sum if exit at last price in window: $${oracleTailSum.toFixed(2)}  (${nTailProfit}/${prepared.length} mints > 0 at tail)`,
  );
  console.log(`Avg max drawdown from first PG tick after entry: ${(maxDdSumPct / prepared.length).toFixed(2)}%\n`);

  function simSum(timeoutHours: number, dcaKillstop: number): number {
    let sum = 0;
    const clipEnd = (entryTs: number) => entryTs + (timeoutHours + bufferHours) * 3_600_000;
    const trialCfg: PaperTraderConfig = {
      ...oscarCfg,
      timeoutHours,
      dcaKillstop,
    };
    for (const p of prepared) {
      const clipped = p.anchors.filter((a) => a.ts <= clipEnd(p.baseOt.entryTs));
      const use = clipped.length >= 2 ? clipped : p.anchors;
      const ct = simulateLifecycle({
        baseOt: p.baseOt,
        anchors: use,
        cfg: trialCfg,
        dcaLevels: oscarDca,
        tpLadder: oscarTp,
        stepMs,
      });
      if (ct) sum += ct.netPnlUsd;
    }
    return sum;
  }

  const baselineSum = simSum(oscarCfg.timeoutHours, oscarCfg.dcaKillstop);
  console.log(
    `--- Simulated PM2 baseline (timeout=${oscarCfg.timeoutHours}h kill=${oscarCfg.dcaKillstop}) ---`,
  );
  console.log(`Sum netPnlUsd: $${baselineSum.toFixed(2)}\n`);

  const timeouts = [4, 8, 12, 24, 48, 72, 96, 168, 336].filter((h) => h <= holdHorizonH);
  const kills = [0, -0.02, -0.04, -0.06, -0.08, -0.1, -0.14, -0.2, -0.25];

  let bestSum = -Infinity;
  let bestT = 0;
  let bestK = 0;
  for (const t of timeouts) {
    for (const k of kills) {
      const s = simSum(t, k);
      if (s > bestSum) {
        bestSum = s;
        bestT = t;
        bestK = k;
      }
    }
  }

  console.log('--- Best timeout × killstop (Oscar grid/trail/DCA otherwise unchanged) ---');
  console.log(`Best sum: $${bestSum.toFixed(2)} at timeout=${bestT}h kill=${bestK}`);
  console.log(`Delta vs PM2 baseline: $${(bestSum - baselineSum).toFixed(2)}\n`);

  const patientSum = simSum(holdHorizonH, 0);
  console.log(`--- Patient variant probe: timeout=${holdHorizonH}h kill=0 (no DCA killstop) ---`);
  console.log(`Sum: $${patientSum.toFixed(2)}  (delta vs baseline $${(patientSum - baselineSum).toFixed(2)})\n`);

  console.log('Interpretation:');
  console.log(
    '- If oracle-at-tail ≫ baseline but baseline ≫ patientSum → exits help; pure hold loses vs your rules.',
  );
  console.log(
    '- If best (timeout,kill) barely beats baseline → you are already near a local optimum for these knobs.',
  );
  console.log(
    '- Oracle peak is an upper bound; systematic strategy cannot capture all peaks without lookahead.',
  );
  console.log(`Skipped (no PG path / bad open): ${skipped} / ${universe.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
