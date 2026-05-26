/**
 * Live Oscar — расширенный контрфакт по **закрытым** сделкам: сетка kill-stop × DCA × TP-grid (как режим B).
 *
 * Модель (упрощения vs прод):
 * - Цена: ряд `price_usd` из Postgres по `dex` сделки (как в killstop-drawdown).
 * - Окно симуляции: [entryTs .. exitTs] как в журнале.
 * - Порядок на каждом баре: применить ноги (по времени) → синтетическое DCA (если включено) → kill по текущей средней
 *   → все доступные ступени TP-grid (+k·step от avg, продажа доли остатка).
 * - Хвост позиции на exitTs: закрытие по цене ряда (или effective_exit_price).
 * - Trail / retrace первой ступени / Jupiter defer — **не** моделируются.
 * - Комиссии: `fee_bps_per_side` с обеих сторон на каждом выходе; `network_fee_usd_total` журнала делится
 *   пропорционально числу событий выхода (грубая прокси).
 *
 * Режимы DCA:
 * - `off`: только ноги `open` + `scale_in` из журнала.
 * - `journal`: все ноги, включая исторические `dca`.
 * - `sim6`: только open+scale_in; одна докупка `positionUsd * dcaFraction` при первом касании
 *   цены ≤ avg·(1 + triggerPct), triggerPct = −6% по умолчанию (`--dca-trigger-pct`).
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *     npx tsx scripts-tmp/live-oscar-strategy-mega-grid.ts data/live/pt1-oscar-live.jsonl
 *
 * Узкая сетка / быстрый прогон:
 *   npx tsx scripts-tmp/live-oscar-strategy-mega-grid.ts path.jsonl --fast
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

const LADDER_EPS = 1e-9;

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

type DcaMode = 'off' | 'journal' | 'sim6';

interface MegaParams {
  killDrawdownPct: number;
  dcaMode: DcaMode;
  ladderStepPnl: number;
  ladderSellFrac: number;
  ladderMaxRungs: number;
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

function applyBuyLeg(inv: number, avg: number, leg: Leg): { inv: number; avg: number } {
  if (!(leg.price > 0) || !(leg.sizeUsd > 0)) return { inv, avg };
  if (inv <= 0 || avg <= 0) {
    const qty = leg.sizeUsd / leg.price;
    return { inv: leg.sizeUsd, avg: leg.sizeUsd / qty };
  }
  const qty = inv / avg;
  const addQty = leg.sizeUsd / leg.price;
  const newInv = inv + leg.sizeUsd;
  const newAvg = newInv / (qty + addQty);
  return { inv: newInv, avg: newAvg };
}

function feeOnGross(grossUsd: number, feeBpsPerSide: number): number {
  return grossUsd * ((feeBpsPerSide * 2) / 10_000);
}

/** Одна стратегия на сделку → net PnL USD (упрощённые комиссии). */
function simulateTrade(
  c: CloseRow,
  tsMs: number[],
  px: number[],
  p: MegaParams,
  opts: { positionUsd: number; dcaTriggerPct: number; dcaFraction: number },
): number {
  const legsJournal = [...c.legs].sort((a, b) => a.ts - b.ts || 0);
  let legsQueue: Leg[];
  if (p.dcaMode === 'journal') {
    legsQueue = legsJournal.filter((l) =>
      ['open', 'scale_in', 'dca'].includes(l.reason),
    );
  } else {
    legsQueue = legsJournal.filter((l) => ['open', 'scale_in'].includes(l.reason));
  }

  let legIdx = 0;
  let inv = 0;
  let avg = 0;
  let qty = 0;
  let realized = 0;

  /** Грубая доля журнального network на каждое событие продажи (partial/full). */
  const netFeePerEvent = () => Math.max(0.0008, c.networkFeeUsd * 0.22);

  const ladderTaken = new Set<number>();

  let simDcaDone = p.dcaMode !== 'sim6';

  const startIdx = bisectLeft(tsMs, c.entryTs);
  const endIdx = idxAtOrBefore(tsMs, c.exitTs);
  if (startIdx >= tsMs.length || endIdx < startIdx) {
    return Number.NaN;
  }

  const tryApplyLegs = (t: number) => {
    while (legIdx < legsQueue.length && legsQueue[legIdx]!.ts <= t) {
      const leg = legsQueue[legIdx]!;
      legIdx++;
      const n = applyBuyLeg(inv, avg, leg);
      inv = n.inv;
      avg = n.avg;
      qty = inv > 0 && avg > 0 ? inv / avg : 0;
    }
  };

  const fullExit = (price: number): number => {
    if (!(qty > 0) || !(avg > 0)) return realized;
    const gross = qty * price;
    const fee = feeOnGross(gross, c.feeBpsPerSide);
    const nw = netFeePerEvent();
    realized += gross - fee - nw - inv;
    inv = 0;
    qty = 0;
    avg = 0;
    return realized;
  };

  for (let i = startIdx; i <= endIdx; i++) {
    const t = tsMs[i]!;
    const price = px[i]!;
    if (!(price > 0)) continue;

    tryApplyLegs(t);

    // Синтетическое одноуровневое усреднение
    if (
      p.dcaMode === 'sim6' &&
      !simDcaDone &&
      inv > 0 &&
      avg > 0 &&
      price <= avg * (1 + opts.dcaTriggerPct / 100 + LADDER_EPS)
    ) {
      const addUsd = opts.positionUsd * opts.dcaFraction;
      const synLeg: Leg = {
        ts: t,
        price,
        sizeUsd: addUsd,
        reason: 'dca_sim',
      };
      const n = applyBuyLeg(inv, avg, synLeg);
      inv = n.inv;
      avg = n.avg;
      qty = inv / avg;
      simDcaDone = true;
    }

    if (!(qty > 0) || !(avg > 0)) continue;

    // TP-grid (режим B) до kill — как очередность частичных TP до проверки kill в тикере.
    if (p.ladderStepPnl > 0 && p.ladderSellFrac > 0) {
      const pnlFrac = price / avg - 1;
      let maxK = Math.floor((pnlFrac + LADDER_EPS) / p.ladderStepPnl);
      if (p.ladderMaxRungs > 0 && Number.isFinite(p.ladderMaxRungs)) {
        maxK = Math.min(maxK, p.ladderMaxRungs);
      }
      for (let k = 1; k <= maxK; k++) {
        const threshold = k * p.ladderStepPnl;
        if (pnlFrac + LADDER_EPS < threshold) break;
        if (ladderTaken.has(threshold)) continue;
        ladderTaken.add(threshold);
        const sellQty = qty * Math.min(1, p.ladderSellFrac);
        if (!(sellQty > 0)) continue;
        const gross = sellQty * price;
        const fee = feeOnGross(gross, c.feeBpsPerSide);
        const nw = netFeePerEvent();
        const costPart = sellQty * avg;
        realized += gross - fee - nw - costPart;
        inv -= costPart;
        qty -= sellQty;
        if (inv <= 1e-12 || qty <= 1e-18) {
          inv = 0;
          qty = 0;
          avg = 0;
          break;
        }
        avg = inv / qty;
      }
    }

    // Kill-stop после TP на том же баре
    if (qty > 0 && avg > 0) {
      const dd2 = (price - avg) / avg;
      if (dd2 <= -p.killDrawdownPct / 100 + LADDER_EPS) {
        return fullExit(price);
      }
    }

    if (!(qty > 0)) break;
  }

  const pxEnd =
    endIdx >= 0 ? px[endIdx]! : c.effectiveExitPrice > 0 ? c.effectiveExitPrice : Number.NaN;
  if (qty > 0 && avg > 0 && Number.isFinite(pxEnd)) {
    return fullExit(pxEnd);
  }

  return realized;
}

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** Повторяющийся флаг `--exclude-mint ADDR` или значение через запятую. */
function collectMultiArg(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith('--')) out.push(v);
    }
  }
  return out.flatMap((x) =>
    x
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** `--exclude-close mint:exitTsMs` — исключить одну запись закрытия (например битый PnL после ручных продаж). */
function parseExcludeCloseKeys(): Set<string> {
  const keys = new Set<string>();
  for (const raw of collectMultiArg('--exclude-close')) {
    const idx = raw.lastIndexOf(':');
    if (idx <= 0) continue;
    const mint = raw.slice(0, idx).trim();
    const ts = Number(raw.slice(idx + 1).trim());
    if (mint && Number.isFinite(ts)) keys.add(`${mint}\t${ts}`);
  }
  return keys;
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || process.argv[i + 1] == null) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function buildGrid(fast: boolean): MegaParams[] {
  const kills = fast ? [10, 12, 14, 18] : [8, 10, 12, 14, 16, 18, 20];
  const dcas: DcaMode[] = fast ? ['off', 'journal'] : ['off', 'journal', 'sim6'];
  const steps = fast ? [0.05, 0.06] : [0.04, 0.05, 0.06, 0.07];
  const fracs = fast ? [0.45, 0.5] : [0.35, 0.45, 0.5];
  const rungs = fast ? [4, 999] : [3, 4, 6, 999];

  const out: MegaParams[] = [];
  for (const killDrawdownPct of kills) {
    for (const dcaMode of dcas) {
      for (const ladderStepPnl of steps) {
        for (const ladderSellFrac of fracs) {
          for (const mr of rungs) {
            out.push({
              killDrawdownPct,
              dcaMode,
              ladderStepPnl,
              ladderSellFrac,
              ladderMaxRungs: mr >= 999 ? 10_000 : mr,
            });
          }
        }
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const jsonlPath =
    posArgs[0]?.trim() && fs.existsSync(path.resolve(posArgs[0]))
      ? path.resolve(posArgs[0])
      : path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  const fast = argFlag('--fast');
  const positionUsd = argNum('--position-usd', 600);
  const dcaTriggerPct = argNum('--dca-trigger-pct', -6);
  const dcaFraction = argNum('--dca-fraction', 0.25);

  const grid = buildGrid(fast);
  const { rows: closesRaw, excludedAbsurd } = await loadCloses(jsonlPath);
  const excludeMints = new Set(collectMultiArg('--exclude-mint'));
  const excludeCloseKeys = parseExcludeCloseKeys();
  let excludedManual = 0;
  const closes = closesRaw.filter((c) => {
    if (excludeMints.has(c.mint)) {
      excludedManual++;
      return false;
    }
    if (excludeCloseKeys.has(`${c.mint}\t${c.exitTs}`)) {
      excludedManual++;
      return false;
    }
    return true;
  });
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

  type AggRow = MegaParams & {
    sumNetUsd: number;
    nanCount: number;
    tradesSimulated: number;
  };

  const aggregates: AggRow[] = grid.map((params) => ({
    ...params,
    sumNetUsd: 0,
    nanCount: 0,
    tradesSimulated: 0,
  }));

  for (const c of simRows) {
    for (let gi = 0; gi < grid.length; gi++) {
      const params = grid[gi]!;
      const agg = aggregates[gi]!;
      const r = simulateTrade(c, c.series.tsMs, c.series.px, params, {
        positionUsd,
        dcaTriggerPct,
        dcaFraction,
      });
      if (!Number.isFinite(r)) {
        agg.nanCount++;
        continue;
      }
      agg.sumNetUsd += r;
      agg.tradesSimulated++;
    }
  }

  const ranked = [...aggregates]
    .filter((a) => a.nanCount === 0)
    .sort((a, b) => b.sumNetUsd - a.sumNetUsd);

  const top = ranked.slice(0, 25).map((a) => ({
    killDrawdownPct: a.killDrawdownPct,
    dcaMode: a.dcaMode,
    ladderStepPnl: a.ladderStepPnl,
    ladderSellFrac: a.ladderSellFrac,
    ladderMaxRungs: a.ladderMaxRungs >= 9000 ? 'unlimited' : a.ladderMaxRungs,
    sumNetUsd: +a.sumNetUsd.toFixed(4),
    vsActualDelta: +(a.sumNetUsd - actualSum).toFixed(4),
  }));

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        modelNotes: [
          'Упрощённая симуляция по дискретным снимкам БД; без trail/retrace/Jupiter.',
          'TP-grid: как live режим B — ступени k·step по нереализованному PnL к avg, продажа доли остатка.',
          'network_fee распределён грубо по событиям выхода.',
          'sim6: одна докупка при триггере к avg (по умолчанию −6%), размер positionUsd*dcaFraction.',
        ],
        closesUsed: closes.length,
        excludedManualJournalRows: excludedManual,
        excludedJournalRows: excludedAbsurd,
        tradesWithSnapshots: simRows.length,
        missingSnapshotSeriesTrades: missingSeries,
        actualSumNetPnlUsd: +actualSum.toFixed(4),
        gridSize: grid.length,
        fastMode: fast,
        positionUsd,
        dcaTriggerPct,
        dcaFraction,
        bestOverall: top[0] ?? null,
        top25: top,
        interpretationHints: [
          'Сравнивайте top25 между собой и с actualSumNetPnlUsd; абсолютные суммы не равны прод-стратегии.',
          'Если лучшие строки кластеризуются около узкого kill + без journal DCA — усреднение по истории ухудшало контрфакт.',
          'ladderMaxRungs unlimited (999→10000 в коде) имитирует live-oscar mode B без потолка ступеней.',
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
