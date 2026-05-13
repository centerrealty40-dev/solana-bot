/**
 * Live Oscar — сравнение двух правил выхода **остатка** после лесенки TP (только closed trades):
 *
 * **A (pnl_floor)** — как baseline `ladder_retrace` в коде: пол = PnL-порог **на одну ступень ниже**
 * максимальной уже «взятої» ступени (по `ladderUsedLevels` / восстановлению из шага сетки).
 *
 * **B (prev_fill_price)** — «простая» эвристика: полный выход остатка при **первом** баре, где
 * цена ≤ **цены исполнения предыдущего** частичного TP (предпоследний partial по времени).
 *
 * Обе стратегии используют **одинаковые** частичные продажи до последнего TP из журнала; меняется только
 * момент закрытия мешка после **последнего** записанного TP_LADDER в этой строке закрытия.
 *
 * Нужен Postgres (`*_pair_snapshots`). Журнал: `data/live/pt1-oscar-live.jsonl` на сервере.
 *
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *     npx tsx scripts-tmp/live-oscar-retrace-pnl-vs-prev-fill.ts data/live/pt1-oscar-live.jsonl
 *
 * Опции:
 *   --grid-step 0.04   fallback если в close нет ladderUsedLevels (доля, 4% = 0.04)
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

const TABLES: Record<string, string> = {
  pumpswap: 'pumpswap_pair_snapshots',
  raydium: 'raydium_pair_snapshots',
  orca: 'orca_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
};

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  return process.argv[i + 1]!;
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function quoteSqlIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`unsafe table: ${ident}`);
  return ident;
}

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface PartialRow {
  ts: number;
  price: number;
  reason: string;
}

function bisectLeft(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function idxAtOrBefore(tsMs: number[], t: number): number {
  return bisectLeft(tsMs, t + 1) - 1;
}

async function loadSnapshotsForMint(
  mint: string,
  dex: string,
  tMinMs: number,
  tMaxMs: number,
): Promise<{ tsMs: number[]; px: number[] } | null> {
  const src = dex.toLowerCase().trim();
  const table = TABLES[src] ?? TABLES.pumpswap!;
  const t = quoteSqlIdent(table);
  const mintEsc = sqlQuoteMint(mint);
  const fromSec = (tMinMs / 1000).toFixed(3);
  const toSec = (tMaxMs / 1000).toFixed(3);

  const raw = await db.execute(dsql.raw(`
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms,
           COALESCE(price_usd, 0)::float AS price_usd
    FROM ${t}
    WHERE base_mint = ${mintEsc}
      AND ts >= to_timestamp(${fromSec}) AT TIME ZONE 'UTC'
      AND ts <= to_timestamp(${toSec}) AT TIME ZONE 'UTC'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `));

  const rows = raw as unknown as Array<{ ts_ms: string | bigint; price_usd: number }>;
  if (!rows.length) return null;

  const tsMs: number[] = [];
  const px: number[] = [];
  for (const r of rows) {
    const ts = typeof r.ts_ms === 'bigint' ? Number(r.ts_ms) : Number(r.ts_ms);
    tsMs.push(ts);
    px.push(r.price_usd);
  }
  return { tsMs, px };
}

function parseLadderLevels(ct: Record<string, unknown>): number[] {
  const raw = ct.ladderUsedLevels as unknown;
  if (Array.isArray(raw)) {
    const out: number[] = [];
    for (const x of raw) {
      const n = Number(x);
      if (Number.isFinite(n)) out.push(n);
    }
    return out.sort((a, b) => a - b);
  }
  return [];
}

function inferFiredFromStep(nPartials: number, gridStep: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= nPartials; i++) out.push(+(i * gridStep).toFixed(8));
  return out;
}

function floorPnlFromLevels(levels: number[], gridStepFallback: number, nPartials: number): number | null {
  if (levels.length >= 2) {
    const u = [...new Set(levels)].sort((a, b) => a - b);
    return u[u.length - 2]!;
  }
  if (levels.length === 1 && nPartials >= 2) {
    const mx = levels[0]!;
    return Math.max(0, +(mx - gridStepFallback).toFixed(8));
  }
  if (nPartials >= 2) {
    const inf = inferFiredFromStep(nPartials, gridStepFallback);
    return inf[inf.length - 2]!;
  }
  return null;
}

/**
 * После времени `afterTs`: первый бар с t<=horizonTs, где срабатывает условие.
 */
