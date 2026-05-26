/**
 * По закрытым live-сделкам: максимальная просадка цены к **текущей** средней (после ног по времени)
 * на дискретном ряду из Postgres — в том же духе, что simulateKillDrawdown в
 * live-oscar-killstop-drawdown-grid.ts (все ноги журнала, порядок по ts).
 *
 * Нужно, чтобы отделить:
 * - «стоп K% ни разу не сработал» (первое касание −K% на барах до exitTs)
 * от
 * - «цена никогда не уходила глубже −K% от средней» (ложная интуиция).
 *
 * VPS: cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *   npx tsx scripts-tmp/live-oscar-max-drawdown-from-avg-report.ts data/live/pt1-oscar-live.jsonl
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

interface Leg {
  ts: number;
  price: number;
  sizeUsd: number;
  reason: string;
}

interface CloseRow {
  mint: string;
  entryTs: number;
  exitTs: number;
  netPnlUsd: number;
  totalInvestedUsd: number;
  exitReason: string;
  dex: string;
  legs: Leg[];
  effectiveExitPrice: number;
  feeBpsPerSide: number;
  networkFeeUsd: number;
}

function quoteSqlIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`unsafe table: ${ident}`);
  return ident;
}

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

function applyLeg(inv: number, avg: number, leg: Leg): { inv: number; avg: number } {
  if (!(leg.price > 0) || !(leg.sizeUsd > 0)) return { inv, avg };
  const tokens = inv / avg;
  const addTokens = leg.sizeUsd / leg.price;
  const newInv = inv + leg.sizeUsd;
  const newAvg = newInv / (tokens + addTokens);
  return { inv: newInv, avg: newAvg };
}

function sortLegs(legs: Leg[]): Leg[] {
  return [...legs].sort((a, b) => a.ts - b.ts || 0);
}

function estNetAtExit(params: {
  investedUsd: number;
  avgEntryPx: number;
  exitPx: number;
  feeBpsPerSide: number;
  networkFeeUsdFullPosition: number;
}): number {
  const { investedUsd, avgEntryPx, exitPx, feeBpsPerSide, networkFeeUsdFullPosition } = params;
  const qty = investedUsd / avgEntryPx;
  const grossProceeds = qty * exitPx;
  const feeFrac = (feeBpsPerSide * 2) / 10_000;
  const feeUsd = grossProceeds * feeFrac;
  return grossProceeds - investedUsd - feeUsd - networkFeeUsdFullPosition;
}

/** Худшая просадка от средней в процентах (положительное число): max over bars of -(p/avg - 1) * 100. */
function maxDrawdownPctFromAvgAlongPath(
  c: CloseRow,
  tsMs: number[],
  px: number[],
): { maxDdPct: number; minDdFrac: number; modeledNaturalNetUsd: number } {
  const legs = sortLegs(c.legs);
  let legIdx = 0;
  let inv = 0;
  let avg = 0;

  let minDdFrac = 0;
  const startIdx = bisectLeft(tsMs, c.entryTs);

  for (let i = startIdx; i < tsMs.length; i++) {
    const t = tsMs[i]!;
    if (t > c.exitTs) break;
    const p = px[i]!;

    while (legIdx < legs.length && legs[legIdx]!.ts <= t) {
      const leg = legs[legIdx]!;
      legIdx++;
      if (inv <= 0 || avg <= 0) {
        const n = applyLeg(0, leg.price, leg);
        inv = n.inv;
        avg = n.avg;
      } else {
        const n = applyLeg(inv, avg, leg);
        inv = n.inv;
        avg = n.avg;
      }
    }

    if (!(inv > 0) || !(avg > 0)) continue;
    const ddFrac = p / avg - 1;
    if (ddFrac < minDdFrac) minDdFrac = ddFrac;
  }

  const idxEnd = idxAtOrBefore(tsMs, c.exitTs);
  const exitPx =
    idxEnd >= 0 ? px[idxEnd]! : c.effectiveExitPrice > 0 ? c.effectiveExitPrice : NaN;

  while (legIdx < legs.length) {
    const leg = legs[legIdx]!;
    legIdx++;
    if (inv <= 0 || avg <= 0) {
      const n = applyLeg(0, leg.price, leg);
      inv = n.inv;
      avg = n.avg;
    } else {
      const n = applyLeg(inv, avg, leg);
      inv = n.inv;
      avg = n.avg;
    }
  }

  let modeledNaturalNetUsd = Number.NaN;
  if (Number.isFinite(exitPx) && inv > 0 && avg > 0) {
    modeledNaturalNetUsd = estNetAtExit({
      investedUsd: inv,
      avgEntryPx: avg,
      exitPx,
      feeBpsPerSide: c.feeBpsPerSide,
      networkFeeUsdFullPosition: c.networkFeeUsd,
    });
  }

  const maxDdPct = -minDdFrac * 100;
  return { maxDdPct, minDdFrac, modeledNaturalNetUsd };
}

