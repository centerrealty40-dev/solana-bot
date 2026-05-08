/**
 * Диагностика по одному mint: закрытые сделки из live JSONL + PG-снимки.
 * Grid по параметрам классического dip (окна, min/max %) и простым фильтрам buys/sells 5m.
 *
 * Запуск на VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *   npx tsx scripts-tmp/mint-entry-grid-research.ts <mint> [jsonlPath]
 *
 * Цель — не «предсказать будущее», а offline-подбор порога, максимизирующего сумму
 * исторических net по тем входам, где фильтр прошёл бы (наивный counterfactual).
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

const RECOVERY_WINDOWS_MIN_DEFAULT = [30, 60];
const DIP_MIN_IMPULSE_PCT = 12;
const RECOVERY_MAX_BOUNCE_PCT = 12;

const TABLES: Record<string, string> = {
  pumpswap: 'pumpswap_pair_snapshots',
  raydium: 'raydium_pair_snapshots',
  orca: 'orca_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
};

const WINDOW_PRESETS: Record<string, number[]> = {
  prod: [120, 360, 720],
  tight: [60, 120, 240],
  micro: [30, 60, 120],
  wide: [240, 480, 960],
  mixed: [90, 180, 360],
};

function quoteSqlIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`unsafe table: ${ident}`);
  return ident;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface TradeRow {
  entryTs: number;
  netPnlUsd: number;
  exitReason: string;
  dex: string;
  pairAddress: string | null;
  symbol: string;
  totalInvestedUsd: number;
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

function windowHighLow(tsMs: number[], px: number[], endIdx: number, winMin: number): [number, number] {
  const endT = tsMs[endIdx]!;
  const startT = endT - winMin * 60_000;
  const i0 = bisectLeft(tsMs, startT);
  let hi = 0;
  let lo = Number.POSITIVE_INFINITY;
  for (let j = i0; j <= endIdx; j++) {
    const p = px[j]!;
    if (p > hi) hi = p;
    if (p > 0 && p < lo) lo = p;
  }
  if (!Number.isFinite(lo)) lo = 0;
  return [hi, lo];
}

function dipOneWindow(
  price: number,
  hi: number,
  lo: number,
  dipMinDropPct: number,
  dipMaxDropPct: number,
): { ok: boolean; dipPct: number | null } {
  if (!(hi > 0)) return { ok: false, dipPct: null };
  const dipPct = (price / hi - 1) * 100;
  if (dipPct > dipMinDropPct) return { ok: false, dipPct };
  if (dipPct < dipMaxDropPct) return { ok: false, dipPct };
  const impulsePct = lo > 0 ? (hi / lo - 1) * 100 : null;
  if ((impulsePct ?? 0) < DIP_MIN_IMPULSE_PCT) return { ok: false, dipPct };
  return { ok: true, dipPct };
}

function passesDipGate(args: {
  snapPx: number;
  tsMs: number[];
  px: number[];
  idx: number;
  dipWindowsMin: number[];
  recoveryWindowsMin: number[];
  dipMin: number;
  dipMax: number;
  recoveryVeto: boolean;
}): { pass: boolean; usedW: number | null; dipPct: number | null } {
  const {
    snapPx,
    tsMs,
    px,
    idx,
    dipWindowsMin,
    recoveryWindowsMin,
    dipMin,
    dipMax,
    recoveryVeto,
  } = args;
  const allW = [...new Set([...dipWindowsMin, ...recoveryWindowsMin])].sort((a, b) => a - b);
  const ctx = new Map<number, [number, number]>();
  for (const w of allW) {
    ctx.set(w, windowHighLow(tsMs, px, idx, w));
  }
  let usedW: number | null = null;
  let lastDip: number | null = null;
  for (const w of dipWindowsMin) {
    const [hi, lo] = ctx.get(w)!;
    const r = dipOneWindow(snapPx, hi, lo, dipMin, dipMax);
    lastDip = r.dipPct;
    if (r.ok) {
      usedW = w;
      break;
    }
  }
  if (usedW == null) return { pass: false, usedW: null, dipPct: lastDip };

  if (recoveryVeto) {
    for (const v of recoveryWindowsMin) {
      if (v >= usedW) continue;
      const [_hi, lo] = ctx.get(v)!;
      if (!(lo > 0)) continue;
      const bounce = (snapPx / lo - 1) * 100;
      if (bounce >= RECOVERY_MAX_BOUNCE_PCT) return { pass: false, usedW, dipPct: lastDip };
    }
  }

  return { pass: true, usedW, dipPct: lastDip };
}

interface SnapSeries {
  tsMs: number[];
  px: number[];
  buys5m: number[];
  sells5m: number[];
  vol5m: number[];
}

async function loadSnapshotsForPair(
  mint: string,
  dex: string,
  pairAddress: string | null,
  tMinMs: number,
  tMaxMs: number,
): Promise<SnapSeries | null> {
  const src = dex.toLowerCase().trim();
  const table = TABLES[src] ?? TABLES.pumpswap!;
  const t = quoteSqlIdent(table);
  const mintEsc = sqlQuote(mint);
  const fromSec = (tMinMs / 1000).toFixed(3);
  const toSec = (tMaxMs / 1000).toFixed(3);

  const pairClause =
    pairAddress && String(pairAddress).trim()
      ? `AND pair_address = ${sqlQuote(String(pairAddress).trim())}`
      : '';

  const raw = await db.execute(dsql.raw(`
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms,
           COALESCE(price_usd, 0)::float AS price_usd,
           COALESCE(buys_5m, 0)::int AS buys_5m,
           COALESCE(sells_5m, 0)::int AS sells_5m,
           COALESCE(volume_5m, 0)::float AS vol_5m
    FROM ${t}
    WHERE base_mint = ${mintEsc}
      ${pairClause}
      AND ts >= to_timestamp(${fromSec}) AT TIME ZONE 'UTC'
      AND ts <= to_timestamp(${toSec}) AT TIME ZONE 'UTC'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `));

  const rows = raw as unknown as Array<{
    ts_ms: string | bigint;
    price_usd: number;
    buys_5m: number;
    sells_5m: number;
    vol_5m: number;
  }>;
  if (!rows.length) return null;

  const tsMs: number[] = [];
  const px: number[] = [];
  const buys5m: number[] = [];
  const sells5m: number[] = [];
  const vol5m: number[] = [];
  for (const r of rows) {
    const ts = typeof r.ts_ms === 'bigint' ? Number(r.ts_ms) : Number(r.ts_ms);
    tsMs.push(ts);
    px.push(r.price_usd);
    buys5m.push(Number(r.buys_5m ?? 0));
    sells5m.push(Number(r.sells_5m ?? 0));
    vol5m.push(Number(r.vol_5m ?? 0));
  }
  return { tsMs, px, buys5m, sells5m, vol5m };
}

function bsRatio(b: number, s: number): number {
  return b / Math.max(1, s);
}

async function main(): Promise<void> {
  const mint = process.argv[2]?.trim();
  const jsonlPath =
    process.argv[3]?.trim() || path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');
  if (!mint) {
    console.error('Usage: npx tsx scripts-tmp/mint-entry-grid-research.ts <mint> [jsonlPath]');
    process.exit(1);
  }

  const trades: TradeRow[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.kind !== 'live_position_close') continue;
    if (String(o.mint ?? '') !== mint) continue;
    const ct = o.closedTrade as Record<string, unknown> | undefined;
    if (!ct) continue;
    const legs = Array.isArray(ct.legs) ? (ct.legs as Record<string, unknown>[]) : [];
    const entryTs = legs.length ? Number(legs[0]!.ts ?? ct.entryTs ?? 0) : Number(ct.entryTs ?? 0);
    const net = ct.netPnlUsd;
    let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
    if (!TABLES[dex]) dex = 'pumpswap';
    const pairRaw = ct.pairAddress;
    const pairAddress =
      pairRaw != null && String(pairRaw).trim() ? String(pairRaw).trim() : null;
    if (!(entryTs > 0) || typeof net !== 'number') continue;
    trades.push({
      entryTs,
      netPnlUsd: net,
      exitReason: String(ct.exitReason ?? ''),
      dex,
      pairAddress,
      symbol: String(ct.symbol ?? ''),
      totalInvestedUsd: Number(ct.totalInvestedUsd ?? 0),
    });
  }

  trades.sort((a, b) => a.entryTs - b.entryTs);

  type EntryFeat = TradeRow & {
    idx: number;
    snapPx: number;
    dipPctProd: number | null;
    buys5m: number;
    sells5m: number;
    vol5m: number;
    bs: number;
    series: SnapSeries;
  };

  const enriched: EntryFeat[] = [];

  for (const tr of trades) {
    const maxWin = Math.max(...WINDOW_PRESETS.prod, ...WINDOW_PRESETS.wide);
    const tMin = tr.entryTs - (maxWin + 1440) * 60_000;
    const tMax = tr.entryTs + 120_000;

    let series =
      (await loadSnapshotsForPair(mint, tr.dex, tr.pairAddress, tMin, tMax)) ??
      (await loadSnapshotsForPair(mint, tr.dex, null, tMin, tMax));
    if (!series) continue;

    const idx = idxAtOrBefore(series.tsMs, tr.entryTs);
    if (idx < 0) continue;

    const gateProd = passesDipGate({
      snapPx: series.px[idx]!,
      tsMs: series.tsMs,
      px: series.px,
      idx,
      dipWindowsMin: WINDOW_PRESETS.prod,
      recoveryWindowsMin: RECOVERY_WINDOWS_MIN_DEFAULT,
      dipMin: -30,
      dipMax: -50,
      recoveryVeto: true,
    });

    enriched.push({
      ...tr,
      idx,
      snapPx: series.px[idx]!,
      dipPctProd: gateProd.dipPct,
      buys5m: series.buys5m[idx] ?? 0,
      sells5m: series.sells5m[idx] ?? 0,
      vol5m: series.vol5m[idx] ?? 0,
      bs: bsRatio(series.buys5m[idx] ?? 0, series.sells5m[idx] ?? 0),
      series,
    });
  }

  const dipMinGrid = [-40, -35, -30, -25, -20, -15, -12];
  const dipMaxGrid = [-55, -50, -45, -40];
  const minBsGrid = [0, 0.95, 1.0, 1.05, 1.1];
  const minBuysGrid = [0, 3, 5, 8];

  type GridRow = {
    windows: string;
    dipMin: number;
    dipMax: number;
    recoveryVeto: boolean;
    minBs: number;
    minBuys: number;
    passCount: number;
    sumNetIfTake: number;
    skippedNet: number;
  };

  const gridResults: GridRow[] = [];

  for (const [wName, dipWindowsMin] of Object.entries(WINDOW_PRESETS)) {
    for (const dipMin of dipMinGrid) {
      for (const dipMax of dipMaxGrid) {
        if (dipMax >= dipMin) continue;
        for (const recoveryVeto of [true, false]) {
          for (const minBs of minBsGrid) {
            for (const minBuys of minBuysGrid) {
              let passCount = 0;
              let sumNet = 0;
              let skippedNet = 0;
              for (const e of enriched) {
                const g = passesDipGate({
                  snapPx: e.snapPx,
                  tsMs: e.series.tsMs,
                  px: e.series.px,
                  idx: e.idx,
                  dipWindowsMin,
                  recoveryWindowsMin: RECOVERY_WINDOWS_MIN_DEFAULT,
                  dipMin,
                  dipMax,
                  recoveryVeto,
                });
                const bsOk = e.bs >= minBs && e.buys5m >= minBuys;
                if (g.pass && bsOk) {
                  passCount++;
                  sumNet += e.netPnlUsd;
                } else {
                  skippedNet += e.netPnlUsd;
                }
              }
              gridResults.push({
                windows: wName,
                dipMin,
                dipMax,
                recoveryVeto,
                minBs,
                minBuys,
                passCount,
                sumNetIfTake: +sumNet.toFixed(6),
                skippedNet: +skippedNet.toFixed(6),
              });
            }
          }
        }
      }
    }
  }

  gridResults.sort((a, b) => b.sumNetIfTake - a.sumNetIfTake);

  const sumAll = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  const winners = trades.filter((t) => t.netPnlUsd > 0);
  const oracleUpper = winners.reduce((s, t) => s + t.netPnlUsd, 0);

  console.log(
    JSON.stringify(
      {
        mint,
        jsonlPath,
        closesParsed: trades.length,
        closesWithSnapshots: enriched.length,
        symbol: enriched[0]?.symbol ?? trades[0]?.symbol ?? null,
        naiveTotals: {
          sumNetAllUsd: +sumAll.toFixed(6),
          wins: winners.length,
          losses: trades.length - winners.length,
          oracleUpperBoundTakeOnlyWinnersUsd: +oracleUpper.toFixed(6),
        },
        perTrade: enriched.map((e) => ({
          entryTs: e.entryTs,
          entryIso: new Date(e.entryTs).toISOString(),
          dex: e.dex,
          pairAddress: e.pairAddress,
          netPnlUsd: e.netPnlUsd,
          exitReason: e.exitReason,
          investedUsd: e.totalInvestedUsd,
          snapPx: e.snapPx,
          dipPctVsHigh_prodNeg30maxNeg50: e.dipPctProd,
          buys5m: e.buys5m,
          sells5m: e.sells5m,
          buySellRatio: +e.bs.toFixed(4),
          vol5mUsd: e.vol5m,
        })),
        topGateConfigsBySumNet: gridResults.slice(0, 25),
        notes: [
          'sumNetIfTake — сумма исторических net только по сделкам, прошедшим gate (наивно).',
          'oracleUpperBound — если бы вошли только в прибыльные закрытия (верхняя граница, не исполнимо).',
          'Фильтры buys/sell/vol — на минуте входа по строке PG; при pair mismatch см. dex/pair в perTrade.',
        ],
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
