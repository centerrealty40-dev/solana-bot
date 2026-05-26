/**
 * Live Oscar — анализ DCA (усреднений) и контрфактуал «только open+scale_in, без DCA»
 * с фиксированным стопом от средней начальной цены.
 *
 * Цены — ряд pumpswap_pair_snapshots (и др.) как в live-oscar-dip-min-counterfactual-all.ts.
 *
 * Запуск на VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && npx tsx scripts-tmp/live-oscar-dca-killstop-analysis.ts [path/to/pt1-oscar-live.jsonl]
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

function quoteSqlIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`unsafe table: ${ident}`);
  return ident;
}

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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
  exitMcUsd: number;
  effectiveExitPrice: number;
  feeBpsPerSide: number;
  networkFeeUsd: number;
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

function initialNoDca(legs: Leg[]): { usd: number; avgPx: number } | null {
  const core = legs.filter((l) => l.reason === 'open' || l.reason === 'scale_in');
  if (!core.length) return null;
  let usd = 0;
  let pxQty = 0;
  for (const l of core) {
    if (!(l.price > 0) || !(l.sizeUsd > 0)) continue;
    usd += l.sizeUsd;
    pxQty += l.sizeUsd / l.price;
  }
  if (!(usd > 0) || !(pxQty > 0)) return null;
  return { usd, avgPx: usd / pxQty };
}

function hadDca(legs: Leg[]): boolean {
  return legs.some((l) => l.reason === 'dca');
}

/** Первый момент после entryTs, когда цена <= avgPx * (1 - K/100); иначе null. */
function firstStopHit(
  tsMs: number[],
  px: number[],
  entryTs: number,
  exitTs: number,
  avgPx: number,
  stopDropPct: number,
): { ts: number; px: number } | null {
  const threshold = avgPx * (1 - stopDropPct / 100);
  const i0 = bisectLeft(tsMs, entryTs);
  for (let i = i0; i < tsMs.length; i++) {
    const t = tsMs[i]!;
    if (t > exitTs) break;
    const p = px[i]!;
    if (p <= threshold) return { ts: t, px: p };
  }
  return null;
}

function pxAtOrBefore(tsMs: number[], px: number[], t: number): number | null {
  const idx = idxAtOrBefore(tsMs, t);
  if (idx < 0) return null;
  return px[idx]!;
}

function estNetPnlSimple(params: {
  initialUsd: number;
  avgEntryPx: number;
  exitPx: number;
  feeBpsPerSide: number;
  networkFeeUsdFullPosition: number;
  scaleNetwork: number;
}): number {
  const { initialUsd, avgEntryPx, exitPx, feeBpsPerSide, networkFeeUsdFullPosition, scaleNetwork } =
    params;
  const qty = initialUsd / avgEntryPx;
  const grossProceeds = qty * exitPx;
  const feeFrac = (feeBpsPerSide * 2) / 10_000;
  const feeUsd = grossProceeds * feeFrac;
  const netFee = networkFeeUsdFullPosition * scaleNetwork;
  return grossProceeds - initialUsd - feeUsd - netFee;
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
    const exitMcUsd = Number(ct.exitMcUsd ?? 0);
    const effectiveExitPrice = Number(ct.effective_exit_price ?? ct.effectiveExitPrice ?? 0);

    const costs = ct.costs as Record<string, unknown> | undefined;
    const feeBpsPerSide = Number(costs?.fee_bps_per_side ?? 30);
    const networkFeeUsd = Number(costs?.network_fee_usd_total ?? 0.002);

    let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
    if (!TABLES[dex]) dex = 'pumpswap';

    if (!mint || !(entryTs > 0) || !(exitTs > 0) || typeof net !== 'number' || !(totalInvestedUsd > 0))
      continue;

    /** Журнал может содержать артефакты reconcile/heal с нереалистичным PnL. */
    const absurd =
      !Number.isFinite(net) ||
      Math.abs(net) > Math.max(500_000, totalInvestedUsd * 50) ||
      exitReason === 'PERIODIC_HEAL';
    if (absurd) {
      excludedAbsurd++;
      continue;
    }

    const fallbackExit =
      effectiveExitPrice > 0 ? effectiveExitPrice : exitMcUsd > 0 ? exitMcUsd : NaN;
    if (!Number.isFinite(fallbackExit)) continue;

    out.push({
      mint,
      entryTs,
      exitTs,
      netPnlUsd: net,
      totalInvestedUsd,
      exitReason,
      dex,
      legs,
      exitMcUsd,
      effectiveExitPrice: fallbackExit,
      feeBpsPerSide: Number.isFinite(feeBpsPerSide) ? feeBpsPerSide : 30,
      networkFeeUsd: Number.isFinite(networkFeeUsd) ? networkFeeUsd : 0.002,
    });
  }

  return { rows: out, excludedAbsurd };
}