async function loadCloses(jsonlPath: string): Promise<{ rows: CloseRow[]; excludedAbsurd: number }> {
  const out: CloseRow[] = [];
  let excludedAbsurd = 0;

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
    const ct = o.closedTrade as Record<string, unknown> | undefined;
    if (!ct) continue;

    const legsRaw = ct.legs as unknown;
    if (!Array.isArray(legsRaw)) continue;
    const legs: Leg[] = [];
    for (const lr of legsRaw) {
      const x = lr as Record<string, unknown>;
      legs.push({
        ts: Number(x.ts ?? 0),
        price: Number(x.price ?? 0),
        sizeUsd: Number(x.sizeUsd ?? 0),
        reason: String(x.reason ?? ''),
      });
    }

    const mint = String(ct.mint ?? '');
    const entryTs = Number(ct.entryTs ?? 0);
    const exitTs = Number(ct.exitTs ?? 0);
    const net = ct.netPnlUsd;
    const totalInvestedUsd = Number(ct.totalInvestedUsd ?? 0);
    const exitReason = String(ct.exitReason ?? '');
    const effectiveExitPrice = Number(ct.effective_exit_price ?? ct.effectiveExitPrice ?? 0);

    const costs = ct.costs as Record<string, unknown> | undefined;
    const feeBpsPerSide = Number(costs?.fee_bps_per_side ?? 30);
    const networkFeeUsd = Number(costs?.network_fee_usd_total ?? 0.002);

    let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
    if (!TABLES[dex]) dex = 'pumpswap';

    if (!mint || !(entryTs > 0) || !(exitTs > 0) || typeof net !== 'number' || !(totalInvestedUsd > 0))
      continue;

    const absurd =
      !Number.isFinite(net) ||
      Math.abs(net) > Math.max(500_000, totalInvestedUsd * 50) ||
      exitReason === 'PERIODIC_HEAL';
    if (absurd) {
      excludedAbsurd++;
      continue;
    }

    const fallbackExit =
      effectiveExitPrice > 0 ? effectiveExitPrice : Number(ct.exitMcUsd ?? 0);
    if (!Number.isFinite(fallbackExit) || !(fallbackExit > 0)) continue;

    out.push({
      mint,
      entryTs,
      exitTs,
      netPnlUsd: net,
      totalInvestedUsd,
      exitReason,
      dex,
      legs,
      effectiveExitPrice: fallbackExit,
      feeBpsPerSide: Number.isFinite(feeBpsPerSide) ? feeBpsPerSide : 30,
      networkFeeUsd: Number.isFinite(networkFeeUsd) ? networkFeeUsd : 0.002,
    });
  }

  return { rows: out, excludedAbsurd };
}

