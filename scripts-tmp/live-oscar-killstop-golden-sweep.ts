/**
 * Live Oscar — сетка kill-stop по просадке к **текущей средней** (как `live-oscar-killstop-drawdown-grid.ts`),
 * но:
 *   - учитываем **закрытые** (`live_position_close`) и **ещё открытые** на конец журнала (последний `openTrade`
 *     из `live_position_open` / `live_position_scale_in` / `live_position_dca` / `live_position_partial_sell`);
 *   - для открытых окно цен: `[entryTs, min(now, entryTs+horizon)]`;
 *   - для каждого K считаем «ложный стоп»: стоп сработал, но **позже до конца окна** цена снова была
 *     **выше средней на момент стопа** (LONG мог бы выйти в плюс относительно той средней, если бы держали).
 *
 * Ограничение модели (как в drawdown-grid): **нет** частичных TP по пути — полный объём до стопа или до конца окна.
 *
 * Запуск (нужен Postgres со `*_pair_snapshots`, как у других live-скриптов):
 *   cd solana-alpha && set -a && . ./.env && set +a && npx tsx scripts-tmp/live-oscar-killstop-golden-sweep.ts data/live/pt1-oscar-live.jsonl
 *
 * Флаги:
 *   --horizon-hours 72   (по умолчанию 72 для открытых)
 *   --kill-min 3 --kill-max 25 --kill-step 1
 *   --opens-only         только ещё открытые на EOF (отладка)
 *   --closes-only        только закрытые
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { sourceSnapshotTable } from '../src/papertrader/dip-detector.js';

const TABLES: Record<string, string> = {
  pumpswap: 'pumpswap_pair_snapshots',
  raydium: 'raydium_pair_snapshots',
  orca: 'orca_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
};

const OPEN_KINDS = new Set([
  'live_position_open',
  'live_position_scale_in',
  'live_position_dca',
  'live_position_partial_sell',
]);

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || process.argv[i + 1] == null) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

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

interface SessionRow {
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
  /** closed | open_eof */
  sessionKind: 'closed' | 'open_eof';
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

function parseLegs(raw: unknown): Leg[] {
  if (!Array.isArray(raw)) return [];
  const legs: Leg[] = [];
  for (const lr of raw) {
    const x = lr as Record<string, unknown>;
    legs.push({
      ts: Number(x.ts ?? 0),
      price: Number(x.price ?? 0),
      sizeUsd: Number(x.sizeUsd ?? 0),
      reason: String(x.reason ?? ''),
    });
  }
  return legs;
}

function parseClosedRow(ct: Record<string, unknown>): SessionRow | null {
  const legs = parseLegs(ct.legs);
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
  const fallbackExit =
    effectiveExitPrice > 0 ? effectiveExitPrice : Number(ct.exitMcUsd ?? 0);
  if (!mint || !(entryTs > 0) || !(exitTs > 0) || typeof net !== 'number' || !(totalInvestedUsd > 0))
    return null;
  if (!Number.isFinite(fallbackExit) || !(fallbackExit > 0)) return null;
  return {
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
    sessionKind: 'closed',
  };
}

function syntheticOpenRow(ot: Record<string, unknown>, horizonMs: number): SessionRow | null {
  const mint = String(ot.mint ?? '');
  const entryTs = Number(ot.entryTs ?? 0);
  const totalInvestedUsd = Number(ot.totalInvestedUsd ?? 0);
  let dex = String(ot.dex ?? ot.source ?? 'pumpswap').toLowerCase().trim();
  if (!TABLES[dex]) dex = 'pumpswap';
  const legs = parseLegs(ot.legs);
  const now = Date.now();
  const exitTs = Math.min(now, entryTs + horizonMs);
  const costs = ot.costs as Record<string, unknown> | undefined;
  const feeBpsPerSide = Number(costs?.fee_bps_per_side ?? 30);
  const networkFeeUsd = Number(costs?.network_fee_usd_total ?? 0.002);
  const avg = Number(ot.avgEntry ?? ot.avgEntryMarket ?? 0);
  if (!mint || !(entryTs > 0) || !(totalInvestedUsd > 0) || !(exitTs > entryTs)) return null;
  const eff = Number.isFinite(avg) && avg > 0 ? avg : NaN;
  if (!Number.isFinite(eff)) return null;
  return {
    mint,
    entryTs,
    exitTs,
    netPnlUsd: 0,
    totalInvestedUsd,
    exitReason: 'OPEN_EOF',
    dex,
    legs,
    effectiveExitPrice: eff,
    feeBpsPerSide: Number.isFinite(feeBpsPerSide) ? feeBpsPerSide : 30,
    networkFeeUsd: Number.isFinite(networkFeeUsd) ? networkFeeUsd : 0.002,
    sessionKind: 'open_eof',
  };
}

