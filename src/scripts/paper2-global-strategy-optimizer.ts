/**
 * **Single forward-testable strategy**: one fixed `PaperTraderConfig` exit profile applied to **every**
 * open in the universe — maximize **sum of simulated netPnlUsd** using PG `*_pair_snapshots` only.
 *
 * No lookahead: each trade is replayed with `simulateLifecycle` (same mechanics as production sim).
 * This is **in-sample** optimum over the chosen window; it answers “best single rulebook on these buys”,
 * not guaranteed future performance.
 *
 * Base fees / DCA levels / discrete ladder strings come from **pt1-oscar PM2** env; we sweep exit knobs
 * that are global scalars (tp/sl/trail/timeout/kill/grid step).
 *
 *   npx tsx src/scripts/paper2-global-strategy-optimizer.ts --since-hours 168 \
 *     --hold-horizon-hours 96 --dir data/paper2 --jsonl data/live/pt1-oscar-live.jsonl --step-ms 60000
 *
 *   --grid coarse   (default, ~hundreds of combos) | --grid wide (more exhaustive, slower)
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
import type { PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import type { Anchor } from './paper2-strategy-backtest.js';
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
function flag(name: string): boolean {
  return process.argv.includes(name);
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

function buildCoarseGrid(): Array<Partial<PaperTraderConfig>> {
  const tpX = [3, 8, 25, 60, 100];
  const slX = [0, 0.55, 0.75];
  const trailTriggerX = [1.04, 1.08, 1.14];
  const trailDrop = [0.09, 0.14, 0.2];
  const timeoutHours = [4, 8, 16, 32, 48];
  const dcaKillstop = [-0.22, -0.14, -0.08, 0];
  const tpGridStepPnl = [0, 0.04, 0.07];
  const trailMode = ['ladder_retrace', 'peak'] as const;
  const out: Array<Partial<PaperTraderConfig>> = [];
  for (const tm of trailMode) {
    for (const gx of tpGridStepPnl) {
      for (const k of dcaKillstop) {
        for (const th of timeoutHours) {
          for (const td of trailDrop) {
            for (const tt of trailTriggerX) {
              for (const sl of slX) {
                for (const tp of tpX) {
                  out.push({
                    tpX: tp,
                    slX: sl,
                    trailTriggerX: tt,
                    trailDrop: td,
                    timeoutHours: th,
                    dcaKillstop: k,
                    tpGridStepPnl: gx,
                    trailMode: tm,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function buildWideGrid(): Array<Partial<PaperTraderConfig>> {
  const tpX = [2, 4, 8, 15, 30, 60, 100];
  const slX = [0, 0.45, 0.65, 0.8];
  const trailTriggerX = [1.03, 1.06, 1.1, 1.15, 1.22];
  const trailDrop = [0.07, 0.11, 0.15, 0.2, 0.28];
  const timeoutHours = [4, 6, 10, 16, 24, 40, 56, 72];
  const dcaKillstop = [-0.28, -0.18, -0.12, -0.06, 0];
  const tpGridStepPnl = [0, 0.03, 0.05, 0.08];
  const trailMode = ['ladder_retrace', 'peak'] as const;
  const out: Array<Partial<PaperTraderConfig>> = [];
  for (const tm of trailMode) {
    for (const gx of tpGridStepPnl) {
      for (const k of dcaKillstop) {
        for (const th of timeoutHours) {
          for (const td of trailDrop) {
            for (const tt of trailTriggerX) {
              for (const sl of slX) {
                for (const tp of tpX) {
                  out.push({
                    tpX: tp,
                    slX: sl,
                    trailTriggerX: tt,
                    trailDrop: td,
                    timeoutHours: th,
                    dcaKillstop: k,
                    tpGridStepPnl: gx,
                    trailMode: tm,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 168);
  const holdHorizonH = Number(arg('--hold-horizon-hours') ?? 96);
  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);
  const gridMode = arg('--grid') ?? 'coarse';

  if (!Number.isFinite(sinceH) || sinceH <= 0 || !Number.isFinite(holdHorizonH) || holdHorizonH <= 0) {
    console.error(
      'Usage: tsx src/scripts/paper2-global-strategy-optimizer.ts --since-hours 168 [--hold-horizon-hours 96] [--grid coarse|wide] [--dir data/paper2] [--jsonl ...]]',
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

  const trials = gridMode === 'wide' ? buildWideGrid() : buildCoarseGrid();
  const maxT = Math.max(...trials.map((t) => t.timeoutHours ?? 0));
  if (holdHorizonH < maxT + bufferHours) {
    console.error(
      `hold-horizon-hours (${holdHorizonH}) should be >= max timeout in grid (${maxT}) + buffer (${bufferHours}).`,
    );
    process.exit(1);
  }

  const oscarEnv = pm2Pt1OscarEnv();
  const { cfg: oscarCfg, dcaLevels, tpLadder } = withEnvPatch(oscarEnv, () => ({
    cfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));

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

  console.log(`\n=== Global strategy optimizer (forward sim, no oracle) ===`);
  console.log(`Universe: ${prepared.length} opens (skipped ${skipped})   grid=${gridMode} combos=${trials.length}`);
  console.log(`PM2 pt1-oscar baseline: tpX=${oscarCfg.tpX} slX=${oscarCfg.slX} trig=${oscarCfg.trailTriggerX} drop=${oscarCfg.trailDrop} tOut=${oscarCfg.timeoutHours}h kill=${oscarCfg.dcaKillstop} gridStep=${oscarCfg.tpGridStepPnl} trail=${oscarCfg.trailMode}\n`);

  function sumForCfg(cfg: PaperTraderConfig): number {
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

  const baselineSum = sumForCfg(oscarCfg);
  console.log(`Baseline (exact PM2 pt1-oscar merged cfg) sum: $${baselineSum.toFixed(2)}\n`);

  let bestSum = -Infinity;
  let bestTrial: Partial<PaperTraderConfig> | null = null;
  const top: { sum: number; trial: Partial<PaperTraderConfig> }[] = [];
  let idx = 0;
  for (const trial of trials) {
    idx++;
    const cfg: PaperTraderConfig = {
      ...oscarCfg,
      ...trial,
      trailMode: (trial.trailMode ?? oscarCfg.trailMode) as PaperTraderConfig['trailMode'],
    };
    const sum = sumForCfg(cfg);
    if (sum > bestSum) {
      bestSum = sum;
      bestTrial = trial;
    }
    top.push({ sum, trial });
    if (flag('--progress') && idx % 2000 === 0) {
      console.error(`  ... ${idx}/${trials.length} best so far $${bestSum.toFixed(2)}`);
    }
  }

  top.sort((a, b) => b.sum - a.sum);
  const topK = top.slice(0, 8);

  console.log(`Best single strategy (max sum netPnlUsd): $${bestSum.toFixed(2)}`);
  console.log(`Delta vs PM2 baseline: $${(bestSum - baselineSum).toFixed(2)}`);
  console.log('Best knobs:', JSON.stringify(bestTrial, null, 2));
  console.log('\nTop candidates (robustness check):');
  for (let i = 0; i < topK.length; i++) {
    const row = topK[i]!;
    console.log(`  #${i + 1} sum=$${row.sum.toFixed(2)} ` + JSON.stringify(row.trial));
  }

  console.log(
    '\nNote: optimum is in-sample on this PG slice; validate on a held-out week before trading live.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
