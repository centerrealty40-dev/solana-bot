/**
 * Live Oscar — RETRO ANALYSIS v2 (с учётом РЕАЛЬНЫХ комиссий и slippage из journal).
 *
 * Что делает:
 *  1) REALITY-CHECK: воспроизводит фактические legs+partial-sells через snapshots — даёт оценку,
 *     насколько модель близка к реальному netPnl ($-86 в журнале). Чем ближе — тем доверительнее
 *     остальные ретро-выводы.
 *  2) Сетка вариантов:
 *       - DCA-схема входа: all_in, 90/10 @ -5, 80/20 @ -5, 70/30 @ -5/-8, 60/40 @ -7,
 *         50/50 @ -10, 33/33/33 @ -5/-10, real_legs.
 *       - TP-mode:
 *           a) ladder: ступени каждые 5% к avg, sellFrac ∈ {0.05, 0.075, 0.10, 0.15}, max ∈ {0.5, 1.0}.
 *           b) pure_trail: без лесенки; выход всего остатка при price ≤ peakPx × (1 − trail%).
 *             trail ∈ {5, 8, 10, 15, 20}.
 *       - Killstop: K ∈ {off, -8, -10, -12, -15, -18, -20, -25, -30}.
 *  3) Slippage и fees:
 *       - На каждом buy: fillPrice = price * (1 + slipBuyPct/100) (хуже для покупателя).
 *       - На каждом sell: fillPrice = price * (1 - slipSellPct/100) (хуже для продавца).
 *       - По умолчанию slipBuyPct=1.0, slipSellPct=5.0 — медианы из journal.
 *       - fee_bps_per_side из journal, иначе 20 bps (per side).
 *       - network_fee_usd_total из journal, иначе 0.0013.
 *
 * Запуск (нужен PG со `*_pair_snapshots`):
 *   set -a && . ./.env && set +a && \
 *   npx tsx scripts-tmp/live-oscar-universal-strategy-v2.ts data/live/pt1-oscar-live.jsonl
 *
 * Флаги:
 *   --slip-buy 1.0     (по умолчанию)
 *   --slip-sell 5.0    (по умолчанию)
 *   --kill-grid "0,-8,-10,-12,-15,-18,-20,-25,-30"
 *   --top 12           сколько лучших по сумме показать
 *   --reality-check 1  включить REALITY-CHECK (default 1)
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

interface Leg {
  ts: number;
  price: number;
  marketPrice: number;
  sizeUsd: number;
  reason: string;
}
interface PartialSell {
  ts: number;
  price: number;
  sellFraction: number;
  reason: string;
}
interface SessionRow {
  mint: string;
  symbol: string;
  dex: string;
  entryTs: number;
  exitTs: number;
  totalInvestedUsd: number;
  realNetPnlUsd: number;
  exitReason: string;
  legs: Leg[];
  partials: PartialSell[];
  effectiveExitPrice: number;
  feeBpsPerSide: number;
  slipBaseBpsPerSide: number;
  networkFeeUsd: number;
  realPeakPnlPct: number;
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

function parseLegs(raw: unknown): Leg[] {
  if (!Array.isArray(raw)) return [];
  const out: Leg[] = [];
  for (const lr of raw) {
    const x = lr as Record<string, unknown>;
    out.push({
      ts: Number(x.ts ?? 0),
      price: Number(x.price ?? 0),
      marketPrice: Number(x.marketPrice ?? x.price ?? 0),
      sizeUsd: Number(x.sizeUsd ?? 0),
      reason: String(x.reason ?? ''),
    });
  }
  return out;
}
function parsePartials(raw: unknown): PartialSell[] {
  if (!Array.isArray(raw)) return [];
  const out: PartialSell[] = [];
  for (const lr of raw) {
    const x = lr as Record<string, unknown>;
    out.push({
      ts: Number(x.ts ?? 0),
      price: Number(x.price ?? 0),
      sellFraction: Number(x.sellFraction ?? 0),
      reason: String(x.reason ?? ''),
    });
  }
  return out;
}

function parseClosedRow(o: Record<string, unknown>): SessionRow | null {
  const ct = o.closedTrade as Record<string, unknown> | undefined;
  if (!ct) return null;
  const mint = String(ct.mint ?? '');
  const entryTs = Number(ct.entryTs ?? 0);
  const exitTs = Number(ct.exitTs ?? 0);
  const totalInvestedUsd = Number(ct.totalInvestedUsd ?? 0);
  const realNetPnlUsd = Number(ct.netPnlUsd ?? 0);
  const exitReason = String(ct.exitReason ?? '');
  const realPeakPnlPct = Number(ct.peakPnlPct ?? 0);
  const effRaw = Number(ct.effective_exit_price ?? ct.effectiveExitPrice ?? ct.exitMcUsd ?? 0);
  const costs = ct.costs as Record<string, unknown> | undefined;
  const feeBpsPerSide = Number(costs?.fee_bps_per_side ?? 20);
  const slipBaseBpsPerSide = Number(costs?.slip_base_bps_per_side ?? 50);
  const networkFeeUsd = Number(costs?.network_fee_usd_total ?? 0.0013);
  let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
  if (!TABLES[dex]) dex = 'pumpswap';
  const symbol = String(ct.symbol ?? '');
  const legs = parseLegs(ct.legs);
  const partials = parsePartials(ct.partialSells);
  if (!mint || !(entryTs > 0) || !(exitTs > entryTs) || !(totalInvestedUsd > 0)) return null;
  if (!(effRaw > 0)) return null;
  return {
    mint,
    symbol,
    dex,
    entryTs,
    exitTs,
    totalInvestedUsd,
    realNetPnlUsd,
    exitReason,
    legs: legs.sort((a, b) => a.ts - b.ts),
    partials: partials.sort((a, b) => a.ts - b.ts),
    effectiveExitPrice: effRaw,
    feeBpsPerSide: Number.isFinite(feeBpsPerSide) ? feeBpsPerSide : 20,
    slipBaseBpsPerSide: Number.isFinite(slipBaseBpsPerSide) ? slipBaseBpsPerSide : 50,
    networkFeeUsd: Number.isFinite(networkFeeUsd) ? networkFeeUsd : 0.0013,
    realPeakPnlPct,
  };
}

interface DcaSchema {
  id: string;
  legs: Array<{ frac: number; ddTriggerPct: number }>;
}

const DCA_SCHEMAS: DcaSchema[] = [
  { id: 'all_in', legs: [{ frac: 1, ddTriggerPct: 0 }] },
  { id: '90_10@-5', legs: [{ frac: 0.9, ddTriggerPct: 0 }, { frac: 0.1, ddTriggerPct: -5 }] },
  { id: '80_20@-5', legs: [{ frac: 0.8, ddTriggerPct: 0 }, { frac: 0.2, ddTriggerPct: -5 }] },
  { id: '70_30@-5', legs: [{ frac: 0.7, ddTriggerPct: 0 }, { frac: 0.3, ddTriggerPct: -5 }] },
  { id: '70_30@-8', legs: [{ frac: 0.7, ddTriggerPct: 0 }, { frac: 0.3, ddTriggerPct: -8 }] },
  { id: '60_40@-7', legs: [{ frac: 0.6, ddTriggerPct: 0 }, { frac: 0.4, ddTriggerPct: -7 }] },
  { id: '50_50@-10', legs: [{ frac: 0.5, ddTriggerPct: 0 }, { frac: 0.5, ddTriggerPct: -10 }] },
  {
    id: '50_25_25@-5,-10',
    legs: [
      { frac: 0.5, ddTriggerPct: 0 },
      { frac: 0.25, ddTriggerPct: -5 },
      { frac: 0.25, ddTriggerPct: -10 },
    ],
  },
  {
    id: '34_33_33@-5,-10',
    legs: [
      { frac: 0.34, ddTriggerPct: 0 },
      { frac: 0.33, ddTriggerPct: -5 },
      { frac: 0.33, ddTriggerPct: -10 },
    ],
  },
  { id: 'real_legs', legs: [] },
];

interface TpConfig {
  id: string;
  /** undefined = pure_trail */
  ladderStep?: number;
  ladderSellFrac?: number;
  ladderMax?: number;
  /** для pure_trail: % отката от max(peakPx) */
  pureTrailDropPct?: number;
}