/**
 * Полный симулятор: net, сработал ли стоп, и «восстановление» после стопа (цена > avgAtStop до exitTs).
 */
function simulateKillWithRecovery(
  c: SessionRow,
  tsMs: number[],
  px: number[],
  killPct: number,
): { netUsd: number; stopped: boolean; falseStop: boolean } {
  const legs = sortLegs(c.legs);
  let legIdx = 0;
  let inv = 0;
  let avg = 0;
  const thresholdFrac = -killPct / 100;

  const startIdx = bisectLeft(tsMs, c.entryTs);
  let stopBar = -1;
  let avgAtStop = 0;

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
      stopBar = i;
      avgAtStop = avg;
      const netUsd = estNetAtExit({
        investedUsd: inv,
        avgEntryPx: avg,
        exitPx: p,
        feeBpsPerSide: c.feeBpsPerSide,
        networkFeeUsdFullPosition: c.networkFeeUsd,
      });

      let maxPx = p;
      for (let j = i + 1; j < tsMs.length; j++) {
        if (tsMs[j]! > c.exitTs) break;
        if (px[j]! > maxPx) maxPx = px[j]!;
      }
      const falseStop = maxPx > avgAtStop;
      return { netUsd, stopped: true, falseStop };
    }
  }

  const idxEnd = idxAtOrBefore(tsMs, c.exitTs);
  const exitPx =
    idxEnd >= 0 ? px[idxEnd]! : c.effectiveExitPrice > 0 ? c.effectiveExitPrice : NaN;
  if (!Number.isFinite(exitPx)) {
    return { netUsd: Number.NaN, stopped: false, falseStop: false };
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
    return { netUsd: Number.NaN, stopped: false, falseStop: false };
  }

  const netUsd = estNetAtExit({
    investedUsd: inv,
    avgEntryPx: avg,
    exitPx,
    feeBpsPerSide: c.feeBpsPerSide,
    networkFeeUsdFullPosition: c.networkFeeUsd,
  });
  return { netUsd, stopped: false, falseStop: false };
}

async function replayJournal(
  jsonlPath: string,
  horizonMs: number,
): Promise<{ sessions: SessionRow[]; excludedAbsurd: number }> {
  const sessions: SessionRow[] = [];
  let excludedAbsurd = 0;
  const openByMint = new Map<string, Record<string, unknown>>();

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
    if (typeof o.strategyId === 'string' && o.strategyId !== 'live-oscar') continue;

    const kind = String(o.kind ?? '');
    if (kind === 'live_position_close') {
      const ct = o.closedTrade as Record<string, unknown> | undefined;
      if (!ct) continue;
      const row = parseClosedRow(ct);
      if (!row) continue;
      const absurd =
        !Number.isFinite(row.netPnlUsd) ||
        Math.abs(row.netPnlUsd) > Math.max(500_000, row.totalInvestedUsd * 50) ||
        row.exitReason === 'PERIODIC_HEAL';
      if (absurd) {
        excludedAbsurd++;
        continue;
      }
      sessions.push(row);
      openByMint.delete(String(ct.mint ?? ''));
      continue;
    }

    if (OPEN_KINDS.has(kind)) {
      const ot = o.openTrade as Record<string, unknown> | undefined;
      if (ot && typeof ot.mint === 'string') {
        openByMint.set(ot.mint as string, ot);
      }
    }
  }

  for (const ot of openByMint.values()) {
    const syn = syntheticOpenRow(ot, horizonMs);
    if (syn) sessions.push(syn);
  }

  return { sessions, excludedAbsurd };
}

