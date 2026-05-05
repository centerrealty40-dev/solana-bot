/**
 * Split PG paths after **real opens** into scenarios, then brute-search TP-grid + trail + timeout + kill
 * **within each bucket** (same forward sim as production lab — no oracle).
 *
 * Buckets (by min price vs entry in PG window):
 *   - `shallow`: max drawdown **above** -4% → «ушла вверх / почти без просадки»
 *   - `deep`: touched **≤ -7%** vs entry → «зона типичного усреднения»
 *   (Trades between -4%..-7% reported as `mid` count only — excluded from strict A/B optimize.)
 *
 *   npx tsx src/scripts/paper2-scenario-tp-trail-optimize.ts --since-hours 48 \
 *     --hold-horizon-hours 96 --dir data/paper2 --jsonl data/live/pt1-oscar-live.jsonl
 *
 * Requires DATABASE_URL.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as readline from 'node:readline';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import type { DcaLevel } from '../papertrader/config.js';
import { cloneOpenFromJournal, simulateLifecycle } from './paper2-strategy-backtest.js';

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

export function withEnvPatch<T>(patch: Record<string, string>, fn: () => T): T {
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

function extractOpenFromLine(e: Record<string, unknown>): { strategyId: string; open: Record<string, unknown> } | null {
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

export function pm2Pt1OscarEnv(): Record<string, string> {
  const apps = ecosystem.apps ?? [];
  const app = apps.find((a) => a.name === 'pt1-oscar');
  if (!app?.env) throw new Error('ecosystem.config.cjs: pt1-oscar env block not found');
  return stringifyEnv(app.env as Record<string, unknown>);
}

export type ScenarioPrep = {
  baseOt: ReturnType<typeof cloneOpenFromJournal>;
  anchors: Anchor[];
  ddPct: number;
};

/** Resolve `--jsonl` paths + optional `--dir data/paper2` (same rules as scenario optimizer). */
export function resolveScenarioJsonlPaths(): string[] {
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
  return [...new Set(paths.map((p) => path.resolve(p)))].filter((p) => {
    if (seenPath.has(p)) return false;
    seenPath.add(p);
    return fs.existsSync(p);
  });
}

export async function loadPaper2ScenarioPrepared(opts: {
  paths: string[];
  sinceHours: number;
  holdHorizonHours: number;
}): Promise<{ prepared: ScenarioPrep[]; skipped: number }> {
  const sinceTs = Date.now() - opts.sinceHours * 3_600_000;
  const rawOpens: Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string }> = [];
  for (const p of opts.paths) {
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

  const fetchEnd = (entryTs: number) => entryTs + opts.holdHorizonHours * 3_600_000;
  const prepared: ScenarioPrep[] = [];
  let skipped = 0;

  for (const row of [...dedupe.values()]) {
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
    const legs = baseOt.legs;
    const entryPx = Number(legs[0]?.marketPrice ?? legs[0]?.price ?? 0);
    const ddPct = pathMetrics(slice, baseOt.entryTs, entryPx);
    prepared.push({ baseOt, anchors: slice, ddPct });
  }

  return { prepared, skipped };
}

type Prep = ScenarioPrep;

function pathMetrics(anchors: Anchor[], entryTs: number, entryPx: number): number {
  let minP = entryPx;
  for (const a of anchors) {
    if (a.ts < entryTs) continue;
    if (a.p < minP) minP = a.p;
  }
  if (entryPx <= 0) return 0;
  return ((minP - entryPx) / entryPx) * 100;
}

