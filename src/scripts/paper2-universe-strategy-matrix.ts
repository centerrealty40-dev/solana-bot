/**
 * Cross-strategy PG backtest on a **single universe of opens** (all buys in the window).
 *
 * For each mint entryTs in the union of journals, replays **every** PM2 paper/live exit profile
 * from `ecosystem.config.cjs` (diprunner, oscar, dno, live-oscar) plus **pt1-oscar-regime**
 * (= oscar env + `PAPER_TP_REGIME_ENABLED=1`). Uses dense `*_pair_snapshots` like `paper2-counterfactual-pg`.
 *
 * This fixes the “only 1 trade in paper2-strategy-backtest” confusion: that script needs full
 * `open→close` pairs **per file**; discovery/eval noise does not create lifecycles — here we only need opens.
 *
 *   cd solana-alpha && npx tsx src/scripts/paper2-universe-strategy-matrix.ts --since-hours 48 \
 *     --dir data/paper2 --jsonl data/live/pt1-oscar-live.jsonl --step-ms 60000
 *
 * Optional:
 *   --no-ideal-grid     skip the brute-force TP/SL/trail/timeout/kill grid (Oscar DCA/ladder strings as reference)
 *   --buffer-hours H    PG fetch padding after max timeout (default 8)
 *
 * Requires DATABASE_URL (same DB as collectors).
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
  if (kind === 'open') {
    return { strategyId: sid, open: e };
  }
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

type StrategyProfile = { label: string; envPatch: Record<string, string> };

function pm2StrategyProfiles(): StrategyProfile[] {
  const apps = ecosystem.apps ?? [];
  const want = new Set(['pt1-diprunner', 'pt1-oscar', 'pt1-dno', 'live-oscar']);
  const out: StrategyProfile[] = [];
  for (const app of apps) {
    const name = app.name;
    if (!name || !want.has(name) || !app.env) continue;
    out.push({ label: name, envPatch: stringifyEnv(app.env as Record<string, unknown>) });
  }
  const oscar = out.find((p) => p.label === 'pt1-oscar');
  if (oscar) {
    out.push({
      label: 'pt1-oscar-regime',
      envPatch: { ...oscar.envPatch, PAPER_STRATEGY_ID: 'pt1-oscar-regime', PAPER_TP_REGIME_ENABLED: '1' },
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function loadCfgAndExitStrings(profile: StrategyProfile): {
  cfg: PaperTraderConfig;
  dcaLevels: ReturnType<typeof parseDcaLevels>;
  tpLadder: ReturnType<typeof parseTpLadder>;
} {
  return withEnvPatch(profile.envPatch, () => {
    const cfg = loadPaperTraderConfig();
    const dcaLevels = parseDcaLevels(process.env.PAPER_DCA_LEVELS);
    const tpLadder = parseTpLadder(process.env.PAPER_TP_LADDER);
    return { cfg, dcaLevels, tpLadder };
  });
}

/** Same combo space as `paper2-strategy-backtest.ts` grid quick. */
const GRID_QUICK = {
  tpX: [2.0, 2.5, 3.0],
  slX: [0.55, 0.65, 0.75],
  trailTriggerX: [1.12, 1.18, 1.25],
  trailDrop: [0.18, 0.22, 0.28],
  timeoutHours: [18, 36],
  dcaKillstop: [-0.5, -0.62],
};

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 48);
  if (!Number.isFinite(sinceH) || sinceH <= 0) {
    console.error(
      'Usage: tsx src/scripts/paper2-universe-strategy-matrix.ts --since-hours 48 [--dir data/paper2] [--jsonl paths...] [--step-ms 60000] [--buffer-hours 8] [--no-ideal-grid]',
    );
    process.exit(1);
  }
  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);
  const runIdealGrid = !flag('--no-ideal-grid');

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
    console.error('No jsonl paths (use --dir and/or --jsonl).');
    process.exit(1);
  }

  const profiles = pm2StrategyProfiles();
  if (profiles.length < 4) {
    console.error('Expected PM2 env blocks for pt1-diprunner, pt1-oscar, pt1-dno, live-oscar in ecosystem.config.cjs');
    process.exit(1);
  }

  const cfgsMeta = profiles.map((p) => ({ label: p.label, ...loadCfgAndExitStrings(p) }));
  const maxTimeoutH = Math.max(...cfgsMeta.map((m) => m.cfg.timeoutHours)) + bufferHours;

  const sinceTs = Date.now() - sinceH * 3_600_000;
  const rawOpens: Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string }> = [];
  for (const p of paths) {
    rawOpens.push(...(await scanOpensFromFile(p, sinceTs)));
  }

  const byFile = new Map<string, number>();
  for (const row of rawOpens) {
    byFile.set(row.pathLabel, (byFile.get(row.pathLabel) ?? 0) + 1);
  }

  const dedupe = new Map<string, { strategyId: string; open: Record<string, unknown>; pathLabel: string }>();
  for (const row of rawOpens) {
    const ot = row.open;
    const mint = String(ot.mint ?? '');
    const entryTs = Number(ot.entryTs ?? 0);
    const k = `${mint}:${entryTs}`;
    if (!mint || !Number.isFinite(entryTs)) continue;
    if (!dedupe.has(k)) dedupe.set(k, row);
  }
  const universe = [...dedupe.values()];

  console.log(`\n=== Universe × strategy matrix (${sinceH}h entry window, stepMs=${stepMs}) ===`);
  console.log(`Raw opens scanned: ${rawOpens.length}   unique mint:entryTs: ${universe.length}`);
  console.log(`Opens by journal file: ${JSON.stringify(Object.fromEntries([...byFile.entries()].sort()), null, 0)}`);
  console.log(`PM2 strategies: ${profiles.map((p) => p.label).join(', ')}`);
  console.log(`PG fetch horizon: entry + ${maxTimeoutH.toFixed(1)}h (max timeout + buffer)\n`);

  const oscarSnap = cfgsMeta.find((m) => m.label === 'pt1-oscar');
  if (oscarSnap) {
    const c = oscarSnap.cfg;
    console.log(
      `PM2 pt1-oscar exit snapshot (not necessarily inside quick grid): tpX=${c.tpX} slX=${c.slX} trailTrig=${c.trailTriggerX} trailDrop=${c.trailDrop} timeoutH=${c.timeoutHours} kill=${c.dcaKillstop} trailMode=${c.trailMode} tpGridStep=${c.tpGridStepPnl}\n`,
    );
  }

  type Prepared =
    | { mint: string; entryTs: number; src: string; anchors: Anchor[]; baseOt: ReturnType<typeof cloneOpenFromJournal> }
    | null;

  const prepared: Prepared[] = [];
  for (const row of universe) {
    let baseOt;
    try {
      baseOt = cloneOpenFromJournal(row.open);
    } catch {
      prepared.push(null);
      continue;
    }
    const mint = baseOt.mint;
    const entryTs = baseOt.entryTs;
    const src = String(row.open.source ?? '').trim();
    const endTs = entryTs + maxTimeoutH * 3_600_000;
    const anchors = await fetchMintPriceAnchorsPg({ mint, source: src, entryTs, endTs });
    if (!sourceSnapshotTable(src) || anchors.length < 2) {
      prepared.push(null);
      continue;
    }
    prepared.push({ mint, entryTs, src, anchors, baseOt });
  }

  const matrixSum = new Map<string, number>();
  const matrixN = new Map<string, number>();
  const detailLines: string[] = [];

  for (const meta of cfgsMeta) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < universe.length; i++) {
      const prep = prepared[i];
      if (!prep) continue;
      const ct = simulateLifecycle({
        baseOt: prep.baseOt,
        anchors: prep.anchors,
        cfg: meta.cfg,
        dcaLevels: meta.dcaLevels,
        tpLadder: meta.tpLadder,
        stepMs,
      });
      if (!ct) continue;
      n++;
      s += ct.netPnlUsd;
      detailLines.push(
        `${meta.label} ${prep.mint.slice(0, 8)} ${prep.baseOt.symbol} sim=${ct.netPnlUsd.toFixed(2)} ${ct.exitReason} src=${prep.src}`,
      );
    }
    matrixSum.set(meta.label, s);
    matrixN.set(meta.label, n);
  }

  console.log('=== Per-strategy (same universe, each row = PM2 exit rules + sizing from that profile) ===');
  const ranked = [...matrixSum.entries()].sort((a, b) => b[1] - a[1]);
  for (const [label, sum] of ranked) {
    const n = matrixN.get(label) ?? 0;
    console.log(`  ${label}: n=${n} sum=$${sum.toFixed(2)} avg=$${n ? (sum / n).toFixed(2) : 'n/a'}`);
  }

  const oscarMeta = cfgsMeta.find((m) => m.label === 'pt1-oscar');
  if (runIdealGrid && oscarMeta) {
    console.log(
      '\n=== Grid search (quick — small TP/sl/trail/timeout/kill space; does NOT include e.g. tpX=100 or 4h timeout) ===',
    );
    console.log('Ref DCA / discrete ladder / fee model: pt1-oscar PM2 env.\n');
    let bestSum = -Infinity;
    let bestParams: Record<string, number> = {};
    let count = 0;
    for (const tpX of GRID_QUICK.tpX) {
      for (const slX of GRID_QUICK.slX) {
        for (const trailTriggerX of GRID_QUICK.trailTriggerX) {
          for (const trailDrop of GRID_QUICK.trailDrop) {
            for (const timeoutHours of GRID_QUICK.timeoutHours) {
              for (const dcaKillstop of GRID_QUICK.dcaKillstop) {
                count++;
                const trialCfg: PaperTraderConfig = {
                  ...oscarMeta.cfg,
                  tpX,
                  slX,
                  trailTriggerX,
                  trailDrop,
                  timeoutHours,
                  dcaKillstop,
                };
                let sum = 0;
                for (let i = 0; i < universe.length; i++) {
                  const prep = prepared[i];
                  if (!prep) continue;
                  const anchorsEnd = prep.entryTs + (timeoutHours + bufferHours) * 3_600_000;
                  let anchors = prep.anchors.filter((a) => a.ts <= anchorsEnd);
                  if (anchors.length < 2) anchors = prep.anchors;
                  const ct = simulateLifecycle({
                    baseOt: prep.baseOt,
                    anchors,
                    cfg: trialCfg,
                    dcaLevels: oscarMeta.dcaLevels,
                    tpLadder: oscarMeta.tpLadder,
                    stepMs,
                  });
                  if (ct) sum += ct.netPnlUsd;
                }
                if (sum > bestSum) {
                  bestSum = sum;
                  bestParams = { tpX, slX, trailTriggerX, trailDrop, timeoutHours, dcaKillstop };
                }
              }
            }
          }
        }
      }
    }
    console.log(`Evaluated ${count} combos (Oscar ladder/DCA/grid strings fixed).`);
    console.log(`Best sum netPnlUsd inside this grid: ${bestSum.toFixed(2)}`);
    console.log(`Best params: ${JSON.stringify(bestParams, null, 2)}`);
    const oscarActual = matrixSum.get('pt1-oscar');
    if (oscarActual != null) {
      console.log(
        `Delta (grid-best − PM2 pt1-oscar matrix row): ${(bestSum - oscarActual).toFixed(2)} $ — negative means real PM2 params beat this grid.`,
      );
    }
  } else if (!oscarMeta) {
    console.log('\n(skip ideal grid: pt1-oscar profile missing)');
  }

  if (flag('--verbose')) {
    console.log('\n--- per-trade lines ---');
    detailLines.sort();
    for (const ln of detailLines) console.log(ln);
  }

  const skipped = prepared.filter((p) => !p).length;
  console.log(`\nSkipped (no PG path): ${skipped} / ${universe.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
