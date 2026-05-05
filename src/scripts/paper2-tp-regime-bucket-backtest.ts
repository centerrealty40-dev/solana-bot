/**
 * Backtest: classify each **historical** entry with the same TP-regime logic as paper Oscar
 * (`stampTpRegimeAtHistoricalEntry` = PG path ending at entry, lookback `PAPER_TP_REGIME_LOOKBACK_MIN`, default 720m).
 *
 * For each close in the journal:
 * 1. Bucket: down | sideways | up | unknown
 * 2. Realized journal net (actual)
 * 3. PG replay `simulateLifecycle` **without** regime overrides (flat grid / global kill)
 * 4. PG replay **with** regime overrides stamped at entry (down → 1 rung + optional kill; sideways → max 2 rungs)
 *
 * Compare totals and per-bucket sums to see if the fork adds value on top of “idealized” params from env.
 *
 *   cd solana-alpha && npx tsx src/scripts/paper2-tp-regime-bucket-backtest.ts \
 *     --since-hours 2000 --max-trades 80 --jsonl data/live/pt1-oscar-live.jsonl
 *
 * Env: load same as production Oscar (`PAPER_*`). For parity with paper regime fork set at least:
 *   PAPER_TP_REGIME_DOWN_DCA_KILLSTOP=-0.07
 *
 * Requires DATABASE_URL.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import { stampTpRegimeAtHistoricalEntry } from '../papertrader/pricing/tp-regime.js';
import type { OpenTrade } from '../papertrader/types.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import { cloneOpenFromJournal, simulateLifecycle } from './paper2-strategy-backtest.js';
import { scanJournal, type ClosedPair } from './paper2-loss-attribution-deep-dive.js';

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

function rowKey(p: ClosedPair): string {
  return `${p.mint}:${p.entryTs}:${p.exitTs}`;
}

function dedupePairs(pairs: ClosedPair[]): ClosedPair[] {
  const seen = new Set<string>();
  const out: ClosedPair[] = [];
  for (const p of pairs) {
    const k = rowKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function stripRegimeFields(open: Record<string, unknown>): Record<string, unknown> {
  const raw = { ...open };
  delete raw.tpRegime;
  delete raw.tpGridOverrides;
  delete raw.tpRegimeFeatures;
  return raw;
}

type Bucket = 'down' | 'sideways' | 'up' | 'unknown';

function aggLine(label: string, n: number, sum: number, wins: number): string {
  const avg = n ? sum / n : 0;
  const wr = n ? (100 * wins) / n : 0;
  return `  ${label.padEnd(12)} n=${String(n).padStart(4)} sum=$${sum.toFixed(2).padStart(10)} avg=$${avg.toFixed(2).padStart(7)} win%=${wr.toFixed(1).padStart(5)}`;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 720);
  const stepMs = Number(arg('--step-ms') ?? 30_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);
  const maxTrades = Number(arg('--max-trades') ?? 500);
  const strategySubstr = arg('--strategy-substr');

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
  paths = [...new Set(paths.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
  if (paths.length === 0) {
    console.error('Provide --jsonl and/or --dir');
    process.exit(1);
  }

  let cfg: PaperTraderConfig;
  try {
    cfg = loadPaperTraderConfig();
  } catch (e) {
    console.error('loadPaperTraderConfig:', (e as Error).message);
    process.exit(1);
  }

  const sinceCloseMs = Date.now() - sinceH * 3_600_000;
  const pairsRaw: ClosedPair[] = [];
  for (const p of paths) {
    pairsRaw.push(...(await scanJournal(p, sinceCloseMs)));
  }
  let pairs = dedupePairs(pairsRaw);
  if (strategySubstr) {
    pairs = pairs.filter((p) => {
      const o = p.openTrade as Record<string, unknown>;
      return String(o.strategyId ?? o.strategy_id ?? '').includes(strategySubstr);
    });
  }
  pairs.sort((a, b) => b.exitTs - a.exitTs);
  if (Number.isFinite(maxTrades) && maxTrades > 0) {
    pairs = pairs.slice(0, maxTrades);
  }

  const dcaLevels = parseDcaLevels(process.env.PAPER_DCA_LEVELS);
  const tpLadder = parseTpLadder(process.env.PAPER_TP_LADDER);

  console.log(`\n=== TP regime bucket backtest ===`);
  console.log(`Journal files: ${paths.length}  closes (deduped, capped): ${pairs.length}  since ${sinceH}h close window`);
  console.log(
    `Regime PG lookback: ${cfg.tpRegimeLookbackMin}m ending at entry | thresholds: down≤${cfg.tpRegimeDownNetPct}% net | up≥${cfg.tpRegimeUpNetPct}% | sideways |net|≤${cfg.tpRegimeSidewaysAbsNetPct}% & range≥${cfg.tpRegimeSidewaysMinRangePct}% | minSamples=${cfg.tpRegimeMinSamples}`,
  );
  console.log(
    `Sim: stepMs=${stepMs} timeout=${cfg.timeoutHours}h gridStep=${cfg.tpGridStepPnl} gridSell=${cfg.tpGridSellFraction} kill=${cfg.dcaKillstop} regimeKillDown=${cfg.tpRegimeDownDcaKillstop ?? 'none'}\n`,
  );

  type Row = {
    regime: Bucket;
    realized: number;
    simFlat: number | null;
    simReg: number | null;
  };
  const rows: Row[] = [];

  let nSkipSrc = 0;
  let nSkipClone = 0;
  let nSkipPg = 0;

  for (const pair of pairs) {
    const openRaw = pair.openTrade as Record<string, unknown>;

    const src = String(openRaw.source ?? '').trim();
    if (!src || !sourceSnapshotTable(src)) {
      nSkipSrc++;
      continue;
    }

    const stripped = stripRegimeFields(openRaw);
    let otBase: OpenTrade;
    try {
      otBase = cloneOpenFromJournal(stripped);
    } catch {
      nSkipClone++;
      continue;
    }

    const otLabel = cloneOpenFromJournal(stripped);
    await stampTpRegimeAtHistoricalEntry(cfg, otLabel);
    const regime = (otLabel.tpRegime ?? 'unknown') as Bucket;

    const endTs = otBase.entryTs + (cfg.timeoutHours + bufferHours) * 3_600_000;
    const anchors = await fetchMintPriceAnchorsPg({
      mint: otBase.mint,
      source: src,
      entryTs: otBase.entryTs,
      endTs,
    });
    if (anchors.length < 2) {
      nSkipPg++;
      rows.push({ regime, realized: pair.netUsd, simFlat: null, simReg: null });
      continue;
    }

    const otFlat = cloneOpenFromJournal(stripped);
    delete otFlat.tpRegime;
    delete otFlat.tpGridOverrides;
    delete otFlat.tpRegimeFeatures;

    const otReg = cloneOpenFromJournal(stripped);
    await stampTpRegimeAtHistoricalEntry(cfg, otReg);

    const ctFlat = simulateLifecycle({
      baseOt: otFlat,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    const ctReg = simulateLifecycle({
      baseOt: otReg,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });

    rows.push({
      regime,
      realized: pair.netUsd,
      simFlat: ctFlat ? ctFlat.netPnlUsd : null,
      simReg: ctReg ? ctReg.netPnlUsd : null,
    });
  }

  function roll(rs: Row[], pred: (r: Row) => boolean): { n: number; sumR: number } {
    let n = 0;
    let sumR = 0;
    for (const r of rs) {
      if (!pred(r)) continue;
      n++;
      sumR += r.realized;
    }
    return { n, sumR };
  }

  const buckets: Bucket[] = ['down', 'sideways', 'up', 'unknown'];
  console.log(`--- A) Реализованный журнал net PnL по классу входа (tp-regime @ entry) ---`);
  for (const b of buckets) {
    const x = roll(rows, (r) => r.regime === b);
    const wins = rows.filter((r) => r.regime === b && r.realized > 0).length;
    console.log(aggLine(b, x.n, x.sumR, wins));
  }
  const tot = roll(rows, () => true);
  const winsAll = rows.filter((r) => r.realized > 0).length;
  console.log(aggLine('ALL', tot.n, tot.sumR, winsAll));

  const simRows = rows.filter((r) => r.simFlat != null && r.simReg != null);
  console.log(`\n--- B) PG replay: без overrides vs с overrides режима (только строки с полным PG-путём, n=${simRows.length}) ---`);
  console.log(`  ${'bucket'.padEnd(12)} ${'n'.padStart(4)} ${'sumFlat'.padStart(12)} ${'sumReg'.padStart(12)} ${'Δ(reg-flat)'.padStart(14)}`);
  for (const b of buckets) {
    const sub = simRows.filter((r) => r.regime === b);
    const sf = sub.reduce((s, r) => s + (r.simFlat ?? 0), 0);
    const sg = sub.reduce((s, r) => s + (r.simReg ?? 0), 0);
    const d = sg - sf;
    console.log(
      `  ${b.padEnd(12)} ${String(sub.length).padStart(4)} ${('$' + sf.toFixed(2)).padStart(12)} ${('$' + sg.toFixed(2)).padStart(12)} ${('$' + (d >= 0 ? '+' : '') + d.toFixed(2)).padStart(14)}`,
    );
  }
  const sfAll = simRows.reduce((s, r) => s + (r.simFlat ?? 0), 0);
  const sgAll = simRows.reduce((s, r) => s + (r.simReg ?? 0), 0);
  console.log(
    `  ${'ALL'.padEnd(12)} ${String(simRows.length).padStart(4)} ${('$' + sfAll.toFixed(2)).padStart(12)} ${('$' + sgAll.toFixed(2)).padStart(12)} ${('$' + (sgAll - sfAll >= 0 ? '+' : '') + (sgAll - sfAll).toFixed(2)).padStart(14)}`,
  );

  console.log(`\n--- C) Интерпретация ---`);
  console.log(
    `  Если сумма «sumReg − sumFlat» по ALL близка к нулю или отрицательна при вашем N — форк режимов на этих кривых **не даёт** устойчивого улучшения vs те же env-параметры без overrides.`,
  );
  console.log(
    `  Если по классу **down** Δ заметно положительна при достаточном n — смысл включать режим в live для «падающего» пути; проверьте отдельно **unknown** (часто половина выборки).`,
  );
  console.log(`  Реализованный PnL по bucket ≠ качество режима (разные размеры позиций/выходы live); ориентир для go/no-go — блок B на одной модели симуляции.`);

  console.log(`\nSkipped: no snapshot source=${nSkipSrc} clone_fail=${nSkipClone} pg_sparse=${nSkipPg}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
