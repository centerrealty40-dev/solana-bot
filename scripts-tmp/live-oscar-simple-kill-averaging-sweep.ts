/**
 * Простой бэктест по закрытым live-сделкам:
 * 1) Фиксированная сетка kill-stop: 5, 8, 10, 12, 15% от **текущей** средней (полная позиция до стопа или до exitTs).
 *    Ноги — как в журнале (по умолчанию все покупки: open + scale_in + dca).
 * 2) Лучший kill по сумме смоделированного net PnL.
 * 3) При этом kill — варианты «усреднения» **без синтетических докупок**:
 *    - только open+scale_in (журнальные DCA-ноги выкинуты);
 *    - полный журнал (open+scale_in+dca);
 *    - DCA-ноги из журнала только если непосредственно перед этой ногой средняя уже была ≥ X% выше цены ноги
 *      (т.е. усреднение по факту «в минусе от средней на X%»), X ∈ {3,5,8,10,12,15}.
 *
 * Цены: ряд `price_usd` из Postgres (как killstop-drawdown). Между снимками возможны более глубокие минутные просадки —
 * отдельный RPC/свечи в этом файле **не** подключаются (можно добавить позже).
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *     npx tsx scripts-tmp/live-oscar-simple-kill-averaging-sweep.ts data/live/pt1-oscar-live.jsonl
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

const BUY_REASONS = new Set(['open', 'scale_in', 'dca']);

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

/** Running avg после применения массива ног по порядку (уже отфильтрованных). */
function invAvgAfterQueue(legs: Leg[]): { inv: number; avg: number } {
  let inv = 0;
  let avg = 0;
  for (const leg of legs) {
    if (!BUY_REASONS.has(leg.reason)) continue;
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
  return { inv, avg };
}

/**
 * Очередь ног: все open+scale_in по порядку; каждая dca из журнала — только если к моменту ноги
 * средняя по уже включённым ногам ≥ minDdPct% выше цены этой dca-ноги.
 */
function buildLegQueueMinDdForDca(c: CloseRow, minDdPct: number): Leg[] {
  const sorted = sortLegs(c.legs).filter((l) => BUY_REASONS.has(l.reason));
  const out: Leg[] = [];
  for (const leg of sorted) {
    if (leg.reason === 'open' || leg.reason === 'scale_in') {
      out.push(leg);
      continue;
    }
    if (leg.reason !== 'dca') continue;
    const { inv, avg } = invAvgAfterQueue(out);
    if (!(inv > 0) || !(avg > 0)) continue;
    const ddPct = ((avg - leg.price) / avg) * 100;
    if (ddPct >= minDdPct - 1e-9) out.push(leg);
  }
  return sortLegs(out);
}

function legQueueOpenScaleOnly(c: CloseRow): Leg[] {
  return sortLegs(c.legs.filter((l) => l.reason === 'open' || l.reason === 'scale_in'));
}

function legQueueJournalBuys(c: CloseRow): Leg[] {
  return sortLegs(c.legs.filter((l) => BUY_REASONS.has(l.reason)));
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

function simulateKillDrawdown(
  c: CloseRow,
  tsMs: number[],
  px: number[],
  killPct: number,
  legsQueue: Leg[],
): { netUsd: number; stopped: boolean } {
  let legIdx = 0;
  let inv = 0;
  let avg = 0;

  const thresholdFrac = -killPct / 100;

  const startIdx = bisectLeft(tsMs, c.entryTs);
  for (let i = startIdx; i < tsMs.length; i++) {
    const t = tsMs[i]!;
    if (t > c.exitTs) break;
    const p = px[i]!;

    while (legIdx < legsQueue.length && legsQueue[legIdx]!.ts <= t) {
      const leg = legsQueue[legIdx]!;
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

  while (legIdx < legsQueue.length) {
    const leg = legsQueue[legIdx]!;
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

function aggregateKill(
  simRows: Array<CloseRow & { series: { tsMs: number[]; px: number[] } }>,
  killPct: number,
  legBuilder: (c: CloseRow) => Leg[],
): { sumNetUsd: number; stoppedCount: number; nanCount: number } {
  let sum = 0;
  let stopped = 0;
  let nanC = 0;
  for (const c of simRows) {
    const legsQ = legBuilder(c);
    const r = simulateKillDrawdown(c, c.series.tsMs, c.series.px, killPct, legsQ);
    if (!Number.isFinite(r.netUsd)) {
      nanC++;
      continue;
    }
    sum += r.netUsd;
    if (r.stopped) stopped++;
  }
  return { sumNetUsd: sum, stoppedCount: stopped, nanCount: nanC };
}

async function main(): Promise<void> {
  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const jsonlPath =
    posArgs[0]?.trim() && fs.existsSync(path.resolve(posArgs[0]))
      ? path.resolve(posArgs[0])
      : path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  const killGrid = [5, 8, 10, 12, 15];
  const dcaMinDdGrid = [3, 5, 8, 10, 12, 15];

  const { rows: closes, excludedAbsurd } = await loadCloses(jsonlPath);
  const actualSum = closes.reduce((a, c) => a + c.netPnlUsd, 0);

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

  const journalLegs = (c: CloseRow) => legQueueJournalBuys(c);

  const phase1 = killGrid.map((k) => {
    const agg = aggregateKill(simRows, k, journalLegs);
    return {
      killDrawdownPct: k,
      sumModeledNetUsd: +agg.sumNetUsd.toFixed(4),
      stoppedCount: agg.stoppedCount,
      nanCount: agg.nanCount,
      vsActualDelta: +(agg.sumNetUsd - actualSum).toFixed(4),
    };
  });

  let best = phase1[0]!;
  for (const row of phase1) {
    if (row.nanCount > 0) continue;
    if (row.sumModeledNetUsd > best.sumModeledNetUsd) best = row;
  }

  const bestKill = best.killDrawdownPct;

  type AvgRow = {
    label: string;
    sumModeledNetUsd: number;
    stoppedCount: number;
    nanCount: number;
    vsActualDelta: number;
  };

  const averagingVariants: Array<{ label: string; build: (c: CloseRow) => Leg[] }> = [
    { label: 'open_scale_in_only_no_journal_dca', build: legQueueOpenScaleOnly },
    { label: 'journal_all_buy_legs', build: legQueueJournalBuys },
    ...dcaMinDdGrid.map((pct) => ({
      label: `journal_dca_only_if_price_ge_${pct}pct_below_avg_at_leg`,
      build: (c: CloseRow) => buildLegQueueMinDdForDca(c, pct),
    })),
  ];

  const phase2: AvgRow[] = averagingVariants.map(({ label, build }) => {
    const agg = aggregateKill(simRows, bestKill, build);
    return {
      label,
      sumModeledNetUsd: +agg.sumNetUsd.toFixed(4),
      stoppedCount: agg.stoppedCount,
      nanCount: agg.nanCount,
      vsActualDelta: +(agg.sumNetUsd - actualSum).toFixed(4),
    };
  });

  phase2.sort((a, b) => b.sumModeledNetUsd - a.sumModeledNetUsd);
  const bestAveraging = phase2[0] ?? null;

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        priceSource: 'postgres_pair_snapshots_price_usd',
        rpcNote:
          'RPC/свечи не используются: только дискретные снимки БД; между точками возможны более глубокие просадки.',
        modelNotes: [
          'Полная позиция до kill или до exitTs; частичные TP не моделируются.',
          'Kill: первое касание (P-avg)/avg <= -K%.',
          'Фаза 1: все журнальные покупки (open+scale_in+dca).',
          'Фаза 2: без синтетических USD — только фильтрация реальных ног dca по условию «цена ноги ≥ X% ниже средней перед ногой».',
        ],
        closesUsed: closes.length,
        excludedJournalRows: excludedAbsurd,
        tradesWithSnapshots: simRows.length,
        missingSnapshotSeriesTrades: missingSeries,
        actualSumNetPnlUsd: +actualSum.toFixed(4),
        phase1_killSweep_journalBuyLegs: phase1,
        bestKillDrawdownPct: bestKill,
        phase2_averagingAtBestKill_sortedBestFirst: phase2,
        bestAveragingLabel: bestAveraging?.label ?? null,
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
