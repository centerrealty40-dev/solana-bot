/**
 * Live Oscar — ретроспективный поиск «одной универсальной стратегии», максимизирующей суммарный PnL
 * на ВСЕХ закрытых сессиях из journal.
 *
 * Сетка: (схема входа = DCA) × (kill-stop по PnL к текущей средней).
 * TP-лесенка фиксированная (по умолчанию шаг 5% к avg, продаём 15% за ступень, до 50%),
 * после ≥2 ступеней включается trail = выход остатка при откате PnL ≤ предыдущей ступени.
 * Никаких частичных продаж из реального журнала НЕ используется — это полноценный re-replay.
 *
 * Параллельно скрипт печатает «чистый killstop-only»-разрез на тех же сессиях
 * (без TP-лесенки) — это отдельный ответ на вопрос «идеальный килстоп для минусовых сделок».
 *
 * Запуск (нужен Postgres со `*_pair_snapshots`):
 *   set -a && . ./.env && set +a && \
 *   npx tsx scripts-tmp/live-oscar-universal-strategy-grid.ts data/live/pt1-oscar-live.jsonl
 *
 * Флаги:
 *   --ladder-step 0.05         шаг ступени TP (5%)
 *   --ladder-sell-frac 0.15    сколько остатка продаём на каждой ступени
 *   --ladder-max 0.50          максимум по ступеням (50% к avg)
 *   --kill-grid 0,-8,-10,-12,-15,-18,-20,-25,-30   список K в %% к avg (0 = без kill)
 *   --include-tp 1             вкл. лесенка+trail (default 1)
 *   --max-sessions 0           ограничить N сессиями (debug)
 *   --top 8                    сколько лучших по сумме показать
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
  sizeUsd: number;
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
  effectiveExitPrice: number;
  feeBpsPerSide: number;
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
  const feeBpsPerSide = Number(costs?.fee_bps_per_side ?? 30);
  const networkFeeUsd = Number(costs?.network_fee_usd_total ?? 0.002);
  let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
  if (!TABLES[dex]) dex = 'pumpswap';
  const symbol = String(ct.symbol ?? '');
  const legs = parseLegs(ct.legs);
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
    effectiveExitPrice: effRaw,
    feeBpsPerSide: Number.isFinite(feeBpsPerSide) ? feeBpsPerSide : 30,
    networkFeeUsd: Number.isFinite(networkFeeUsd) ? networkFeeUsd : 0.002,
    realPeakPnlPct,
  };
}

interface DcaSchema {
  id: string;
  /** массив (доля_от_бюджета_inv, триггер_dd_от_первого_entry_в_%). 1-й элемент: trigger=0 (немедленно). */
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
  {
    id: 'real_legs',
    legs: [], // sentinel: используем фактические legs из journal по факту
  },
];

interface SimResult {
  netUsd: number;
  killTriggered: boolean;
  ladderHits: number;
  trailExit: boolean;
  endedByTimeout: boolean;
}

interface SimParams {
  ladderStep: number;
  ladderSellFrac: number;
  ladderMax: number;
  killPct: number; // 0 = off; -8 → стоп при PnL ≤ -8% к avg
  includeTp: boolean;
  schema: DcaSchema;
}

