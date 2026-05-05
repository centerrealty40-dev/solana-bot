/**
 * Counterfactual backtest: replay **current** `loadPaperTraderConfig()` rules on the **same mints**
 * that opened in paper/live journals, using a **dense USD price path from Postgres** (`*_pair_snapshots`).
 *
 * Unlike aggregating realized journal closes, this answers: “what would today’s params have done
 * on that price curve?” (no Jupiter verify defer, no capital rotate — deterministic costs model).
 *
 *   cd solana-alpha && npx tsx src/scripts/paper2-counterfactual-pg.ts --since-hours 72 \
 *     --dir data/paper2 --jsonl data/live/pt1-oscar-live.jsonl --step-ms 30000
 *
 * Optional:
 *   --regime-recompute   — clear journal tpRegime overrides and re-run `resolveTpRegimeForOpen` at entry (needs PG).
 *   --strategy-substr regime — only rows whose strategyId contains substring.
 *
 * Requires DATABASE_URL / `.env` DB credentials (same as collectors).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import { resolveTpRegimeForOpen } from '../papertrader/pricing/tp-regime.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import {
  cloneOpenFromJournal,
  simulateLifecycle,
} from './paper2-strategy-backtest.js';

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
  wallTs: number;
} | null {
  const kind = e.kind as string | undefined;
  const sid = typeof e.strategyId === 'string' ? e.strategyId : '';
  const wallTs = typeof e.ts === 'number' ? e.ts : 0;
  if (kind === 'open') {
    return { strategyId: sid, open: e, wallTs };
  }
  if (kind === 'live_position_open') {
    const ot = e.openTrade as Record<string, unknown> | undefined;
    if (!ot) return null;
    return { strategyId: sid || 'live-oscar', open: journalOpenToPaperShape(ot), wallTs };
  }
  return null;
}

async function scanOpensFromFile(
  filePath: string,
  sinceTs: number,
  strategySubstr: string | undefined,
): Promise<Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string; wallTs: number }>> {
  const pathLabel = path.basename(filePath);
  const out: Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string; wallTs: number }> = [];
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
    if (strategySubstr && !ex.strategyId.includes(strategySubstr)) continue;
    const entryTs = Number(ex.open.entryTs ?? 0);
    if (entryTs < sinceTs) continue;
    out.push({ strategyId: ex.strategyId, open: ex.open, pathLabel, wallTs: ex.wallTs });
  }
  return out;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 72);
  if (!Number.isFinite(sinceH) || sinceH <= 0) {
    console.error(
      'Usage: tsx src/scripts/paper2-counterfactual-pg.ts --since-hours 72 [--dir data/paper2] [--jsonl paths...] [--step-ms 30000] [--regime-recompute] [--strategy-substr oscar]',
    );
    process.exit(1);
  }
  const stepMs = Number(arg('--step-ms') ?? 30_000);
  const regimeRecompute = flag('--regime-recompute');
  const strategySubstr = arg('--strategy-substr');
  const bufferHours = Number(arg('--buffer-hours') ?? 8);

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
  const seen = new Set<string>();
  paths = [...new Set(paths.map((p) => path.resolve(p)))].filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return fs.existsSync(p);
  });
  if (paths.length === 0) {
    console.error('No jsonl paths (use --dir and/or --jsonl).');
    process.exit(1);
  }

  let cfg: PaperTraderConfig;
  try {
    cfg = loadPaperTraderConfig();
  } catch (err) {
    console.error('loadPaperTraderConfig failed:', (err as Error).message);
    process.exit(1);
  }

  const sinceTs = Date.now() - sinceH * 3_600_000;
  const dcaLevels = parseDcaLevels(process.env.PAPER_DCA_LEVELS);
  const tpLadder = parseTpLadder(process.env.PAPER_TP_LADDER);

  const opens: Array<{ strategyId: string; open: Record<string, unknown>; pathLabel: string }> = [];
  for (const p of paths) {
    const chunk = await scanOpensFromFile(p, sinceTs, strategySubstr);
    opens.push(...chunk.map(({ strategyId, open, pathLabel }) => ({ strategyId, open, pathLabel })));
  }

  console.log(`\n=== PG counterfactual (${sinceH}h entry window, stepMs=${stepMs}) ===`);
  console.log(`Opens scanned: ${opens.length}   regimeRecompute=${regimeRecompute}`);
  console.log(`Cfg snapshot: positionUsd=${cfg.positionUsd} tpGridStep=${cfg.tpGridStepPnl} gridSell=${cfg.tpGridSellFraction} trail=${cfg.trailMode} drop=${cfg.trailDrop} trig=${cfg.trailTriggerX} timeout=${cfg.timeoutHours}h kill=${cfg.dcaKillstop}\n`);

  let sumNet = 0;
  let nOk = 0;
  let nSkipNoSrc = 0;
  let nSkipNoPg = 0;
  const bySid = new Map<string, { n: number; sum: number }>();

  for (const row of opens) {
    const src = String(row.open.source ?? '').trim();
    if (!src || !sourceSnapshotTable(src)) {
      nSkipNoSrc++;
      continue;
    }
    let baseOt;
    try {
      baseOt = cloneOpenFromJournal(row.open);
    } catch {
      continue;
    }
    const mint = baseOt.mint;
    const entryTs = baseOt.entryTs;
    const endTs = entryTs + (cfg.timeoutHours + bufferHours) * 3_600_000;

    if (regimeRecompute && cfg.tpRegimeEnabled) {
      delete baseOt.tpRegime;
      delete baseOt.tpRegimeFeatures;
      delete baseOt.tpGridOverrides;
      await resolveTpRegimeForOpen(cfg, baseOt);
    }

    let anchors = await fetchMintPriceAnchorsPg({ mint, source: src, entryTs, endTs });
    if (anchors.length < 2) {
      nSkipNoPg++;
      console.warn(`skip no PG path: ${row.pathLabel} ${row.strategyId} ${mint.slice(0, 8)} src=${src}`);
      continue;
    }

    const ct = simulateLifecycle({
      baseOt,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    if (!ct) continue;
    nOk++;
    sumNet += ct.netPnlUsd;
    const agg = bySid.get(row.strategyId) ?? { n: 0, sum: 0 };
    agg.n++;
    agg.sum += ct.netPnlUsd;
    bySid.set(row.strategyId, agg);
    console.log(
      `${row.pathLabel} ${row.strategyId} ${mint.slice(0, 8)} ${baseOt.symbol} sim=${ct.netPnlUsd.toFixed(2)} ${ct.exitReason} partials=${ct.partialSells.length}`,
    );
  }

  console.log(`\n=== Totals (PG path + current cfg sim) ===`);
  console.log(`Simulated: ${nOk}   sumNet=$${sumNet.toFixed(2)}   avg=$${nOk ? (sumNet / nOk).toFixed(2) : 'n/a'}`);
  console.log(`Skipped (no source table): ${nSkipNoSrc}   skipped (no PG rows): ${nSkipNoPg}`);
  console.log('\nPer strategyId:');
  for (const [sid, v] of [...bySid.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${sid}: n=${v.n} sum=$${v.sum.toFixed(2)} avg=$${(v.sum / v.n).toFixed(2)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