const TP_CONFIGS: TpConfig[] = [
  // лесенки
  { id: 'lad_5%step_5%sell_max100%', ladderStep: 0.05, ladderSellFrac: 0.05, ladderMax: 1.0 },
  { id: 'lad_5%step_7.5%sell_max100%', ladderStep: 0.05, ladderSellFrac: 0.075, ladderMax: 1.0 },
  { id: 'lad_5%step_10%sell_max100%', ladderStep: 0.05, ladderSellFrac: 0.1, ladderMax: 1.0 },
  { id: 'lad_5%step_15%sell_max50%', ladderStep: 0.05, ladderSellFrac: 0.15, ladderMax: 0.5 },
  { id: 'lad_5%step_15%sell_max100%', ladderStep: 0.05, ladderSellFrac: 0.15, ladderMax: 1.0 },
  // pure trail
  { id: 'trail_only_5%', pureTrailDropPct: 5 },
  { id: 'trail_only_8%', pureTrailDropPct: 8 },
  { id: 'trail_only_10%', pureTrailDropPct: 10 },
  { id: 'trail_only_15%', pureTrailDropPct: 15 },
  { id: 'trail_only_20%', pureTrailDropPct: 20 },
];

interface SimResult {
  netUsd: number;
  killTriggered: boolean;
  trailExit: boolean;
  ladderHits: number;
  endedByTimeout: boolean;
}