/**
 * Симулирует одну сессию.
 * Бюджет = budgetUsd (равный totalInvestedUsd по реалу для сопоставимости).
 * Входы:
 *   - schema.id !== 'real_legs': планируем DCA-добавления по % к первому entry
 *   - schema.id === 'real_legs': берём фактические legs (open + scale_in*) — без модели DCA
 * Цены: первый leg = первая точка после entryTs (или первая >= entryTs).
 * Выход:
 *   - kill: PnL ≤ killPct → продать всё по текущей цене
 *   - TP-лесенка: при превышении ступени продаём ladderSellFrac остатка
 *   - trail: при ≥2 ступенях, если PnL ≤ предыдущая_ступень → продать остаток
 *   - timeout: остаток продаётся по последней цене ≤ exitTs
 */
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

  // план DCA-входов
  type PlannedLeg = { triggerPx: number; sizeUsd: number; ts?: number; price?: number };
  const planned: PlannedLeg[] = [];
  if (p.schema.id === 'real_legs') {
    // фактические legs
    for (const lg of s.legs) {
      if (!(lg.sizeUsd > 0) || !(lg.price > 0)) continue;
      if (lg.reason !== 'open' && lg.reason !== 'scale_in' && lg.reason !== 'dca') continue;
      planned.push({ triggerPx: lg.price, sizeUsd: lg.sizeUsd, ts: lg.ts, price: lg.price });
    }
    if (planned.length === 0) return null;
  } else {
    let cum = 0;
    for (let li = 0; li < p.schema.legs.length; li++) {
      const ll = p.schema.legs[li]!;
      const sizeUsd = ll.frac * s.totalInvestedUsd;
      cum += ll.frac;
      if (li === 0) {
        planned.push({ triggerPx: firstPrice, sizeUsd, ts: tsMs[startIdx], price: firstPrice });
      } else {
        const trig = firstPrice * (1 + ll.ddTriggerPct / 100);
        planned.push({ triggerPx: trig, sizeUsd });
      }
    }
    void cum;
  }

  const ladderSteps: number[] = []; // в долях, 0.05, 0.10, ...
  if (p.includeTp) {
    for (let lvl = p.ladderStep; lvl <= p.ladderMax + 1e-9; lvl += p.ladderStep) {
      ladderSteps.push(+lvl.toFixed(6));
    }
  }
  const ladderUsed = new Set<number>();
  let trailFloor: number | null = null;

  let inv = 0;
  let avg = 0;
  let tokens = 0;
  let nextScheduledIdx = 1; // для 'real_legs' (по ts), для DCA-моделей идём по триггеру
  let pendingScheduledIdx = 0; // для 'real_legs': индекс следующего запланированного leg
  let killTriggered = false;
  let trailExit = false;
  let endedByTimeout = false;
  let ladderHits = 0;

  // выполнить leg
  const applyBuy = (price: number, sizeUsd: number) => {
    if (!(price > 0) || !(sizeUsd > 0)) return;
    const addTokens = sizeUsd / price;
    tokens += addTokens;
    inv += sizeUsd;
    avg = inv / tokens;
  };

  const sellAll = (price: number): { proceeds: number; cost: number } => {
    const feeFrac = (s.feeBpsPerSide * 2) / 10_000;
    const gross = tokens * price;
    const fees = gross * feeFrac;
    const proceeds = gross - fees;
    const cost = inv;
    tokens = 0;
    inv = 0;
    avg = 0;
    return { proceeds, cost };
  };
  const sellFraction = (price: number, frac: number): { proceeds: number; costShare: number } => {
    if (!(frac > 0)) return { proceeds: 0, costShare: 0 };
    const fF = Math.max(0, Math.min(1, frac));
    const sellTokens = tokens * fF;
    const feeFrac = (s.feeBpsPerSide * 2) / 10_000;
    const gross = sellTokens * price;
    const fees = gross * feeFrac;
    const proceeds = gross - fees;
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

  let realizedProceeds = 0;
  let realizedCost = 0;

  // первый leg выполняем сразу
  const firstLeg = planned[0]!;
  applyBuy(firstLeg.price ?? firstPrice, firstLeg.sizeUsd);
  pendingScheduledIdx = 1;
  nextScheduledIdx = 1;

  for (let i = startIdx; i < tsMs.length; i++) {
    const t = tsMs[i]!;
    if (t > s.exitTs) break;
    const p0 = px[i]!;

    // выполнить запланированные входы
    if (p.schema.id === 'real_legs') {
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
        } else {
          break;
        }
      }
    }

    if (!(tokens > 0) || !(avg > 0)) continue;

    const pnlPct = (p0 - avg) / avg;

    // killstop
    if (p.killPct < 0 && pnlPct <= p.killPct / 100 + 1e-12) {
      const r = sellAll(p0);
      realizedProceeds += r.proceeds;
      realizedCost += r.cost;
      killTriggered = true;
      break;
    }

    // лесенка
    if (p.includeTp) {
      let did = false;
      for (const stp of ladderSteps) {
        if (ladderUsed.has(stp)) continue;
        if (pnlPct >= stp - 1e-12) {
          const r = sellFraction(p0, p.ladderSellFrac);
          realizedProceeds += r.proceeds;
          realizedCost += r.costShare;
          ladderUsed.add(stp);
          ladderHits++;
          did = true;
        }
      }
      void did;

      // trail (после ≥2 ступеней)
      if (ladderUsed.size >= 2 && tokens > 0) {
        const sortedTaken = [...ladderUsed].sort((a, b) => a - b);
        const floor = sortedTaken[sortedTaken.length - 2]!;
        trailFloor = floor;
        if (pnlPct <= floor + 1e-12) {
          const r = sellAll(p0);
          realizedProceeds += r.proceeds;
          realizedCost += r.cost;
          trailExit = true;
          break;
        }
      }
    }
  }

  // timeout — закрытие остатка
  if (tokens > 0) {
    const idxEnd = idxAtOrBefore(tsMs, s.exitTs);
    const exitPx = idxEnd >= 0 ? px[idxEnd]! : s.effectiveExitPrice;
    if (!(exitPx > 0)) return null;
    const r = sellAll(exitPx);
    realizedProceeds += r.proceeds;
    realizedCost += r.cost;
    endedByTimeout = true;
  }
  void trailFloor;

  // нереализованные оставшиеся deferred-legs не покупаем (по правилам)
  // network fee — упрощённо за полный круг, как у killstop-sweep
  const netUsd = realizedProceeds - realizedCost - s.networkFeeUsd;
  return { netUsd, killTriggered, ladderHits, trailExit, endedByTimeout };
}