function sumBucket(
  rows: Prep[],
  cfg: PaperTraderConfig,
  dcaLevels: DcaLevel[],
  tpLadder: ReturnType<typeof parseTpLadder>,
  stepMs: number,
  bufferHours: number,
): number {
  let sum = 0;
  for (const row of rows) {
    const clipEnd = row.baseOt.entryTs + (cfg.timeoutHours + bufferHours) * 3_600_000;
    const clipped = row.anchors.filter((a) => a.ts <= clipEnd);
    const use = clipped.length >= 2 ? clipped : row.anchors;
    const ct = simulateLifecycle({
      baseOt: row.baseOt,
      anchors: use,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    if (ct) sum += ct.netPnlUsd;
  }
  return sum;
}

function optimizeBucket(
  label: string,
  rows: Prep[],
  baseCfg: PaperTraderConfig,
  dcaLevels: DcaLevel[],
  tpLadder: ReturnType<typeof parseTpLadder>,
  stepMs: number,
  bufferHours: number,
): void {
  if (rows.length === 0) {
    console.log(`\n--- ${label}: empty bucket ---\n`);
    return;
  }

  const tpGridStepPnl = [0.03, 0.045, 0.06, 0.075, 0.09];
  const tpGridSellFraction = [0.15, 0.2, 0.25, 0.3, 0.35];
  const trailTriggerX = [1.03, 1.05, 1.06, 1.08, 1.1];
  const trailDrop = [0.08, 0.1, 0.12, 0.14, 0.17];
  const timeoutHours = [4, 8, 12];
  const dcaKillstop = [-0.2, -0.14, -0.1, -0.06];

  const baselineSum = sumBucket(rows, baseCfg, dcaLevels, tpLadder, stepMs, bufferHours);
  let best = -Infinity;
  let bestKnobs: Record<string, number | string> = {};

  for (const kg of dcaKillstop) {
    for (const th of timeoutHours) {
      for (const td of trailDrop) {
        for (const tt of trailTriggerX) {
          for (const gf of tpGridSellFraction) {
            for (const gs of tpGridStepPnl) {
              const cfg: PaperTraderConfig = {
                ...baseCfg,
                tpGridStepPnl: gs,
                tpGridSellFraction: gf,
                trailTriggerX: tt,
                trailDrop: td,
                timeoutHours: th,
                dcaKillstop: kg,
              };
              const s = sumBucket(rows, cfg, dcaLevels, tpLadder, stepMs, bufferHours);
              if (s > best) {
                best = s;
                bestKnobs = {
                  tpGridStepPnl: gs,
                  tpGridSellFraction: gf,
                  trailTriggerX: tt,
                  trailDrop: td,
                  timeoutHours: th,
                  dcaKillstop: kg,
                };
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n=== ${label} (n=${rows.length}) ===`);
  console.log(`PM2 baseline sum: $${baselineSum.toFixed(2)}`);
  console.log(`Best grid sum:    $${best.toFixed(2)}  (delta $${(best - baselineSum).toFixed(2)})`);
  console.log(`Best knobs: ${JSON.stringify(bestKnobs)}`);
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 48);
  const holdHorizonH = Number(arg('--hold-horizon-hours') ?? 96);
  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);

  const paths = resolveScenarioJsonlPaths();
  if (paths.length === 0) {
    console.error('No jsonl paths.');
    process.exit(1);
  }

  const oscarEnv = pm2Pt1OscarEnv();
  const { cfg: baseCfg, tpLadder, prodDca } = withEnvPatch(oscarEnv, () => ({
    cfg: loadPaperTraderConfig(),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
    prodDca: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
  }));

  const minNeed = baseCfg.timeoutHours + bufferHours;
  if (holdHorizonH < minNeed) {
    console.error(`hold-horizon-hours >= ${minNeed}`);
    process.exit(1);
  }

  const { prepared, skipped } = await loadPaper2ScenarioPrepared({
    paths,
    sinceHours: sinceH,
    holdHorizonHours: holdHorizonH,
  });

  const shallow = prepared.filter((p) => p.ddPct > -4);
  const deep = prepared.filter((p) => p.ddPct <= -7);
  const mid = prepared.filter((p) => p.ddPct <= -4 && p.ddPct > -7);

  console.log(`\n=== Path split (${sinceH}h opens, PG horizon ${holdHorizonH}h) ===`);
  console.log(`Total prepared: ${prepared.length} (skipped ${skipped})`);
  console.log(
    `Shallow drawdown (> -4% vs entry px): ${shallow.length}  |  Deep (hit ≤-7%): ${deep.length}  |  Mid -4..-7%: ${mid.length}`,
  );

  const bins = [-4, -7, -10, -15, -20, -25, -35, -50];
  console.log('\nDistribution of min drawdown % vs entry (first leg market px):');
  for (let i = 0; i < bins.length - 1; i++) {
    const lo = bins[i]!;
    const hi = bins[i + 1]!;
    const n = prepared.filter((p) => p.ddPct <= lo && p.ddPct > hi).length;
    console.log(`  (${hi}% .. ${lo}%]: ${n}`);
  }
  console.log(`  ≤ ${bins[bins.length - 1]}%: ${prepared.filter((p) => p.ddPct <= bins[bins.length - 1]!).length}`);

  console.log('\n--- Killstop-only sweep (full sample, PM2 exits else fixed) ---');
  const kills = [-0.05, -0.08, -0.1, -0.12, -0.14, -0.16, -0.18, -0.22, -0.28, -0.35];
  let kb = -Infinity;
  let kk = 0;
  for (const k of kills) {
    const cfg = { ...baseCfg, dcaKillstop: k };
    const s = sumBucket(prepared, cfg, prodDca, tpLadder, stepMs, bufferHours);
    console.log(`  kill=${k.toFixed(2)} → sum=$${s.toFixed(2)}`);
    if (s > kb) {
      kb = s;
      kk = k;
    }
  }
  console.log(`  Best kill in grid: ${kk}  sum=$${kb.toFixed(2)} (PM2 uses ${baseCfg.dcaKillstop})`);

  optimizeBucket(
    'A) Shallow dip — «почти сразу вверх» (max DD > -4%)',
    shallow,
    baseCfg,
    prodDca,
    tpLadder,
    stepMs,
    bufferHours,
  );
  optimizeBucket(
    'B) Deep — цена ударила ≥7% ниже входа (усреднение по пути реалистично)',
    deep,
    baseCfg,
    prodDca,
    tpLadder,
    stepMs,
    bufferHours,
  );

  console.log(
    '\nNote: buckets are **path statistics**, not whether DCA actually filled in live. Sim uses PM2 DCA spec for both.',
  );
}

function scenarioOptimizerInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (scenarioOptimizerInvokedDirectly()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