interface SimParams {
  schema: DcaSchema;
  tp: TpConfig;
  killPct: number; // 0 = off
  slipBuyPct: number;
  slipSellPct: number;
  /** REALITY_CHECK: повторяет фактические legs + partials как есть, slip применяет */
  realityCheck?: boolean;
}

function simulateSession(
  s: SessionRow,
  series: { tsMs: number[]; px: number[] },
  p: SimParams,
): SimResult | null {
  const { tsMs, px } = series;
  const startIdx = bisectLeft(tsMs, s.entryTs);
  if (startIdx >= tsMs.length) return null;
  if (tsMs[startIdx]! > s.exitTs) return null;
  const firstPrice = px[startIdx]!;
  if (!(firstPrice > 0)) return null;

  const fee = (s.feeBpsPerSide + s.slipBaseBpsPerSide) / 10_000;
  const slipBuy = p.slipBuyPct / 100;
  const slipSell = p.slipSellPct / 100;

  let inv = 0;
  let avg = 0;
  let tokens = 0;

  const applyBuy = (price: number, sizeUsd: number) => {
    if (!(price > 0) || !(sizeUsd > 0)) return;
    const fillPx = price * (1 + slipBuy);
    const feeUsd = sizeUsd * fee;
    const moneyForTokens = sizeUsd - feeUsd;
    if (!(moneyForTokens > 0)) return;
    const addTokens = moneyForTokens / fillPx;
    tokens += addTokens;
    inv += sizeUsd;
    avg = inv / tokens;
  };
  const sellAll = (price: number) => {
    if (!(tokens > 0)) return { proceeds: 0, cost: 0 };
    const fillPx = price * (1 - slipSell);
    const gross = tokens * fillPx;
    const feeUsd = gross * fee;
    const proceeds = gross - feeUsd;
    const cost = inv;
    tokens = 0;
    inv = 0;
    avg = 0;
    return { proceeds, cost };
  };
  const sellFraction = (price: number, frac: number) => {
    if (!(tokens > 0) || !(frac > 0)) return { proceeds: 0, costShare: 0 };
    const fF = Math.max(0, Math.min(1, frac));
    const sellTokens = tokens * fF;
    const fillPx = price * (1 - slipSell);
    const gross = sellTokens * fillPx;
    const feeUsd = gross * fee;
    const proceeds = gross - feeUsd;
    const costShare = inv * fF;
    tokens -= sellTokens;
    inv -= costShare;
    if (tokens > 0 && inv > 0) avg = inv / tokens;
    else {
      tokens = 0;
      inv = 0;
      avg = 0;
    }
    return { proceeds, costShare };
  };

  // план DCA-входов
  type PlannedLeg = { triggerPx: number; sizeUsd: number; ts?: number; price?: number };
  const planned: PlannedLeg[] = [];
  if (p.realityCheck || p.schema.id === 'real_legs') {
    for (const lg of s.legs) {
      if (!(lg.sizeUsd > 0) || !(lg.price > 0)) continue;
      if (lg.reason !== 'open' && lg.reason !== 'scale_in' && lg.reason !== 'dca') continue;
      planned.push({ triggerPx: lg.price, sizeUsd: lg.sizeUsd, ts: lg.ts, price: lg.price });
    }
    if (planned.length === 0) return null;
  } else {
    for (let li = 0; li < p.schema.legs.length; li++) {
      const ll = p.schema.legs[li]!;
      const sizeUsd = ll.frac * s.totalInvestedUsd;
      if (li === 0) {
        planned.push({ triggerPx: firstPrice, sizeUsd, ts: tsMs[startIdx], price: firstPrice });
      } else {
        const trig = firstPrice * (1 + ll.ddTriggerPct / 100);
        planned.push({ triggerPx: trig, sizeUsd });
      }
    }
  }

  // первый leg сразу
  const firstLeg = planned[0]!;
  applyBuy(firstLeg.price ?? firstPrice, firstLeg.sizeUsd);
  let pendingScheduledIdx = 1;
  let nextScheduledIdx = 1;

  // лесенка
  const ladderSteps: number[] = [];
  if (p.tp.ladderStep != null && p.tp.ladderMax != null) {
    for (let lvl = p.tp.ladderStep; lvl <= p.tp.ladderMax + 1e-9; lvl += p.tp.ladderStep) {
      ladderSteps.push(+lvl.toFixed(6));
    }
  }
  const ladderUsed = new Set<number>();

  // REALITY_CHECK: pre-compute partial schedule
  const realPartialQueue = p.realityCheck
    ? [...s.partials].sort((a, b) => a.ts - b.ts)
    : [];
  let realPartialIdx = 0;

  let realizedProceeds = 0;
  let realizedCost = 0;
  let killTriggered = false;
  let trailExit = false;
  let endedByTimeout = false;
  let ladderHits = 0;
  let peakPx = 0;
  let killPct = p.killPct; // <0 = on, 0 = off

  for (let i = startIdx; i < tsMs.length; i++) {
    const t = tsMs[i]!;
    if (t > s.exitTs) break;
    const p0 = px[i]!;
    if (p0 > peakPx) peakPx = p0;

    // запланированные входы
    if (p.realityCheck || p.schema.id === 'real_legs') {
      while (pendingScheduledIdx < planned.length && (planned[pendingScheduledIdx]!.ts ?? 0) <= t) {
        const ll = planned[pendingScheduledIdx]!;
        applyBuy(ll.price ?? p0, ll.sizeUsd);
        pendingScheduledIdx++;
      }
    } else {
      while (nextScheduledIdx < planned.length) {
        const ll = planned[nextScheduledIdx]!;
        if (p0 <= ll.triggerPx) {
          applyBuy(p0, ll.sizeUsd);
          nextScheduledIdx++;
        } else break;
      }
    }

    if (!(tokens > 0) || !(avg > 0)) continue;

    const pnlPct = (p0 - avg) / avg;

    // killstop
    if (killPct < 0 && pnlPct <= killPct / 100 + 1e-12) {
      const r = sellAll(p0);
      realizedProceeds += r.proceeds;
      realizedCost += r.cost;
      killTriggered = true;
      break;
    }

    if (p.realityCheck) {
      while (realPartialIdx < realPartialQueue.length && realPartialQueue[realPartialIdx]!.ts <= t) {
        const ps = realPartialQueue[realPartialIdx]!;
        if (ps.reason === 'TP_LADDER') {
          const r = sellFraction(p0, ps.sellFraction);
          realizedProceeds += r.proceeds;
          realizedCost += r.costShare;
          ladderHits++;
        }
        realPartialIdx++;
      }
    } else if (ladderSteps.length > 0 && p.tp.ladderSellFrac != null) {
      for (const stp of ladderSteps) {
        if (ladderUsed.has(stp)) continue;
        if (pnlPct >= stp - 1e-12) {
          const r = sellFraction(p0, p.tp.ladderSellFrac);
          realizedProceeds += r.proceeds;
          realizedCost += r.costShare;
          ladderUsed.add(stp);
          ladderHits++;
        }
      }
      // trail после ≥2 ступеней — выход остатка ниже предпоследней ступени
      if (ladderUsed.size >= 2 && tokens > 0) {
        const sortedTaken = [...ladderUsed].sort((a, b) => a - b);
        const floor = sortedTaken[sortedTaken.length - 2]!;
        if (pnlPct <= floor + 1e-12) {
          const r = sellAll(p0);
          realizedProceeds += r.proceeds;
          realizedCost += r.cost;
          trailExit = true;
          break;
        }
      }
    } else if (p.tp.pureTrailDropPct != null && peakPx > 0) {
      // pure_trail: выход всего остатка при price ≤ peakPx * (1 - trail/100)
      const floor = peakPx * (1 - p.tp.pureTrailDropPct / 100);
      if (p0 <= floor) {
        const r = sellAll(p0);
        realizedProceeds += r.proceeds;
        realizedCost += r.cost;
        trailExit = true;
        break;
      }
    }
  }

  if (tokens > 0) {
    const idxEnd = idxAtOrBefore(tsMs, s.exitTs);
    const exitPx = idxEnd >= 0 ? px[idxEnd]! : s.effectiveExitPrice;
    if (!(exitPx > 0)) return null;
    const r = sellAll(exitPx);
    realizedProceeds += r.proceeds;
    realizedCost += r.cost;
    endedByTimeout = true;
  }

  const netUsd = realizedProceeds - realizedCost - s.networkFeeUsd;
  return { netUsd, killTriggered, trailExit, ladderHits, endedByTimeout };
}