async function main(): Promise<void> {
  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const jsonlPath =
    posArgs[0]?.trim() && fs.existsSync(path.resolve(posArgs[0]))
      ? path.resolve(posArgs[0])
      : path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  const { rows: closes, excludedAbsurd } = await loadCloses(jsonlPath);

  const byMintDex = new Map<string, CloseRow[]>();
  for (const c of closes) {
    const k = `${c.mint}\t${c.dex}`;
    const arr = byMintDex.get(k) ?? [];
    arr.push(c);
    byMintDex.set(k, arr);
  }

  type Ready = CloseRow & { series: { tsMs: number[]; px: number[] } };
  const simRows: Ready[] = [];
  let missingSeries = 0;

  for (const [, arr] of byMintDex) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    const mint = arr[0]!.mint;
    const dex = arr[0]!.dex;
    const tMin = Math.min(...arr.map((x) => x.entryTs)) - 60_000;
    const tMax = Math.max(...arr.map((x) => x.exitTs)) + 120_000;

    const series = await loadSnapshotsForMint(mint, dex, tMin, tMax);
    if (!series) {
      missingSeries += arr.length;
      continue;
    }

    for (const c of arr) {
      simRows.push({ ...c, series });
    }
  }

  const thresholds = [8, 10, 12, 14, 16, 18, 20, 25, 30, 40, 50];

  const perTrade: Array<{
    mint: string;
    exitReason: string;
    actualNetPnlUsd: number;
    maxDrawdownPctFromAvg: number;
    modeledHoldToExitTsNetUsd: number;
  }> = [];

  let nanNatural = 0;
  let naturalNegativeCount = 0;

  for (const c of simRows) {
    const r = maxDrawdownPctFromAvgAlongPath(c, c.series.tsMs, c.series.px);
    if (!Number.isFinite(r.modeledNaturalNetUsd)) nanNatural++;
    else if (r.modeledNaturalNetUsd < 0) naturalNegativeCount++;

    perTrade.push({
      mint: c.mint,
      exitReason: c.exitReason,
      actualNetPnlUsd: +c.netPnlUsd.toFixed(4),
      maxDrawdownPctFromAvg: +r.maxDdPct.toFixed(4),
      modeledHoldToExitTsNetUsd: Number.isFinite(r.modeledNaturalNetUsd)
        ? +r.modeledNaturalNetUsd.toFixed(4)
        : Number.NaN,
    });
  }

  const countGe = (t: number) => perTrade.filter((x) => x.maxDrawdownPctFromAvg >= t - 1e-9).length;

  const buckets: Record<string, number> = {};
  for (const th of thresholds) {
    buckets[`pct_trades_maxDd_ge_${th}`] = countGe(th);
  }

  const sortedDd = [...perTrade].sort((a, b) => b.maxDrawdownPctFromAvg - a.maxDrawdownPctFromAvg);
  const top10WorstDd = sortedDd.slice(0, 10).map((x) => ({
    mint: x.mint,
    exitReason: x.exitReason,
    maxDrawdownPctFromAvg: x.maxDrawdownPctFromAvg,
    actualNetPnlUsd: x.actualNetPnlUsd,
  }));

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        closesUsed: closes.length,
        excludedJournalRows: excludedAbsurd,
        tradesWithSnapshots: simRows.length,
        missingSnapshotSeriesTrades: missingSeries,
        explanation: [
          'maxDrawdownPctFromAvg — худшая на дискретных барах [entryTs..exitTs] величина просадки цены к текущей средней после ног (как kill-drawdown скрипт), в процентах (положительное число).',
          'Это не то же самое, что «стоп K% сработал»: между снимками БД могли быть более глубокие минутные движения.',
          'modeledHoldToExitTsNetUsd — упрощённый PnL полного выхода по цене ряда на exitTs после всех ног (без частичных TP), для сравнения с фактом.',
          'Если для уровня K в kill-grid stoppedCount=0, это значит «ни на одном баре не было первого касания −K% до exitTs», а не «нет убыточных сделок на выходе».',
        ],
        summary: {
          trades: perTrade.length,
          naturalExitModeledNetNegativeCount: naturalNegativeCount,
          naturalExitModeledNetNanCount: nanNatural,
          ...buckets,
        },
        top10WorstDrawdownFromAvg: top10WorstDd,
        perTrade,
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
