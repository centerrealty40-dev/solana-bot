/**
 * Live Oscar — теоретический PnL при фиксированном kill-stop по просадке от текущей средней.
 *
 * Сетка: выходим полным объёмом при первом снимке цены, где нереализованная доходность
 * к **текущей** средней (с учётом ног, уже добавленных к этому моменту) ≤ −K%,
 * для K ∈ {3,4,...,15}. Если стоп не коснулся — выход по цене ряда на фактический exitTs
 * (fallback effective_exit_price).
 *
 * Ограничение модели: **не** воспроизводим частичные TP (лестницу) — позиция держится полным
 * объёмом до стопа или до финального времени выхода; это завышает риск просадки внутри сделки.
 *
 * Журнал: отбрасываем строки с нереалистичным netPnlUsd и PERIODIC_HEAL (как в соседнем скрипте).
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && npx tsx scripts-tmp/live-oscar-killstop-drawdown-grid.ts [jsonl]
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

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || process.argv[i + 1] == null) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

/** Парсинг `--kill-min 5 --kill-max 22 --kill-step 1` (по умолчанию 3…25 шаг 1). */
function parseKillGridPct(): number[] {
  const min = argNum('--kill-min', 3);
  const max = argNum('--kill-max', 25);
  const step = argNum('--kill-step', 1);
  const out: number[] = [];
  for (let x = min; x <= max + 1e-9; x += step) {
    const k = +x.toFixed(4);
    if (out.length === 0 || out[out.length - 1] !== k) out.push(k);
  }
  return out.length ? out : [8, 10, 12];
}

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

function applyLeg(inv: number, avg: number, leg: Leg): { inv: number; avg: number } {
  if (!(leg.price > 0) || !(leg.sizeUsd > 0)) return { inv, avg };
  const tokens = inv / avg;
  const addTokens = leg.sizeUsd / leg.price;
  const newInv = inv + leg.sizeUsd;
  const newAvg = newInv / (tokens + addTokens);
  return { inv: newInv, avg: newAvg };
}

/** Ноги по времени; одинаковый ts сохраняем порядок из журнала. */
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

/**
 * Модельный выход по стопу −killPct% от **текущей** средней после применения ног с ts ≤ barTime.
 */
function simulateKillDrawdown(
  c: CloseRow,
  tsMs: number[],
  px: number[],
  killPct: number,
): { netUsd: number; stopped: boolean } {
  const legs = sortLegs(c.legs);
  let legIdx = 0;
  let inv = 0;
  let avg = 0;

  const thresholdFrac = -killPct / 100;

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

    const dd = (p - avg) / avg;
    if (dd <= thresholdFrac) {
      return {
        netUsd: estNetAtExit({
          investedUsd: inv,
          avgEntryPx: avg,
          exitPx: p,
          feeBpsPerSide: c.feeBpsPerSide,
          networkFeeUsdFullPosition: c.networkFeeUsd,
        }),
        stopped: true,
      };
    }
  }

  const idxEnd = idxAtOrBefore(tsMs, c.exitTs);
  const exitPx =
    idxEnd >= 0 ? px[idxEnd]! : c.effectiveExitPrice > 0 ? c.effectiveExitPrice : NaN;
  if (!Number.isFinite(exitPx)) {
    return { netUsd: Number.NaN, stopped: false };
  }

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

  if (!(inv > 0) || !(avg > 0)) {
    return { netUsd: Number.NaN, stopped: false };
  }

  return {
    netUsd: estNetAtExit({
      investedUsd: inv,
      avgEntryPx: avg,
      exitPx,
      feeBpsPerSide: c.feeBpsPerSide,
      networkFeeUsdFullPosition: c.networkFeeUsd,
    }),
    stopped: false,
  };
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

  const killGridPct = parseKillGridPct();

  const { rows: closes, excludedAbsurd } = await loadCloses(jsonlPath);
  const actualSum = closes.reduce((a, c) => a + c.netPnlUsd, 0);

  const byMintDex = new Map<string, CloseRow[]>();
  for (const c of closes) {
    const k = `${c.mint}\t${c.dex}`;
    const arr = byMintDex.get(k) ?? [];
    arr.push(c);
    byMintDex.set(k, arr);
  }

  type SimReady = CloseRow & { series: { tsMs: number[]; px: number[] } };
  const simRows: SimReady[] = [];
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

  const perK: Array<{
    killDrawdownPct: number;
    sumModeledNetUsd: number;
    stoppedCount: number;
    naturalExitCount: number;
    nanCount: number;
    vsActualDelta: number;
  }> = [];

  for (const killPct of killGridPct) {
    let sum = 0;
    let stopped = 0;
    let natural = 0;
    let nanC = 0;
    for (const c of simRows) {
      const r = simulateKillDrawdown(c, c.series.tsMs, c.series.px, killPct);
      if (!Number.isFinite(r.netUsd)) {
        nanC++;
        continue;
      }
      sum += r.netUsd;
      if (r.stopped) stopped++;
      else natural++;
    }
    perK.push({
      killDrawdownPct: killPct,
      sumModeledNetUsd: +sum.toFixed(4),
      stoppedCount: stopped,
      naturalExitCount: natural,
      nanCount: nanC,
      vsActualDelta: +(sum - actualSum).toFixed(4),
    });
  }

  let best = perK[0]!;
  for (const row of perK) {
    if (row.nanCount > 0) continue;
    if (row.sumModeledNetUsd > best.sumModeledNetUsd) best = row;
  }

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        closesUsed: closes.length,
        excludedJournalRows: excludedAbsurd,
        tradesWithSnapshots: simRows.length,
        missingSnapshotSeriesTrades: missingSeries,
        actualSumNetPnlUsd: +actualSum.toFixed(4),
        killGridPct,
        bestKillDrawdownPct_theoreticalMaxSumModeledPnl: best.killDrawdownPct,
        bestSumModeledNetUsd: best.sumModeledNetUsd,
        bestVsActualDelta: best.vsActualDelta,
        perKillLevel: perK,
        modelNotes: [
          'Стоп: первая просадка рынка к текущей средней по позиции ≥ K% (LONG).',
          'Частичные TP в пути не моделируются — позиция «полная» до выхода.',
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