interface AggValue {
  n: number;
  sumNet: number;
  wins: number;
  losses: number;
  pnls: number[];
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}
function quantile(arr: number[], q: number): number {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))));
  return a[idx]!;
}
function maxDrawdownEquity(orderedPnls: number[]): number {
  let eq = 0;
  let peak = 0;
  let mdd = 0;
  for (const v of orderedPnls) {
    eq += v;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
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

  const slipBuy = argNum('--slip-buy', 1.0);
  const slipSell = argNum('--slip-sell', 5.0);
  const top = Math.max(1, argNum('--top', 12));
  const realityCheckOn = argNum('--reality-check', 1) > 0;

  const killGridStr = argStr('--kill-grid', '0,-8,-10,-12,-15,-18,-20,-25,-30');
  const killGrid = killGridStr
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x));

  const sessions: SessionRow[] = [];
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
    if (o.kind !== 'live_position_close') continue;
    const row = parseClosedRow(o);
    if (!row) continue;
    if (row.exitReason === 'PERIODIC_HEAL' || row.exitReason === 'RECONCILE_ORPHAN') continue;
    sessions.push(row);
  }
  const sessionsSorted = [...sessions].sort((a, b) => a.entryTs - b.entryTs);

  // загрузка серий
  const seriesByKey = new Map<string, { tsMs: number[]; px: number[] } | null>();
  let snapshotsLoaded = 0;
  let snapshotsMiss = 0;
  for (const s of sessions) {
    const key = `${s.mint}|${s.dex}|${s.entryTs}|${s.exitTs}`;
    if (seriesByKey.has(key)) continue;
    const ser = await loadSnapshotsForMint(
      s.mint,
      s.dex,
      s.entryTs - 5 * 60_000,
      s.exitTs + 5 * 60_000,
    );
    seriesByKey.set(key, ser);
    if (ser) snapshotsLoaded++;
    else snapshotsMiss++;
  }

  // 1) REALITY_CHECK
  type RcResult = {
    n: number;
    sumModelNet: number;
    sumRealNet: number;
    diffPerTrade: number[];
  };
  let realityCheck: RcResult | null = null;
  if (realityCheckOn) {
    const rc: RcResult = { n: 0, sumModelNet: 0, sumRealNet: 0, diffPerTrade: [] };
    for (const s of sessionsSorted) {
      const key = `${s.mint}|${s.dex}|${s.entryTs}|${s.exitTs}`;
      const ser = seriesByKey.get(key);
      if (!ser || ser.tsMs.length < 2) continue;
      const r = simulateSession(s, ser, {
        schema: { id: 'real_legs', legs: [] },
        tp: { id: 'real_partials' },
        killPct: 0,
        slipBuyPct: slipBuy,
        slipSellPct: slipSell,
        realityCheck: true,
      });
      if (!r || !Number.isFinite(r.netUsd)) continue;
      rc.n++;
      rc.sumModelNet += r.netUsd;
      rc.sumRealNet += s.realNetPnlUsd;
      rc.diffPerTrade.push(r.netUsd - s.realNetPnlUsd);
    }
    realityCheck = rc;
  }

  // 2) Сетка
  const variants: Array<{ schema: DcaSchema; tp: TpConfig; killPct: number }> = [];
  for (const sch of DCA_SCHEMAS) {
    for (const tp of TP_CONFIGS) {
      for (const k of killGrid) {
        variants.push({ schema: sch, tp, killPct: k });
      }
    }
  }

  type Row = {
    schemaId: string;
    tpId: string;
    killPct: number;
    n: number;
    sumNet: number;
    meanNet: number;
    medianNet: number;
    p10: number;
    p90: number;
    winRate: number;
    mdd: number;
    sharpeLike: number;
  };
  const rows: Row[] = [];

  for (const v of variants) {
    const agg: AggValue = { n: 0, sumNet: 0, wins: 0, losses: 0, pnls: [] };
    const ordered: number[] = [];
    for (const s of sessionsSorted) {
      const key = `${s.mint}|${s.dex}|${s.entryTs}|${s.exitTs}`;
      const ser = seriesByKey.get(key);
      if (!ser || ser.tsMs.length < 2) continue;
      const r = simulateSession(s, ser, {
        schema: v.schema,
        tp: v.tp,
        killPct: v.killPct,
        slipBuyPct: slipBuy,
        slipSellPct: slipSell,
      });
      if (!r || !Number.isFinite(r.netUsd)) continue;
      agg.n++;
      agg.sumNet += r.netUsd;
      if (r.netUsd > 0) agg.wins++;
      else if (r.netUsd < 0) agg.losses++;
      agg.pnls.push(r.netUsd);
      ordered.push(r.netUsd);
    }
    if (agg.n === 0) continue;
    const mean = agg.sumNet / agg.n;
    const std =
      agg.pnls.length > 1
        ? Math.sqrt(agg.pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (agg.pnls.length - 1))
        : 0;
    rows.push({
      schemaId: v.schema.id,
      tpId: v.tp.id,
      killPct: v.killPct,
      n: agg.n,
      sumNet: +agg.sumNet.toFixed(2),
      meanNet: +mean.toFixed(4),
      medianNet: +median(agg.pnls).toFixed(4),
      p10: +quantile(agg.pnls, 0.1).toFixed(4),
      p90: +quantile(agg.pnls, 0.9).toFixed(4),
      winRate: +(agg.wins / agg.n).toFixed(4),
      mdd: +maxDrawdownEquity(ordered).toFixed(2),
      sharpeLike: +(std > 0 ? mean / std : 0).toFixed(4),
    });
  }
  rows.sort((a, b) => b.sumNet - a.sumNet);

  const realSum = sessionsSorted.reduce((s, r) => s + r.realNetPnlUsd, 0);
  const realWins = sessionsSorted.filter((r) => r.realNetPnlUsd > 0).length;

  // топы по разным TP-режимам
  const isLadder = (id: string) => id.startsWith('lad_');
  const isTrail = (id: string) => id.startsWith('trail_only_');
  const topLadder = rows.filter((r) => isLadder(r.tpId)).slice(0, top);
  const topPureTrail = rows.filter((r) => isTrail(r.tpId)).slice(0, top);

  // лучший по Sharpe, лучший по MDD, лучший по win rate
  const bySharpe = [...rows].sort((a, b) => b.sharpeLike - a.sharpeLike).slice(0, top);
  const byMdd = [...rows].sort((a, b) => a.mdd - b.mdd).slice(0, top);

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        sessionsTotal: sessionsSorted.length,
        snapshotsLoaded,
        snapshotsMiss,
        slipBuyPct: slipBuy,
        slipSellPct: slipSell,
        killGrid,
        baselineRealJournal: {
          sumNetUsd: +realSum.toFixed(2),
          winsByNet: realWins,
          losses: sessionsSorted.length - realWins,
        },
        realityCheck: realityCheck
          ? {
              n: realityCheck.n,
              sumModelNet: +realityCheck.sumModelNet.toFixed(2),
              sumRealNet: +realityCheck.sumRealNet.toFixed(2),
              meanDiff: +(realityCheck.diffPerTrade.reduce((s, x) => s + x, 0) /
                Math.max(1, realityCheck.diffPerTrade.length)).toFixed(3),
              medianDiff: +median(realityCheck.diffPerTrade).toFixed(3),
              p10Diff: +quantile(realityCheck.diffPerTrade, 0.1).toFixed(3),
              p90Diff: +quantile(realityCheck.diffPerTrade, 0.9).toFixed(3),
              note: 'sumModelNet ≈ sumRealNet → модель калибрована.',
            }
          : null,
        topLadderByTotal: topLadder,
        topPureTrailByTotal: topPureTrail,
        topBySharpeLike: bySharpe,
        topByMinMdd: byMdd,
        notes: [
          'TP ladder: ступени каждые 5% к avg, sellFrac = доля остатка за ступень, max — потолок.',
          'pure_trail: без лесенки; выход всего остатка при price ≤ peakPx*(1 - trail%).',
          'Slippage применяется к каждому buy и sell поверх snapshot price (медианы из journal).',
          'fee_bps_per_side и slip_base_bps_per_side берутся из ct.costs каждой сделки.',
          'killPct = 0 = без kill.',
          'Trail в ladder режиме — выход остатка ниже предпоследней взятой ступени (только после ≥2).',
          'Сессии с RECONCILE_ORPHAN/PERIODIC_HEAL исключены.',
        ],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});