interface AggKey {
  schemaId: string;
  killPct: number;
  includeTp: boolean;
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

  const ladderStep = argNum('--ladder-step', 0.05);
  const ladderSellFrac = argNum('--ladder-sell-frac', 0.15);
  const ladderMax = argNum('--ladder-max', 0.5);
  const includeTp = argNum('--include-tp', 1) > 0;
  const maxSessions = argNum('--max-sessions', 0);
  const top = Math.max(1, argNum('--top', 8));

  const killGridStr = argStr('--kill-grid', '0,-8,-10,-12,-15,-18,-20,-25,-30');
  const killGrid = killGridStr
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x));

  // load sessions
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
    if (maxSessions > 0 && sessions.length >= maxSessions) break;
  }

  // загрузка снимков (с буфером по 5 минут)
  type Series = { tsMs: number[]; px: number[] };
  const seriesByMint = new Map<string, Series | null>();
  let snapshotsLoaded = 0;
  let snapshotsMiss = 0;
  for (const s of sessions) {
    const key = `${s.mint}|${s.dex}|${s.entryTs}|${s.exitTs}`;
    if (seriesByMint.has(key)) continue;
    const ser = await loadSnapshotsForMint(s.mint, s.dex, s.entryTs - 5 * 60_000, s.exitTs + 5 * 60_000);
    seriesByMint.set(key, ser);
    if (ser) snapshotsLoaded++;
    else snapshotsMiss++;
  }

  // grid: schema × kill × includeTp/killOnly
  const variants: Array<{ schema: DcaSchema; killPct: number; includeTp: boolean }> = [];
  for (const sch of DCA_SCHEMAS) {
    for (const k of killGrid) {
      variants.push({ schema: sch, killPct: k, includeTp });
      if (includeTp) {
        // killstop-only тоже посчитаем (без TP), на тех же входах
        variants.push({ schema: sch, killPct: k, includeTp: false });
      }
    }
  }

  const aggMap = new Map<string, AggValue>();
  const perTradeBest: Record<string, Array<{ mint: string; symbol: string; net: number }>> = {};
  // также сохраним PnL по каждой комбинации в порядке entryTs для MDD
  const pnlsOrdered: Record<string, number[]> = {};
  const sessionsSorted = [...sessions].sort((a, b) => a.entryTs - b.entryTs);

  let simRuns = 0;
  let simSkipped = 0;

  for (const v of variants) {
    const key = `${v.schema.id}|kill=${v.killPct}|tp=${v.includeTp ? 1 : 0}`;
    aggMap.set(key, { n: 0, sumNet: 0, wins: 0, losses: 0, pnls: [] });
    pnlsOrdered[key] = [];
    perTradeBest[key] = [];

    for (const s of sessionsSorted) {
      const seriesKey = `${s.mint}|${s.dex}|${s.entryTs}|${s.exitTs}`;
      const ser = seriesByMint.get(seriesKey);
      if (!ser || ser.tsMs.length < 2) {
        simSkipped++;
        continue;
      }
      const r = simulateSession(s, ser, {
        ladderStep,
        ladderSellFrac,
        ladderMax,
        killPct: v.killPct,
        includeTp: v.includeTp,
        schema: v.schema,
      });
      if (!r || !Number.isFinite(r.netUsd)) {
        simSkipped++;
        continue;
      }
      simRuns++;
      const a = aggMap.get(key)!;
      a.n++;
      a.sumNet += r.netUsd;
      if (r.netUsd > 0) a.wins++;
      else if (r.netUsd < 0) a.losses++;
      a.pnls.push(r.netUsd);
      pnlsOrdered[key]!.push(r.netUsd);
    }
  }

  // ranking
  type Row = {
    schemaId: string;
    killPct: number;
    includeTp: boolean;
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
  for (const [k, v] of aggMap) {
    const [schemaId, kk, tt] = k.split('|') as [string, string, string];
    const killPct = Number(kk.replace('kill=', ''));
    const includeTpFlag = tt === 'tp=1';
    if (v.n === 0) continue;
    const mean = v.sumNet / v.n;
    const std =
      v.pnls.length > 1
        ? Math.sqrt(v.pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.pnls.length - 1))
        : 0;
    const sharpe = std > 0 ? mean / std : 0;
    const mdd = maxDrawdownEquity(pnlsOrdered[k]!);
    rows.push({
      schemaId,
      killPct,
      includeTp: includeTpFlag,
      n: v.n,
      sumNet: +v.sumNet.toFixed(2),
      meanNet: +mean.toFixed(4),
      medianNet: +median(v.pnls).toFixed(4),
      p10: +quantile(v.pnls, 0.1).toFixed(4),
      p90: +quantile(v.pnls, 0.9).toFixed(4),
      winRate: +(v.wins / v.n).toFixed(4),
      mdd: +mdd.toFixed(2),
      sharpeLike: +sharpe.toFixed(4),
    });
  }
  rows.sort((a, b) => b.sumNet - a.sumNet);

  // baseline = реальный journal
  const realSum = sessionsSorted.reduce((s, r) => s + r.realNetPnlUsd, 0);
  const realWins = sessionsSorted.filter((r) => r.realNetPnlUsd > 0).length;

  const topRowsTp = rows.filter((r) => r.includeTp).slice(0, top);
  const topRowsKillOnly = rows.filter((r) => !r.includeTp).slice(0, top);

  // только по сессиям с realNetPnl < 0 — для отдельного отчёта по «минусовым»
  const lossSet = new Set(
    sessionsSorted.filter((r) => r.realNetPnlUsd < 0).map((r) => `${r.mint}|${r.entryTs}`),
  );
  const lossOnlyAgg = new Map<string, { n: number; sumNet: number; wins: number }>();
  for (const v of variants) {
    const key = `${v.schema.id}|kill=${v.killPct}|tp=${v.includeTp ? 1 : 0}`;
    let n = 0;
    let sum = 0;
    let w = 0;
    let i = 0;
    for (const s of sessionsSorted) {
      const id = `${s.mint}|${s.entryTs}`;
      if (!lossSet.has(id)) {
        i++;
        continue;
      }
      const seriesKey = `${s.mint}|${s.dex}|${s.entryTs}|${s.exitTs}`;
      const ser = seriesByMint.get(seriesKey);
      if (!ser || ser.tsMs.length < 2) {
        i++;
        continue;
      }
      const r = simulateSession(s, ser, {
        ladderStep,
        ladderSellFrac,
        ladderMax,
        killPct: v.killPct,
        includeTp: v.includeTp,
        schema: v.schema,
      });
      i++;
      if (!r || !Number.isFinite(r.netUsd)) continue;
      n++;
      sum += r.netUsd;
      if (r.netUsd > 0) w++;
    }
    lossOnlyAgg.set(key, { n, sumNet: sum, wins: w });
  }
  const lossRows: Array<{
    schemaId: string;
    killPct: number;
    includeTp: boolean;
    n: number;
    sumNet: number;
    wins: number;
  }> = [];
  for (const [k, v] of lossOnlyAgg) {
    const [schemaId, kk, tt] = k.split('|') as [string, string, string];
    const killPct = Number(kk.replace('kill=', ''));
    const includeTpFlag = tt === 'tp=1';
    if (v.n === 0) continue;
    lossRows.push({
      schemaId,
      killPct,
      includeTp: includeTpFlag,
      n: v.n,
      sumNet: +v.sumNet.toFixed(2),
      wins: v.wins,
    });
  }
  lossRows.sort((a, b) => b.sumNet - a.sumNet);

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        sessionsTotal: sessions.length,
        snapshotsLoaded,
        snapshotsMiss,
        simRuns,
        simSkipped,
        ladderStep,
        ladderSellFrac,
        ladderMax,
        killGrid,
        baselineRealJournal: {
          sumNetUsd: +realSum.toFixed(2),
          winsByNet: realWins,
          losses: sessions.length - realWins,
        },
        topByTotalUsd_withTpLadder: topRowsTp,
        topByTotalUsd_killOnly_noTp: topRowsKillOnly,
        // на минусовых сделках — отдельный «спасённый PnL» от изменения kill/DCA
        topByTotalUsd_onLossSessionsOnly: lossRows.slice(0, top * 2),
        notes: [
          'TP-лесенка: фиксированный шаг по avg, sellFrac за ступень; trail = выход всего остатка ниже предпоследней ступени.',
          'killPct = 0 означает «без kill».',
          "schema 'real_legs' использует фактические legs из journal (open + scale_in + dca), без модели DCA.",
          'feeBps_per_side и network_fee_usd_total берутся из journal; slippage не моделируется отдельно.',
          'Сессии с RECONCILE_ORPHAN/PERIODIC_HEAL исключены — они закрывались служебно, не по торговой логике.',
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