function firstExitPx(args: {
  tsMs: number[];
  px: number[];
  afterTs: number;
  horizonTs: number;
  pred: (p: number) => boolean;
}): { exitTs: number; exitPx: number } | null {
  const { tsMs, px, afterTs, horizonTs, pred } = args;
  const start = bisectLeft(tsMs, afterTs + 1);
  for (let i = start; i < tsMs.length; i++) {
    const t = tsMs[i]!;
    if (t > horizonTs) break;
    const p = px[i]!;
    if (pred(p)) return { exitTs: t, exitPx: p };
  }
  const j = idxAtOrBefore(tsMs, horizonTs);
  if (j < 0) return null;
  return { exitTs: tsMs[j]!, exitPx: px[j]! };
}

async function main(): Promise<void> {
  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const jsonlPath =
    posArgs[0]?.trim() && fs.existsSync(path.resolve(posArgs[0]))
      ? path.resolve(posArgs[0])
      : path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  if (!fs.existsSync(jsonlPath)) {
    console.error(JSON.stringify({ error: 'journal_missing', jsonlPath }));
    process.exit(1);
  }

  const gridStepFallback = argNum('--grid-step', 0.04);

  type Row = {
    mint: string;
    symbol: string;
    dex: string;
    entryTs: number;
    exitTs: number;
    avgEntry: number;
    netActual: number;
    partials: PartialRow[];
    levels: number[];
    totalInvestedUsd: number;
    remainingFractionAfterLastTp: number;
    actualExitPx: number;
  };

  const rows: Row[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.kind !== 'live_position_close') continue;
    if (typeof o.strategyId === 'string' && o.strategyId !== 'live-oscar') continue;
    const ct = o.closedTrade as Record<string, unknown> | undefined;
    if (!ct || typeof ct.mint !== 'string') continue;

    const net = Number(ct.netPnlUsd ?? 0);
    const exitReason = String(ct.exitReason ?? '');
    if (exitReason === 'PERIODIC_HEAL') continue;

    const avgEntry = Number(ct.avgEntry ?? 0);
    const entryTs = Number(ct.entryTs ?? 0);
    const exitTs = Number(ct.exitTs ?? 0);
    const totalInvestedUsd = Number(ct.totalInvestedUsd ?? 0);
    const effectiveExit = Number(ct.effective_exit_price ?? ct.effectiveExitPrice ?? 0);

    const legsRaw = ct.legs as unknown;
    const partialRaw = ct.partialSells as unknown;
    if (!Array.isArray(partialRaw)) continue;

    const partials: PartialRow[] = [];
    for (const pr of partialRaw) {
      const x = pr as Record<string, unknown>;
      partials.push({
        ts: Number(x.ts ?? 0),
        price: Number(x.price ?? 0),
        reason: String(x.reason ?? ''),
      });
    }
    const tpOnly = partials
      .filter((p) => p.reason === 'TP_LADDER')
      .sort((a, b) => a.ts - b.ts || 0);

    if (tpOnly.length < 2) continue;
    if (!(avgEntry > 0) || !(entryTs > 0) || !(exitTs > entryTs)) continue;

    let remFrac = 1;
    for (const pr of partialRaw as Record<string, unknown>[]) {
      if (String(pr.reason) !== 'TP_LADDER') continue;
      const sf = Number(pr.sellFraction ?? 0);
      if (sf > 0 && sf < 1) remFrac *= 1 - sf;
    }

    const levels = parseLadderLevels(ct);

    rows.push({
      mint: String(ct.mint),
      symbol: String(ct.symbol ?? ''),
      dex: String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase(),
      entryTs,
      exitTs,
      avgEntry,
      netActual: net,
      partials: tpOnly,
      levels,
      totalInvestedUsd,
      remainingFractionAfterLastTp: remFrac,
      actualExitPx: effectiveExit > 0 ? effectiveExit : Number(ct.exitMcUsd ?? 0),
    });
  }

  let nOk = 0;
  let sumBetterPnlFloorUsd = 0;
  let sumBetterPrevFillUsd = 0;
  let winsPnlFloor = 0;
  let winsPrevFill = 0;
  let ties = 0;

  const detail: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    let dex = r.dex;
    if (!TABLES[dex]) dex = 'pumpswap';

    const series = await loadSnapshotsForMint(r.mint, dex, r.entryTs - 60_000, r.exitTs + 60_000);
    if (!series || series.tsMs.length < 2) continue;

    const lastTp = r.partials[r.partials.length - 1]!;
    const prevTp = r.partials[r.partials.length - 2]!;
    const nP = r.partials.length;
    const floorFrac = floorPnlFromLevels(r.levels, gridStepFallback, nP);
    if (floorFrac == null) continue;

    const afterTs = lastTp.ts;
    const horizonTs = r.exitTs;

    const exitA = firstExitPx({
      tsMs: series.tsMs,
      px: series.px,
      afterTs,
      horizonTs,
      pred: (p) => p / r.avgEntry - 1 <= floorFrac + 1e-8,
    });
    const exitB = firstExitPx({
      tsMs: series.tsMs,
      px: series.px,
      afterTs,
      horizonTs,
      pred: (p) => p <= prevTp.price + 1e-12,
    });

    if (!exitA || !exitB) continue;

    const qtyUsd = r.totalInvestedUsd * r.remainingFractionAfterLastTp;
    if (!(qtyUsd > 0)) continue;

    const tokens = qtyUsd / r.avgEntry;
    const usdA = tokens * exitA.exitPx - qtyUsd;
    const usdB = tokens * exitB.exitPx - qtyUsd;

    nOk++;
    sumBetterPnlFloorUsd += usdA;
    sumBetterPrevFillUsd += usdB;
    const diff = usdA - usdB;
    if (diff > 1e-6) winsPnlFloor++;
    else if (diff < -1e-6) winsPrevFill++;
    else ties++;

    detail.push({
      mint: r.mint,
      symbol: r.symbol,
      nTp: nP,
      floorPnlFrac: floorFrac,
      prevFillPx: prevTp.price,
      exitA_px: exitA.exitPx,
      exitB_px: exitB.exitPx,
      usdRemainder_pnlFloor: +usdA.toFixed(4),
      usdRemainder_prevFill: +usdB.toFixed(4),
      diffUsd: +diff.toFixed(4),
    });
  }

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        gridStepFallback,
        tradesEligible: rows.length,
        tradesSimulatedRemainder: nOk,
        sumRemainderUsd_pnlFloorRule: +sumBetterPnlFloorUsd.toFixed(2),
        sumRemainderUsd_prevFillPriceRule: +sumBetterPrevFillUsd.toFixed(2),
        deltaSum_pnlFloor_minus_prevFill: +(sumBetterPnlFloorUsd - sumBetterPrevFillUsd).toFixed(2),
        wins_pnlFloorHigher: winsPnlFloor,
        wins_prevFillHigher: winsPrevFill,
        ties,
        conclusion:
          sumBetterPnlFloorUsd >= sumBetterPrevFillUsd
            ? 'На этой выборке **пол по ступени PnL** (правило A) даёт не меньший суммарный результат по остатку, чем **цена предыдущего fill** (B), если побеждает сумма и/или счёт wins.'
            : 'На этой выборке правило B выше по сумме — смотри wins/деталь.',
        caveat: [
          'Сравнивается только кусок PnL от **оставшегося** объёма после последней частичной TP_LADDER; комиссии упрощены.',
          'Правило A использует floor из ladderUsedLevels или (max−step) при одном уровне; иначе шаг из --grid-step.',
          'Если journal не содержит полной истории partial, результат смещается.',
        ],
        sample: detail.slice(0, 15),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
