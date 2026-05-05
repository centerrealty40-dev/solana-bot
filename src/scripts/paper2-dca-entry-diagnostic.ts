/**
 * DCA / averaging diagnostic on **fixed real opens** (journal entryTs & legs unchanged).
 *
 * Sweeps `PAPER_DCA_LEVELS`-shaped specs (0 / 1 / 2+ rungs) and compares forward `simulateLifecycle`
 * sums on PG paths — **no oracle**, same mechanics as live sim.
 *
 * Interpretation (heuristic on this sample only):
 * - Best profile **no DCA** → entries often “good enough” vs later dips (didn’t need averaging).
 * - Best **one** shallow DCA → mild systematic undershoot of local lows.
 * - Best **two+** deeper rungs → repeated miss of bottom / path spent long underwater.
 *
 * Exit profiles:
 *   --exit pm2      exact pt1-oscar PM2 cfg from ecosystem (default)
 *   --exit tuned    same base + trail/grid tweaks from last global coarse optimum (edit constants if needed)
 *   --exit both     print both tables
 *
 *   npx tsx src/scripts/paper2-dca-entry-diagnostic.ts --since-hours 48 --hold-horizon-hours 96 \
 *     --dir data/paper2 --jsonl data/live/pt1-oscar-live.jsonl --exit both
 *
 * Requires DATABASE_URL.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import type { DcaLevel, PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import { cloneOpenFromJournal, simulateLifecycle } from './paper2-strategy-backtest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ecosystem = require(path.join(repoRoot, 'ecosystem.config.cjs')) as {
  apps: Array<{ name?: string; env?: Record<string, unknown> }>;
};

/** From last `paper2-global-strategy-optimizer` coarse best on 168h sample — tighten trail + grid step. */
const TUNED_EXIT_PARTIAL: Partial<PaperTraderConfig> = {
  trailTriggerX: 1.04,
  trailDrop: 0.09,
  tpGridStepPnl: 0.07,
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

type Prep = { baseOt: ReturnType<typeof cloneOpenFromJournal>; anchors: Anchor[] };

function dcaSpecLabel(spec: string): { label: string; nRungs: number } {
  const levels = parseDcaLevels(spec || undefined);
  const n = levels.length;
  let label: string;
  if (n === 0) label = '0 DCA (spot only)';
  else if (n === 1) label = `1 DCA @ ${(levels[0]!.triggerPct * 100).toFixed(1)}% +${(levels[0]!.addFraction * 100).toFixed(0)}% leg`;
  else label = `${n} DCAs: ${levels.map((l) => `${(l.triggerPct * 100).toFixed(0)}%`).join(' → ')}`;
  return { label, nRungs: n };
}

const DCA_SPECS: string[] = [
  '', // none
  '-5:0.25',
  '-7:0.3',
  '-10:0.3',
  '-12:0.3',
  '-15:0.3',
  '-7:0.3,-15:0.3',
  '-10:0.3,-20:0.3',
  '-5:0.25,-12:0.25',
  '-7:0.25,-12:0.25,-18:0.25',
];

function sumPrepared(
  prepared: Prep[],
  cfg: PaperTraderConfig,
  dcaLevels: DcaLevel[],
  tpLadder: ReturnType<typeof parseTpLadder>,
  stepMs: number,
  bufferHours: number,
): number {
  let sum = 0;
  for (const p of prepared) {
    const clipEnd = p.baseOt.entryTs + (cfg.timeoutHours + bufferHours) * 3_600_000;
    const clipped = p.anchors.filter((a) => a.ts <= clipEnd);
    const anchors = clipped.length >= 2 ? clipped : p.anchors;
    const ct = simulateLifecycle({
      baseOt: p.baseOt,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    if (ct) sum += ct.netPnlUsd;
  }
  return sum;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 48);
  const holdHorizonH = Number(arg('--hold-horizon-hours') ?? 96);
  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);
  const exitMode = arg('--exit') ?? 'pm2';

  if (!['pm2', 'tuned', 'both'].includes(exitMode)) {
    console.error('--exit must be pm2 | tuned | both');
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
  const baseLoad = withEnvPatch(oscarEnv, () => ({
    cfg: loadPaperTraderConfig(),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
    prodDcaSpec: process.env.PAPER_DCA_LEVELS ?? '',
  }));

  const oscarCfgPm2 = baseLoad.cfg;
  const tpLadder = baseLoad.tpLadder;
  const prodDcaSpec = baseLoad.prodDcaSpec;

  const oscarCfgTuned: PaperTraderConfig = { ...oscarCfgPm2, ...TUNED_EXIT_PARTIAL };

  const sinceTs = Date.now() - sinceH * 3_600_000;
  const rawOpens: Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string }> = [];
  for (const p of paths) {
    rawOpens.push(...(await scanOpensFromFile(p, sinceTs)));
  }
  const dedupe = new Map<string, (typeof rawOpens)[0]>();
  for (const row of rawOpens) {
    const mint = String(row.open.mint ?? '');
    const entryTs = Number(row.open.entryTs ?? 0);
    const k = `${mint}:${entryTs}`;
    if (!mint || !Number.isFinite(entryTs)) continue;
    if (!dedupe.has(k)) dedupe.set(k, row);
  }
  const universe = [...dedupe.values()];

  const fetchEnd = (entryTs: number) => entryTs + holdHorizonH * 3_600_000;
  const prepared: Prep[] = [];
  let skipped = 0;
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
      endTs: fetchEnd(baseOt.entryTs),
    });
    const slice = anchors.filter((a) => a.ts >= baseOt.entryTs && a.ts <= fetchEnd(baseOt.entryTs));
    if (slice.length < 2) {
      skipped++;
      continue;
    }
    prepared.push({ baseOt, anchors: slice });
  }

  console.log(`\n=== DCA entry diagnostic (fixed opens, forward PG sim) ===`);
  console.log(`Entry window: last ${sinceH}h   opens with PG: ${prepared.length} (skipped ${skipped})`);
  console.log(`PM2 production PAPER_DCA_LEVELS: "${prodDcaSpec}"`);
  console.log(`stepMs=${stepMs} holdHorizon=${holdHorizonH}h\n`);

  function runBlock(title: string, cfg: PaperTraderConfig): void {
    console.log(`--- ${title} ---`);
    const rows: { spec: string; sum: number; label: string; nRungs: number }[] = [];
    for (const spec of DCA_SPECS) {
      const dcaLevels = parseDcaLevels(spec || undefined);
      const { label, nRungs } = dcaSpecLabel(spec);
      const sum = sumPrepared(prepared, cfg, dcaLevels, tpLadder, stepMs, bufferHours);
      rows.push({ spec: spec || '(none)', sum, label, nRungs });
    }
    rows.sort((a, b) => b.sum - a.sum);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const mark =
        r.spec === (prodDcaSpec.trim() === '' ? '(none)' : prodDcaSpec.trim()) ? '  ← PM2 prod spec'
          : '';
      console.log(`  #${i + 1} sum=$${r.sum.toFixed(2)}  ${r.label}  [${r.spec}]${mark}`);
    }
    const best = rows[0]!;
    console.log(`\n  Best on sample: ${best.label}  sum=$${best.sum.toFixed(2)}`);
    if (best.nRungs === 0) {
      console.log(
        `  Readout: averaging **not** rewarded on this slice → timing vs first fill looks **relatively OK** (vs needing deliberate dips).`,
      );
    } else if (best.nRungs === 1) {
      console.log(
        `  Readout: **one** extra leg helped most → mild systematic **undershoot** of local lows after entry.`,
      );
    } else {
      console.log(
        `  Readout: **multiple** deeper rungs helped most → entries often **above** where price spent time; classic “missed the real dip”.`,
      );
    }
    console.log('');
  }

  const minH = Math.max(oscarCfgPm2.timeoutHours, oscarCfgTuned.timeoutHours) + bufferHours;
  if (holdHorizonH < minH) {
    console.error(`hold-horizon-hours should be >= timeout+buffer (${minH})`);
    process.exit(1);
  }

  if (exitMode === 'pm2' || exitMode === 'both') runBlock('Exit = PM2 pt1-oscar (unchanged)', oscarCfgPm2);
  if (exitMode === 'tuned' || exitMode === 'both') runBlock('Exit = tuned partial (trail/grid only)', oscarCfgTuned);

  console.log(
    'Caveat: best DCA here is in-sample; production uses more gates (impulse, verify). Entries in journal are facts; sim uses first leg from open event only.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