async function main(): Promise<void> {
  const jsonlPath =
    process.argv[2]?.trim() || path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  const { rows: closes, excludedAbsurd } = await loadCloses(jsonlPath);
  const actualSum = closes.reduce((a, c) => a + c.netPnlUsd, 0);

  const withDca = closes.filter((c) => hadDca(c.legs));
  const noDca = closes.filter((c) => !hadDca(c.legs));

  const sum = (arr: CloseRow[]) => arr.reduce((a, c) => a + c.netPnlUsd, 0);

  const byMintDex = new Map<string, CloseRow[]>();
  for (const c of closes) {
    const k = `${c.mint}\t${c.dex}`;
    const arr = byMintDex.get(k) ?? [];
    arr.push(c);
    byMintDex.set(k, arr);
  }

  const grid: number[] = [];
  for (let k = 4; k <= 35; k += 0.5) grid.push(+k.toFixed(1));

  type SimRow = CloseRow & {
    initialUsd: number;
    initialAvgPx: number;
    series: { tsMs: number[]; px: number[] };
  };

  const simRows: SimRow[] = [];
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
      const ini = initialNoDca(c.legs);
      if (!ini) continue;
      simRows.push({ ...c, initialUsd: ini.usd, initialAvgPx: ini.avgPx, series });
    }
  }

  function totalForStop(stopPct: number): { sumNet: number; hitStop: number; exitNatural: number } {
    let sumNet = 0;
    let hitStop = 0;
    let exitNatural = 0;
    for (const c of simRows) {
      const hit = firstStopHit(c.series.tsMs, c.series.px, c.entryTs, c.exitTs, c.initialAvgPx, stopPct);
      let exitPx: number;
      if (hit) {
        exitPx = hit.px;
        hitStop++;
      } else {
        const atExit = pxAtOrBefore(c.series.tsMs, c.series.px, c.exitTs);
        exitPx = atExit ?? c.effectiveExitPrice;
        exitNatural++;
      }
      const scaleNet = c.initialUsd / c.totalInvestedUsd;
      sumNet += estNetPnlSimple({
        initialUsd: c.initialUsd,
        avgEntryPx: c.initialAvgPx,
        exitPx,
        feeBpsPerSide: c.feeBpsPerSide,
        networkFeeUsdFullPosition: c.networkFeeUsd,
        scaleNetwork: scaleNet,
      });
    }
    return { sumNet, hitStop, exitNatural };
  }

  function totalNaturalExitOnly(): number {
    let sumNet = 0;
    for (const c of simRows) {
      const atExit = pxAtOrBefore(c.series.tsMs, c.series.px, c.exitTs);
      const exitPx = atExit ?? c.effectiveExitPrice;
      const scaleNet = c.initialUsd / c.totalInvestedUsd;
      sumNet += estNetPnlSimple({
        initialUsd: c.initialUsd,
        avgEntryPx: c.initialAvgPx,
        exitPx,
        feeBpsPerSide: c.feeBpsPerSide,
        networkFeeUsdFullPosition: c.networkFeeUsd,
        scaleNetwork: scaleNet,
      });
    }
    return sumNet;
  }

  let bestK = grid[0]!;
  let bestSum = -Infinity;
  let bestKConstrained: number | null = null;
  let bestSumConstrained = -Infinity;
  const curve: Array<{ stopPct: number; sumNetUsd: number; hitStop: number; exitNatural: number }> =
    [];
  for (const k of grid) {
    const r = totalForStop(k);
    curve.push({ stopPct: k, sumNetUsd: +r.sumNet.toFixed(4), hitStop: r.hitStop, exitNatural: r.exitNatural });
    if (r.sumNet > bestSum) {
      bestSum = r.sumNet;
      bestK = k;
    }
    if (r.hitStop >= 1 && r.sumNet > bestSumConstrained) {
      bestSumConstrained = r.sumNet;
      bestKConstrained = k;
    }
  }

  const baselineNoStopSum = totalNaturalExitOnly();

  const dcaDetail = withDca.map((c) => ({
    mint: c.mint.slice(0, 8),
    netPnlUsd: +c.netPnlUsd.toFixed(2),
    exitReason: c.exitReason,
    dcaLegs: c.legs.filter((l) => l.reason === 'dca').length,
    extraInvestedUsd: +(c.totalInvestedUsd - (initialNoDca(c.legs)?.usd ?? 0)).toFixed(2),
  }));

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        closesUsed: closes.length,
        journalRowsExcluded_absurdOrHeal: excludedAbsurd,
        actualSumNetPnlUsd: +actualSum.toFixed(4),
        missingSnapshotSeriesTrades: missingSeries,
        simulatedTrades: simRows.length,

        dcaVsNoDca_actualJournal: {
          withDcaCount: withDca.length,
          withDcaSumNetPnlUsd: +sum(withDca).toFixed(4),
          withDcaAvgNetPnlUsd: +(sum(withDca) / Math.max(withDca.length, 1)).toFixed(4),
          noDcaCount: noDca.length,
          noDcaSumNetPnlUsd: +sum(noDca).toFixed(4),
          noDcaAvgNetPnlUsd: +(sum(noDca) / Math.max(noDca.length, 1)).toFixed(4),
        },

        counterfactual_noDcaLegs_model: {
          meaning:
            'Позиция только по ногам open+scale_in (без DCA). Выход: при первом касании стопа −K% от средней начальной цены в окне [entryTs, exitTs]; иначе выход по цене ряда на exitTs (fallback effective_exit_price). Без лестницы частичных TP — упрощение.',
          note: 'Сравнение с фактическим total PnL условно: реальная стратегия другая (DCA, partials, trail).',
          baseline_noStop_useExitTimePrice: {
            sumNetUsd: +baselineNoStopSum.toFixed(4),
            vsActualDelta: +(baselineNoStopSum - actualSum).toFixed(4),
          },
          bestStopPctFromGrid_global: bestK,
          bestSumNetUsd_global: +bestSum.toFixed(4),
          vsActualDelta_global: +(bestSum - actualSum).toFixed(4),
          bestStopPct_amongStopsThatActuallyFire: bestKConstrained,
          bestSumNetUsd_whenStopFiresAtLeastOnce:
            bestKConstrained != null ? +bestSumConstrained.toFixed(4) : null,
          vsActualDelta_whenStopFiresAtLeastOnce:
            bestKConstrained != null ? +(bestSumConstrained - actualSum).toFixed(4) : null,
          gridSampleEvery2pct: curve.filter((_, i) => i % 4 === 0),
          top8StopsByModeledPnl: [...curve].sort((a, b) => b.sumNetUsd - a.sumNetUsd).slice(0, 8),
          fullGridCsvHint: 'use curve in JSON for spreadsheet',
        },

        withDcaTradeSummary: dcaDetail,

        interpretationHints: [
          'Если withDca суммарно хуже noDca по факту — усреднения на этом окне не помогли агрегату.',
          'Оптимальный K по сетке — локальный максимум суммарного упрощённого PnL под модель выше; не «истина», а ориентир.',
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