type SimReady = SessionRow & { series: { tsMs: number[]; px: number[] } };

async function main(): Promise<void> {
  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const jsonlPath =
    posArgs[0]?.trim() && fs.existsSync(path.resolve(posArgs[0]))
      ? path.resolve(posArgs[0])
      : path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  if (!fs.existsSync(jsonlPath)) {
    console.error(JSON.stringify({ error: 'journal_missing', jsonlPath }, null, 2));
    process.exit(1);
  }

  const horizonHours = argNum('--horizon-hours', 72);
  const horizonMs = Math.round(horizonHours * 3600_000);
  const closesOnly = process.argv.includes('--closes-only');
  const opensOnly = process.argv.includes('--opens-only');
  const killGridPct = parseKillGridPct();

  const { sessions: allSessions, excludedAbsurd } = await replayJournal(jsonlPath, horizonMs);
  let sessions = allSessions;
  if (closesOnly) sessions = sessions.filter((s) => s.sessionKind === 'closed');
  if (opensOnly) sessions = sessions.filter((s) => s.sessionKind === 'open_eof');

  const actualSumClosed = sessions
    .filter((s) => s.sessionKind === 'closed')
    .reduce((a, s) => a + s.netPnlUsd, 0);

  const byMintDex = new Map<string, SessionRow[]>();
  for (const c of sessions) {
    const srcTable = sourceSnapshotTable(c.dex);
    if (!srcTable) continue;
    const k = `${c.mint}\t${c.dex}`;
    const arr = byMintDex.get(k) ?? [];
    arr.push(c);
    byMintDex.set(k, arr);
  }

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
    falseStopAfterHitCount: number;
    naturalExitCount: number;
    nanCount: number;
    vsActualClosedDelta: number;
  }> = [];

  for (const killPct of killGridPct) {
    let sum = 0;
    let stopped = 0;
    let falseStop = 0;
    let natural = 0;
    let nanC = 0;
    for (const c of simRows) {
      const r = simulateKillWithRecovery(c, c.series.tsMs, c.series.px, killPct);
      if (!Number.isFinite(r.netUsd)) {
        nanC++;
        continue;
      }
      sum += r.netUsd;
      if (r.stopped) {
        stopped++;
        if (r.falseStop) falseStop++;
      } else natural++;
    }
    perK.push({
      killDrawdownPct: killPct,
      sumModeledNetUsd: +sum.toFixed(4),
      stoppedCount: stopped,
      falseStopAfterHitCount: falseStop,
      naturalExitCount: natural,
      nanCount: nanC,
      vsActualClosedDelta: +(sum - actualSumClosed).toFixed(4),
    });
  }

  let best = perK[0]!;
  for (const row of perK) {
    if (row.nanCount > 0) continue;
    if (row.sumModeledNetUsd > best.sumModeledNetUsd) best = row;
  }

  const nClosed = sessions.filter((s) => s.sessionKind === 'closed').length;
  const nOpen = sessions.filter((s) => s.sessionKind === 'open_eof').length;

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        horizonHours,
        closesOnly,
        opensOnly,
        sessionsClosed: nClosed,
        sessionsOpenEof: nOpen,
        excludedJournalRows: excludedAbsurd,
        tradesWithSnapshots: simRows.length,
        missingSnapshotSeriesTrades: missingSeries,
        actualSumNetPnlUsd_closedOnly: +actualSumClosed.toFixed(4),
        killGridPct,
        bestKillDrawdownPct_maxSumModeledNetUsd: best.killDrawdownPct,
        bestSumModeledNetUsd: best.sumModeledNetUsd,
        bestVsActualClosedDelta: best.vsActualClosedDelta,
        bestFalseStopsAfterHit: best.falseStopAfterHitCount,
        perKillLevel: perK,
        modelNotes: [
          'Стоп: первая просадка цены к текущей средней (после ног с ts≤бара) ≤ −K%.',
          'Без частичных TP на пути.',
          'falseStopAfterHitCount: после срабатывания стопа цена снова поднималась выше avg на момент стопа до конца окна.',
          'vsActualClosedDelta: сумма(sim) − сумма(фактический net только по закрытым); открытые на EOF в факт не входят.',
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
