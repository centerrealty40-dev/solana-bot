/**
 * Historical counterfactuals on **real closed trades**: sweep min liquidity, min vol5m,
 * per-mint cooldown, pre-entry path gates (uptrend / entry-in-range-high / bounce-after-dump).
 *
 *   npx tsx src/scripts/paper2-counterfactual-gates.ts --since-hours 720 \
 *     --path-hours 48 --norm-first-leg-usd 100 --slots 1,2,4 \
 *     --cooldown-sweep-hours 0,0.5,1,2,3,4,6,8,12,18,24,36,48 --jsonl data/live/pt1-oscar-live.jsonl
 *
 * Отключить свип cooldown: --cooldown-sweep-hours off
 *
 * Все суммы в отчёте — теоретический realized net при фиксированном первом входе
 * `--norm-first-leg-usd` (default 100): линейное масштабирование от фактического legs[0].sizeUsd.
 *
 * Requires DATABASE_URL.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import {
  anchorsWindow,
  fetchAnchorsPg,
  fetchSnapshotNearTs,
  pathStats,
  scanJournal,
  type ClosedPair,
} from './paper2-loss-attribution-deep-dive.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function collectJsonlPaths(): string[] {
  const i = process.argv.indexOf('--jsonl');
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < process.argv.length; k++) {
    const p = process.argv[k];
    if (p.startsWith('--')) break;
    out.push(p);
  }
  return out;
}

function extractFeatures(open: Record<string, unknown>): Record<string, unknown> {
  const f = open.features as Record<string, unknown> | undefined;
  return f && typeof f === 'object' ? f : {};
}

/** Sharp rebound from 48h–18h lows into entry in last 18h, sitting high in range — «купили отскок». */
function bounceFromEarlyLowChase(
  anchors: Anchor[],
  entryTs: number,
  entryPx: number,
  entryHi: number | null,
): boolean {
  const ms = 3_600_000;
  const early = anchorsWindow(anchors, entryTs - 48 * ms, entryTs - 18 * ms).map((a) => a.p);
  if (early.length === 0 || entryPx <= 0) return false;
  const earlyMin = Math.min(...early);
  if (earlyMin <= 0) return false;
  const rebound = entryPx / earlyMin - 1;
  return rebound >= 0.16 && (entryHi ?? 0) >= 0.55;
}

type ScaleBasis = 'first_leg' | 'total_invested' | 'raw';

type Row = ClosedPair & {
  liq: number | null;
  vol5m: number | null;
  regime: string;
  entryHi: number | null;
  pre48Ret: number | null;
  preSlope: number | null;
  bounceChase: boolean;
  anchors: Anchor[];
  /** Как получили масштаб: первый ног / весь invested / без масштаба */
  scaleBasis: ScaleBasis;
  /** Фактический USD-размер, от которого масштабировали (0 если raw) */
  basisUsd: number;
  /** PnL как если бы первый вход был ровно `normFirstLegUsd` (все агрегаты ниже по этому полю) */
  netUsdNorm: number;
};

function scaledNetForNormLeg(netUsd: number, open: Record<string, unknown>, normFirstLegUsd: number): {
  netUsdNorm: number;
  scaleBasis: ScaleBasis;
  basisUsd: number;
} {
  const legs = open.legs as Array<{ sizeUsd?: number }> | undefined;
  const firstLeg = Number(legs?.[0]?.sizeUsd ?? 0);
  const totalInv = Number(open.totalInvestedUsd ?? 0);
  if (firstLeg > 0) {
    return {
      netUsdNorm: netUsd * (normFirstLegUsd / firstLeg),
      scaleBasis: 'first_leg',
      basisUsd: firstLeg,
    };
  }
  if (totalInv > 0) {
    return {
      netUsdNorm: netUsd * (normFirstLegUsd / totalInv),
      scaleBasis: 'total_invested',
      basisUsd: totalInv,
    };
  }
  return { netUsdNorm: netUsd, scaleBasis: 'raw', basisUsd: 0 };
}

function avgHoldHours(rows: Row[]): number {
  if (!rows.length) return 0;
  const msH = 3_600_000;
  return rows.reduce((s, r) => s + (r.exitTs - r.entryTs) / msH, 0) / rows.length;
}

function rowKey(r: Pick<Row, 'mint' | 'entryTs' | 'exitTs'>): string {
  return `${r.mint}:${r.entryTs}:${r.exitTs}`;
}

function dedupeRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function toKeySet(arr: Row[]): Set<string> {
  return new Set(arr.map(rowKey));
}

/** Хронологическая очередь журнала + K непересекающихся слотов: следующая разрешённая сделка занимает слот — эмпирическая замена без выдуманных входов. */
function slotQueueSim(
  rows: Row[],
  kept: Set<string>,
  slots: number,
): {
  n: number;
  sum: number;
  blockedPolicy: number;
  blockedCapacity: number;
  maxDdUsd: number;
} {
  const kSlots = Math.max(1, Math.floor(slots));
  const sorted = [...rows].sort((a, b) => a.entryTs - b.entryTs || a.exitTs - b.exitTs);
  const freeAt = Array.from({ length: kSlots }, () => 0);
  let sum = 0;
  let n = 0;
  let blockedPolicy = 0;
  let blockedCapacity = 0;
  const execPnls: number[] = [];
  for (const r of sorted) {
    const k = rowKey(r);
    if (!kept.has(k)) {
      blockedPolicy++;
      continue;
    }
    let bestIdx = -1;
    let bestFree = -Infinity;
    for (let i = 0; i < kSlots; i++) {
      if (freeAt[i] <= r.entryTs && freeAt[i] > bestFree) {
        bestFree = freeAt[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      blockedCapacity++;
      continue;
    }
    freeAt[bestIdx] = r.exitTs;
    sum += r.netUsdNorm;
    n++;
    execPnls.push(r.netUsdNorm);
  }
  let cum = 0;
  let peak = 0;
  let maxDdUsd = 0;
  for (const p of execPnls) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDdUsd = Math.max(maxDdUsd, peak - cum);
  }
  return { n, sum, blockedPolicy, blockedCapacity, maxDdUsd };
}

function sumNet(rows: Row[]): { n: number; sum: number; avg: number } {
  const n = rows.length;
  const sum = rows.reduce((s, r) => s + r.netUsdNorm, 0);
  return { n, sum, avg: n ? sum / n : 0 };
}

function winRate(rows: Row[]): number {
  if (!rows.length) return 0;
  return rows.filter((r) => r.netUsdNorm > 0).length / rows.length;
}

function fmt(x: { n: number; sum: number; avg: number }): string {
  return `n=${x.n} sum=$${x.sum.toFixed(2)} avg=$${x.avg.toFixed(2)}`;
}

function groupByMint(rows: Row[]): Map<string, Row[]> {
  const byMint = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byMint.get(r.mint) ?? [];
    arr.push(r);
    byMint.set(r.mint, arr);
  }
  return byMint;
}

/** Минимальный gap **exit → следующий entry** на том же mint после **любого** закрытия (`hours` может быть дробным). */
function policyExitCooldownAfterAnyClose(rows: Row[], hours: number): Row[] {
  const ms = hours * 3_600_000;
  const kept: Row[] = [];
  for (const [, arr] of groupByMint(rows)) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    let lastExit = 0;
    for (const t of arr) {
      if (lastExit > 0 && t.entryTs < lastExit + ms) continue;
      kept.push(t);
      lastExit = t.exitTs;
    }
  }
  return kept;
}

function parseCooldownSweepHours(): number[] | null {
  const raw = arg('--cooldown-sweep-hours');
  if (raw != null && ['off', 'false', 'no'].includes(raw.trim().toLowerCase())) return null;
  const def = '0,0.5,1,2,3,4,6,8,12,18,24,36,48';
  const s = (raw ?? def).trim();
  const vals = s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (!vals.length) return null;
  return [...new Set(vals)].sort((a, b) => a - b);
}

function fmtSweepH(h: number): string {
  if (h === 0) return '0';
  return Number.isInteger(h) ? String(h) : Number(h.toFixed(2)).toString();
}

type CooldownSweepRow = {
  h: number;
  subset: ReturnType<typeof sumNet>;
  sims: Map<number, ReturnType<typeof slotQueueSim>>;
};

function pickBetterCooldownRow(a: CooldownSweepRow, b: CooldownSweepRow, k: number): CooldownSweepRow {
  const sa = a.sims.get(k)!;
  const sb = b.sims.get(k)!;
  if (sb.sum !== sa.sum) return sb.sum > sa.sum ? b : a;
  if (sb.n !== sa.n) return sb.n > sa.n ? b : a;
  return a.h <= b.h ? a : b;
}

function printCooldownSweepSection(enriched: Row[], slotsKs: number[]): void {
  const sweepParsed = parseCooldownSweepHours();
  if (!sweepParsed) {
    console.log(`\n======== J) Свип cooldown пропущен (--cooldown-sweep-hours off) ========`);
    return;
  }
  const sweepHours = sweepParsed;

  console.log(`\n======== J) Свип exit→entry cooldown (подбор H по журналу) ========`);
  console.log(
    `Параметр --cooldown-sweep-hours: ${sweepHours.map(fmtSweepH).join(', ')} ч (дробные допустимы, напр. 0.5 = 30 мин).`,
  );
  console.log(
    `(A) пауза после **любого** закрытия на mint; (B) пауза только если предыдущее **kept**-закрытие было в минус (loss-only).`,
  );
  console.log(`subset = сумма без учёта слотов; exK/sK$/ddK = исполнение при K слотах, maxDD по кумулятиву; ΔK = sK − baseline@K.\n`);

  const baselineKeys = toKeySet(enriched);
  const baselineBySlots = new Map<number, ReturnType<typeof slotQueueSim>>();
  for (const k of slotsKs) {
    baselineBySlots.set(k, slotQueueSim(enriched, baselineKeys, k));
  }

  function runSweep(policyFn: (rows: Row[], h: number) => Row[]): CooldownSweepRow[] {
    return sweepHours.map((h) => {
      const kept = policyFn(enriched, h);
      const keys = toKeySet(kept);
      const sims = new Map<number, ReturnType<typeof slotQueueSim>>();
      for (const k of slotsKs) {
        sims.set(k, slotQueueSim(enriched, keys, k));
      }
      return { h, subset: sumNet(kept), sims };
    });
  }

  const sweepA = runSweep(policyExitCooldownAfterAnyClose);
  const sweepB = runSweep(policyLossOnlyExitCooldown);

  function printTable(title: string, rows: CooldownSweepRow[]): void {
    console.log(`\n--- ${title} ---`);
    let header = `${'H(h)'.padStart(7)} ${'sub_n'.padStart(6)} ${'subset$'.padStart(10)} ${'avg'.padStart(8)}`;
    for (const k of slotsKs) {
      header += ` ${(`ex${k}`).padStart(5)} ${(`@${k}$`).padStart(9)} ${(`dd${k}`).padStart(7)} ${(`Δ${k}`).padStart(8)}`;
    }
    console.log(header);
    for (const r of rows) {
      let line = `${fmtSweepH(r.h).padStart(7)} ${String(r.subset.n).padStart(6)} ${r.subset.sum.toFixed(2).padStart(10)} ${r.subset.avg.toFixed(2).padStart(8)}`;
      for (const k of slotsKs) {
        const s = r.sims.get(k)!;
        const bs = baselineBySlots.get(k)!;
        const d = s.sum - bs.sum;
        const dStr = `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
        line += ` ${String(s.n).padStart(5)} ${s.sum.toFixed(2).padStart(9)} ${s.maxDdUsd.toFixed(1).padStart(7)} ${dStr.padStart(8)}`;
      }
      console.log(line);
    }
  }

  printTable('(A) После ЛЮБОГО закрытия → минимум H часов до следующего entry (тот же mint)', sweepA);
  printTable('(B) Loss-only: пауза H только если предыдущее закрытие было в минус', sweepB);

  const k0 = slotsKs[0] ?? 1;
  const bestExecA = sweepA.reduce((a, b) => pickBetterCooldownRow(a, b, k0));
  const bestExecB = sweepB.reduce((a, b) => pickBetterCooldownRow(a, b, k0));
  const bestSubA = sweepA.reduce((a, b) => (b.subset.sum > a.subset.sum ? b : a));
  const bestSubB = sweepB.reduce((a, b) => (b.subset.sum > a.subset.sum ? b : a));

  const sA = bestExecA.sims.get(k0)!;
  const sB = bestExecB.sims.get(k0)!;
  const b0 = baselineBySlots.get(k0)!;

  console.log(`\n--- Итог свипа (эм-пирический оптимум на этом журнале, без экстраполяции) ---`);
  console.log(
    `  Лучший **exec@${k0}** (A любой exit): H=${fmtSweepH(bestExecA.h)}h → sum=$${sA.sum.toFixed(2)} (Δ${(sA.sum - b0.sum >= 0 ? '+' : '') + (sA.sum - b0.sum).toFixed(2)} к baseline), n=${sA.n}, maxDD=$${sA.maxDdUsd.toFixed(2)} | subset при этом H: n=${bestExecA.subset.n} sum=$${bestExecA.subset.sum.toFixed(2)}`,
  );
  console.log(
    `  Лучший **subset sum** (A): H=${fmtSweepH(bestSubA.h)}h → subset sum=$${bestSubA.subset.sum.toFixed(2)} (n=${bestSubA.subset.n}); exec@${k0}: $${bestSubA.sims.get(k0)!.sum.toFixed(2)}`,
  );
  console.log(
    `  Лучший **exec@${k0}** (B loss-only): H=${fmtSweepH(bestExecB.h)}h → sum=$${sB.sum.toFixed(2)} (Δ${(sB.sum - b0.sum >= 0 ? '+' : '') + (sB.sum - b0.sum).toFixed(2)}), n=${sB.n}, maxDD=$${sB.maxDdUsd.toFixed(2)} | subset: n=${bestExecB.subset.n} sum=$${bestExecB.subset.sum.toFixed(2)}`,
  );
  console.log(
    `  Лучший **subset sum** (B): H=${fmtSweepH(bestSubB.h)}h → subset sum=$${bestSubB.subset.sum.toFixed(2)} (n=${bestSubB.subset.n}); exec@${k0}: $${bestSubB.sims.get(k0)!.sum.toFixed(2)}`,
  );
  console.log(
    `  Если оптимальный H по exec оказался малым (1–4 ч), а по subset тянет к 24+ ч — типично пересечение слотов «съедает» выгоду длинного cooldown при малом K; смотреть обе строки.`,
  );
}

/** После **убыточного** закрытия ждём `hours` до следующего входа; после плюса — без паузы. */
function policyLossOnlyExitCooldown(rows: Row[], hours: number): Row[] {
  const ms = hours * 3_600_000;
  const kept: Row[] = [];
  for (const [, arr] of groupByMint(rows)) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    let lastKept: Row | null = null;
    for (const t of arr) {
      if (!lastKept) {
        kept.push(t);
        lastKept = t;
        continue;
      }
      const needGap = lastKept.netUsdNorm < 0;
      const gapOk = t.entryTs >= lastKept.exitTs + ms;
      if (!needGap || gapOk) {
        kept.push(t);
        lastKept = t;
      }
    }
  }
  return kept;
}

/** Два минуса подряд по mint → блокируем любые новые входы до `hours` после exit второго минуса. */
function policyTwoLossStreakThenBlock(rows: Row[], hours: number): Row[] {
  const ms = hours * 3_600_000;
  const kept: Row[] = [];
  for (const [, arr] of groupByMint(rows)) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    let streak = 0;
    let blockedUntil = 0;
    for (const t of arr) {
      if (t.entryTs < blockedUntil) continue;
      kept.push(t);
      if (t.netUsdNorm < 0) {
        streak++;
        if (streak >= 2) {
          blockedUntil = t.exitTs + ms;
          streak = 0;
        }
      } else {
        streak = 0;
      }
    }
  }
  return kept;
}

function printPolicyRow(name: string, subset: Row[], baseline: { n: number; sum: number }): void {
  const x = sumNet(subset);
  const dUsd = x.sum - baseline.sum;
  const dPct =
    baseline.sum !== 0 ? (100 * dUsd) / Math.abs(baseline.sum) : baseline.sum === 0 && dUsd === 0 ? 0 : NaN;
  const pctStr = Number.isFinite(dPct) ? `${dPct >= 0 ? '+' : ''}${dPct.toFixed(1)}%` : 'n/a';
  console.log(
    `  ${name.padEnd(52)} ${fmt(x)}   Δvs baseline: $${dUsd >= 0 ? '+' : ''}${dUsd.toFixed(2)} (${pctStr})  trades=${x.n}/${baseline.n}`,
  );
}

async function enrich(rows: ClosedPair[], pathH: number, normFirstLegUsd: number): Promise<Row[]> {
  const out: Row[] = [];
  for (const row of rows) {
    const src = String(row.openTrade.source ?? '').trim();
    const legs = row.openTrade.legs as Array<{ marketPrice?: number; price?: number }> | undefined;
    const entryPx = Number(legs?.[0]?.marketPrice ?? legs?.[0]?.price ?? 0);
    const feat = extractFeatures(row.openTrade);
    let anchors: Anchor[] = [];
    if (sourceSnapshotTable(src) && entryPx > 0) {
      anchors = await fetchAnchorsPg({
        mint: row.mint,
        source: src,
        t0Ms: row.entryTs - pathH * 3_600_000,
        t1Ms: row.entryTs + pathH * 3_600_000,
      });
    }
    const ps = pathStats(anchors, row.entryTs, entryPx, pathH);
    let snap = null as Awaited<ReturnType<typeof fetchSnapshotNearTs>>;
    if (sourceSnapshotTable(src)) {
      snap = await fetchSnapshotNearTs({ mint: row.mint, source: src, nearTsMs: row.entryTs });
    }
    const liq = snap?.liq ?? (feat.liq_usd != null ? Number(feat.liq_usd) : null);
    const vol5m = snap?.vol5m ?? (feat.vol5m_usd != null ? Number(feat.vol5m_usd) : null);
    const entryHi = ps.entryPctInPreRange;
    const bounceChase = bounceFromEarlyLowChase(anchors, row.entryTs, entryPx, entryHi);
    const sc = scaledNetForNormLeg(row.netUsd, row.openTrade, normFirstLegUsd);
    out.push({
      ...row,
      liq,
      vol5m,
      regime: ps.regime,
      entryHi,
      pre48Ret: ps.pre48hRet,
      preSlope: ps.preSlopeLogPerH,
      bounceChase,
      anchors,
      scaleBasis: sc.scaleBasis,
      basisUsd: sc.basisUsd,
      netUsdNorm: sc.netUsdNorm,
    });
  }
  return out;
}

/** Cooldown from **previous exit** to next entry (risk hygiene). */
function cooldownExitToEntryHours(rows: Row[], hours: number): { n: number; sum: number } {
  const ms = hours * 3_600_000;
  let sum = 0;
  let n = 0;
  for (const [, arr] of groupByMint(rows)) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    let lastExit = 0;
    for (const t of arr) {
      if (lastExit > 0 && t.entryTs < lastExit + ms) continue;
      sum += t.netUsdNorm;
      n++;
      lastExit = t.exitTs;
    }
  }
  return { n, sum };
}

/** Matches `dip-clones.ts`: gap **entry → entry** on same mint (`PAPER_DIP_COOLDOWN_MIN`). */
function cooldownEntryToEntryMinutes(rows: Row[], minutes: number): { n: number; sum: number } {
  const ms = minutes * 60_000;
  let sum = 0;
  let n = 0;
  for (const [, arr] of groupByMint(rows)) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    let lastEntry = 0;
    for (const t of arr) {
      if (lastEntry > 0 && t.entryTs < lastEntry + ms) continue;
      sum += t.netUsdNorm;
      n++;
      lastEntry = t.entryTs;
    }
  }
  return { n, sum };
}

function printOptimizationSection(args: {
  sinceH: number;
  normFirstLegUsd: number;
  enriched: Row[];
  slotsKs: number[];
  base: ReturnType<typeof sumNet>;
  baselineBySlots: Map<number, ReturnType<typeof slotQueueSim>>;
  policiesH: Array<{ name: string; rows: Row[] }>;
  bestLiq: { t: number; sum: number; n: number };
  bestV: { t: number; sum: number; n: number };
  bestJ: { liq: number; vol: number; sum: number; n: number };
  minRetainFrac: number;
}): void {
  const {
    sinceH,
    normFirstLegUsd,
    enriched,
    slotsKs,
    base,
    baselineBySlots,
    policiesH,
    bestLiq,
    bestV,
    bestJ,
    minRetainFrac,
  } = args;

  let nFirstLeg = 0;
  let nTotalInv = 0;
  let nRaw = 0;
  for (const r of enriched) {
    if (r.scaleBasis === 'first_leg') nFirstLeg++;
    else if (r.scaleBasis === 'total_invested') nTotalInv++;
    else nRaw++;
  }

  type Summary = {
    name: string;
    subsetN: number;
    subsetSum: number;
    subsetAvg: number;
    winRate: number;
    holdH: number;
    slotMap: Map<number, ReturnType<typeof slotQueueSim> & { dSum: number }>;
  };

  const summaries: Summary[] = policiesH.map((pol) => {
    const sn = sumNet(pol.rows);
    const keys = toKeySet(pol.rows);
    const slotMap = new Map<number, ReturnType<typeof slotQueueSim> & { dSum: number }>();
    for (const k of slotsKs) {
      const sim = slotQueueSim(enriched, keys, k);
      const bs = baselineBySlots.get(k)!;
      slotMap.set(k, { ...sim, dSum: sim.sum - bs.sum });
    }
    return {
      name: pol.name,
      subsetN: sn.n,
      subsetSum: sn.sum,
      subsetAvg: sn.avg,
      winRate: winRate(pol.rows),
      holdH: avgHoldHours(pol.rows),
      slotMap,
    };
  });

  const kPrimary = slotsKs[0] ?? 1;
  const baseS1 = baselineBySlots.get(kPrimary)!;

  const nonBase = summaries.filter((s) => !s.name.startsWith('(baseline)'));
  const bestExecK1 = nonBase.reduce((best, cur) => {
    const cb = cur.slotMap.get(kPrimary)!;
    const bb = best.slotMap.get(kPrimary)!;
    return cb.sum > bb.sum ? cur : best;
  }, nonBase[0]);

  const beatBaselineK1 = nonBase.filter((s) => (s.slotMap.get(kPrimary)?.sum ?? -Infinity) > baseS1.sum);
  const bestDdAmongWinners =
    beatBaselineK1.length === 0
      ? null
      : beatBaselineK1.reduce((best, cur) => {
          const cb = cur.slotMap.get(kPrimary)!;
          const bb = best.slotMap.get(kPrimary)!;
          return cb.maxDdUsd < bb.maxDdUsd ? cur : best;
        });

  const minNForAvg = Math.max(5, Math.min(15, Math.floor(enriched.length * 0.2)));
  const withEnoughN = nonBase.filter((s) => s.subsetN >= minNForAvg);
  const bestSubsetAvg =
    withEnoughN.length === 0
      ? null
      : withEnoughN.reduce((best, cur) => (cur.subsetAvg > best.subsetAvg ? cur : best));

  console.log(`\n======== I) Полная сводка ($${normFirstLegUsd} на первый вход) и оптимизация ========`);
  console.log(`
--- Метод и окно ---
Окно анализа: последние ${sinceH} часов по времени закрытия в журнале.
Сделок после дедупликации: ${enriched.length}.
Единица PnL: теоретический **первый вход $${normFirstLegUsd}** — каждый realized net линейно масштабируется от фактического размера:
  legs[0].sizeUsd → ${nFirstLeg} сделок;
  fallback openTrade.totalInvestedUsd (нет size первой ноги) → ${nTotalInv};
  без масштаба (нет ни того ни другого) → ${nRaw}.
DCA и последующие ноги не моделируются заново: масштабируется **весь** net сделки как пропорция к базе первого входа (если есть только totalInvested — к суммарному входу).
Оговорки из разделов G–H сохраняются: подмножество G не учитывает пересечения; H — greedy K слотов по журналу.
`.trim());

  console.log(`\n--- Baseline (все закрытия в окне) ---`);
  console.log(
    `  subset: ${fmt(base)}  win%=${(100 * winRate(enriched)).toFixed(1)}  avg_hold=${avgHoldHours(enriched).toFixed(1)}h`,
  );
  for (const k of slotsKs) {
    const b = baselineBySlots.get(k)!;
    console.log(
      `  slots=${k}: exec n=${b.n} sum=$${b.sum.toFixed(2)} maxDD=$${b.maxDdUsd.toFixed(2)}  policy_skip=${b.blockedPolicy} cap_skip=${b.blockedCapacity}`,
    );
  }

  console.log(`\n--- Эвристики свипов (при retain≥${(100 * minRetainFrac).toFixed(0)}% строк с данными) ---`);
  console.log(`  Лучший min liq: $${bestLiq.t.toLocaleString()} → n=${bestLiq.n} sum=$${bestLiq.sum.toFixed(2)}`);
  console.log(`  Лучший min vol5m: $${bestV.t.toLocaleString()} → n=${bestV.n} sum=$${bestV.sum.toFixed(2)}`);
  console.log(
    `  Лучшая пара liq×vol5m: minLiq=$${bestJ.liq.toLocaleString()} minVol5m=$${bestJ.vol.toLocaleString()} → n=${bestJ.n} sum=$${bestJ.sum.toFixed(2)}`,
  );

  console.log(`\n--- Рейтинг политик (subset vs исполнение при slots=${kPrimary}) ---`);
  console.log(
    `${'Политика'.padEnd(46)} ${'subset n'.padStart(8)} ${'subset$'.padStart(10)} ${'avg'.padStart(8)} ${'win%'.padStart(7)} ${`exec@${kPrimary}`.padStart(8)} ${`sum@${kPrimary}`.padStart(10)} ${'ΔvsBL'.padStart(10)} ${'maxDD'.padStart(8)}`,
  );
  for (const s of summaries) {
    const sk = s.slotMap.get(kPrimary)!;
    console.log(
      `${s.name.slice(0, 46).padEnd(46)} ${String(s.subsetN).padStart(8)} ${s.subsetSum.toFixed(2).padStart(10)} ${s.subsetAvg.toFixed(2).padStart(8)} ${(100 * s.winRate).toFixed(1).padStart(7)} ${String(sk.n).padStart(8)} ${sk.sum.toFixed(2).padStart(10)} ${sk.dSum >= 0 ? '+' : ''}${sk.dSum.toFixed(2).padStart(9)} ${sk.maxDdUsd.toFixed(2).padStart(8)}`,
    );
  }

  if (slotsKs.length > 1) {
    console.log(`\n--- Исполнение при большем K (сумма / Δ vs baseline тем же K) ---`);
    for (const k of slotsKs) {
      if (k === kPrimary) continue;
      console.log(`  slots=${k}:`);
      for (const s of summaries) {
        const sk = s.slotMap.get(k)!;
        console.log(
          `    ${s.name.slice(0, 42).padEnd(42)} exec n=${String(sk.n).padStart(3)} sum=$${sk.sum.toFixed(2)} Δ=$${sk.dSum >= 0 ? '+' : ''}${sk.dSum.toFixed(2)} maxDD=$${sk.maxDdUsd.toFixed(2)}`,
        );
      }
    }
  }

  console.log(`\n--- Предложение по оптимизации (эмпирически на этом журнале) ---`);
  const lines: string[] = [];
  lines.push(
    `(1) Капитал и throughput: при ${kPrimary} слоте baseline исполняет только ${baseS1.n} из ${enriched.length} записей журнала (cap_skip=${baseS1.blockedCapacity}) — узкое место часто пересечение позиций, не только фильтры.`,
  );
  if (bestExecK1) {
    const sk = bestExecK1.slotMap.get(kPrimary)!;
    lines.push(
      `(2) Максимальный суммарный realized PnL при том же K=${kPrimary}: «${bestExecK1.name}» — exec sum=$${sk.sum.toFixed(2)} (Δ $${sk.dSum >= 0 ? '+' : ''}${sk.dSum.toFixed(2)} к baseline), maxDD=$${sk.maxDdUsd.toFixed(2)}, исполнено сделок ${sk.n}.`,
    );
  }
  if (bestDdAmongWinners && beatBaselineK1.length > 0) {
    const sk = bestDdAmongWinners.slotMap.get(kPrimary)!;
    lines.push(
      `(3) Из политик, дающих exec при K=${kPrimary} **строго лучше** baseline по сумме, наименьшая просадка по кумулятиву: «${bestDdAmongWinners.name}» — sum=$${sk.sum.toFixed(2)}, maxDD=$${sk.maxDdUsd.toFixed(2)}.`,
    );
  }
  if (bestSubsetAvg) {
    lines.push(
      `(4) Наибольшая средняя прибыль на сделку в подмножестве (n≥${minNForAvg}): «${bestSubsetAvg.name}» — avg=$${bestSubsetAvg.subsetAvg.toFixed(2)}, sum=$${bestSubsetAvg.subsetSum.toFixed(2)}, win%=${(100 * bestSubsetAvg.winRate).toFixed(1)}.`,
    );
  }
  lines.push(
    `(5) Практический стек параметров: совместить **статический фильтр ликвидности/объёма** (см. лучшие пороги выше) с **cooldown только после убыточного закрытия** на том же mint (24h в этом окне стабильно лучше 12h по качеству subset); при ограниченном параллелизме ориентироваться на строку exec@${kPrimary}, а не только на subset.`,
  );
  lines.push(
    `(6) Валидация: повторить отчёт на другом окне (--since-hours) и/или втором jsonl; следить, чтобы n у выбранной политики не был слишком мал в новых выборках.`,
  );
  for (const line of lines) console.log(line);
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 720);
  const pathH = Number(arg('--path-hours') ?? 48);
  const minRetainFrac = Number(arg('--min-retain-frac') ?? 0.35);
  const normFirstLegUsdRaw = Number(arg('--norm-first-leg-usd') ?? 100);
  const normFirstLegUsd =
    Number.isFinite(normFirstLegUsdRaw) && normFirstLegUsdRaw > 0 ? normFirstLegUsdRaw : 100;
  const slotsArg = arg('--slots') ?? '1,2,4';
  const slotList = [
    ...new Set(
      slotsArg
        .split(',')
        .map((s) => Math.floor(Number(s.trim())))
        .filter((n) => Number.isFinite(n) && n >= 1),
    ),
  ].sort((a, b) => a - b);
  const slotsKs = slotList.length ? slotList : [1, 2, 4];

  let paths = collectJsonlPaths();
  const dir = arg('--dir');
  if (dir && fs.existsSync(dir)) {
    paths.push(
      ...fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f)),
    );
  }
  paths = [...new Set(paths.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
  if (paths.length === 0) {
    console.error('Provide --jsonl or --dir');
    process.exit(1);
  }

  const sinceCloseMs = Date.now() - sinceH * 3_600_000;
  const pairs: ClosedPair[] = [];
  for (const p of paths) {
    pairs.push(...(await scanJournal(p, sinceCloseMs)));
  }

  console.log(`\n=== Counterfactual gates (last ${sinceH}h closes: ${pairs.length}) ===\n`);
  console.log(
    `PnL unit: theoretical first entry $${normFirstLegUsd} (linear scale from journal legs[0].sizeUsd; see section I).\n`,
  );
  const enrichedRaw = await enrich(pairs, pathH, normFirstLegUsd);
  const enriched = dedupeRows(enrichedRaw);
  const dupN = enrichedRaw.length - enriched.length;
  if (dupN > 0) console.log(`Deduped ${dupN} duplicate journal rows (same mint/entryTs/exitTs).\n`);
  const base = sumNet(enriched);
  console.log(`Baseline (all enriched rows): ${fmt(base)}`);

  const withLiq = enriched.filter((r) => r.liq != null && Number.isFinite(r.liq) && r.liq > 0);
  const withVol = enriched.filter((r) => r.vol5m != null && Number.isFinite(r.vol5m) && r.vol5m > 0);
  const withBoth = enriched.filter(
    (r) =>
      r.liq != null &&
      r.vol5m != null &&
      Number.isFinite(r.liq) &&
      Number.isFinite(r.vol5m) &&
      r.liq > 0 &&
      r.vol5m > 0,
  );

  console.log(`\n--- A) Min liquidity sweep (PG/journal @ entry, USD) ---`);
  console.log(`Rows with liq: ${withLiq.length} of ${enriched.length}`);
  let bestLiq = { t: 0, sum: -Infinity as number, n: 0 };
  const liqSteps = [25_000, 40_000, 55_000, 70_000, 85_000, 100_000, 125_000, 150_000, 200_000, 250_000, 300_000, 400_000];
  for (const t of liqSteps) {
    const sub = withLiq.filter((r) => r.liq! >= t);
    const x = sumNet(sub);
    if (sub.length >= minRetainFrac * withLiq.length && x.sum > bestLiq.sum) {
      bestLiq = { t, sum: x.sum, n: x.n };
    }
    console.log(`  minLiq>=${String(t).padStart(7)} → ${fmt(x)}`);
  }
  console.log(
    `  >>> Best sum with retain≥${(100 * minRetainFrac).toFixed(0)}% of liq-rows: minLiq=$${bestLiq.t} → n=${bestLiq.n} sum=$${bestLiq.sum.toFixed(2)}`,
  );

  console.log(`\n--- B) Min volume_5m sweep (USD) ---`);
  console.log(`Rows with vol5m: ${withVol.length}`);
  let bestV = { t: 0, sum: -Infinity as number, n: 0 };
  const volSteps = [8_000, 12_000, 16_000, 20_000, 25_000, 30_000, 40_000, 50_000, 65_000, 80_000, 100_000];
  for (const t of volSteps) {
    const sub = withVol.filter((r) => r.vol5m! >= t);
    const x = sumNet(sub);
    if (sub.length >= minRetainFrac * withVol.length && x.sum > bestV.sum) {
      bestV = { t, sum: x.sum, n: x.n };
    }
    console.log(`  minVol5m>=${String(t).padStart(7)} → ${fmt(x)}`);
  }
  console.log(
    `  >>> Best sum with retain≥${(100 * minRetainFrac).toFixed(0)}% of vol-rows: minVol5m=$${bestV.t} → n=${bestV.n} sum=$${bestV.sum.toFixed(2)}`,
  );

  console.log(`\n--- C) Joint grid (liq × vol5m) on rows with both ---`);
  console.log(`Rows with both: ${withBoth.length}`);
  let bestJ = { liq: 0, vol: 0, sum: -Infinity as number, n: 0 };
  for (const L of [70_000, 85_000, 100_000, 125_000, 150_000]) {
    for (const V of [16_000, 20_000, 25_000, 30_000, 40_000]) {
      const sub = withBoth.filter((r) => r.liq! >= L && r.vol5m! >= V);
      const x = sumNet(sub);
      if (sub.length >= minRetainFrac * withBoth.length && x.sum > bestJ.sum) {
        bestJ = { liq: L, vol: V, sum: x.sum, n: x.n };
      }
    }
  }
  console.log(
    `  >>> Best joint (retain≥${(100 * minRetainFrac).toFixed(0)}%): minLiq=$${bestJ.liq} minVol5m=$${bestJ.vol} → n=${bestJ.n} sum=$${bestJ.sum.toFixed(2)}`,
  );

  console.log(`\n--- D1) Exit→next-entry cooldown (hours after close) ---`);
  console.log(`  baseline (all closes in window): ${fmt(base)}`);
  for (const h of [0, 6, 12, 18, 24, 36, 48, 72, 96]) {
    const c = cooldownExitToEntryHours(enriched, h);
    console.log(`  gap>=${String(h).padStart(3)}h → n=${c.n} sum=$${c.sum.toFixed(2)} avg=${c.n ? (c.sum / c.n).toFixed(2) : '0'}`);
  }

  console.log(`\n--- D2) Entry→entry cooldown (minutes, same as dip-clones lastEntry map) ---`);
  for (const m of [0, 15, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440]) {
    const c = cooldownEntryToEntryMinutes(enriched, m);
    console.log(`  gap>=${String(m).padStart(4)}m → n=${c.n} sum=$${c.sum.toFixed(2)} avg=${c.n ? (c.sum / c.n).toFixed(2) : '0'}`);
  }

  console.log(`\n--- E) Pre-entry path gates (single-axis) ---`);
  const exUp = enriched.filter((r) => r.regime !== 'pre_entry_uptrend');
  console.log(`  exclude regime pre_entry_uptrend → ${fmt(sumNet(exUp))}`);
  const exNearHi = enriched.filter((r) => r.entryHi == null || r.entryHi < 0.72);
  console.log(`  exclude entry_hi≥72% of 48h range → ${fmt(sumNet(exNearHi))}`);
  const exCombo = enriched.filter(
    (r) => !(r.preSlope != null && r.preSlope > 0.0008 && r.entryHi != null && r.entryHi >= 0.65),
  );
  console.log(`  exclude (preSlope>0.0008 AND entry_hi≥65%) → ${fmt(sumNet(exCombo))}`);
  const exBounce = enriched.filter((r) => !r.bounceChase);
  console.log(`  exclude bounce-from-early-low chase heuristic → ${fmt(sumNet(exBounce))}`);
  const triple = enriched.filter(
    (r) =>
      r.regime !== 'pre_entry_uptrend' &&
      (r.entryHi == null || r.entryHi < 0.72) &&
      !r.bounceChase,
  );
  console.log(`  uptrend ∪ entry_hi ∪ bounce (combined) → ${fmt(sumNet(triple))}`);

  console.log(`\n--- F) Entry-hi threshold sweep (keep trades BELOW threshold only) ---`);
  const hiRows = enriched.filter((r) => r.entryHi != null && Number.isFinite(r.entryHi));
  for (const hi of [0.55, 0.6, 0.65, 0.7, 0.72, 0.75, 0.78, 0.82]) {
    const sub = hiRows.filter((r) => r.entryHi! < hi);
    const orphan = enriched.filter((r) => r.entryHi == null);
    const merged = [...sub, ...orphan];
    const x = sumNet(merged);
    console.log(`  keep entry_hi<${(hi * 100).toFixed(0)}% (+unknown) → ${fmt(x)}`);
  }

  const baselineN = base.n;
  const baselineSum = base.sum;

  console.log(`\n======== G) Эмпирические политики vs baseline (журнал, контрфакт) ========`);
  console.log(
    `Baseline: sum=$${baselineSum.toFixed(2)}  n=${baselineN}  (все закрытия в окне; суммы — при первом входе $${normFirstLegUsd}; строки ниже — подмножество после правила).`,
  );
  console.log(`Δ% считается как (counterfactual_sum − baseline_sum) / |baseline_sum| × 100.\n`);

  printPolicyRow('(baseline) все сделки', enriched, { n: baselineN, sum: baselineSum });

  const keptExit24All = policyExitCooldownAfterAnyClose(enriched, 24);
  printPolicyRow('Exit→entry ≥24h после ЛЮБОГО закрытия', keptExit24All, { n: baselineN, sum: baselineSum });

  printPolicyRow(
    'Exit→entry ≥24h только если предыдущее закрытие было в минус',
    policyLossOnlyExitCooldown(enriched, 24),
    { n: baselineN, sum: baselineSum },
  );
  printPolicyRow(
    'Exit→entry ≥12h только если предыдущее закрытие было в минус',
    policyLossOnlyExitCooldown(enriched, 12),
    { n: baselineN, sum: baselineSum },
  );

  printPolicyRow(
    'Два минуса подряд → блок 24h после exit второго минуса',
    policyTwoLossStreakThenBlock(enriched, 24),
    { n: baselineN, sum: baselineSum },
  );
  printPolicyRow(
    'Два минуса подряд → блок 12h после exit второго минуса',
    policyTwoLossStreakThenBlock(enriched, 12),
    { n: baselineN, sum: baselineSum },
  );

  const liq200vol20 = enriched.filter(
    (r) =>
      r.liq != null &&
      r.vol5m != null &&
      Number.isFinite(r.liq) &&
      Number.isFinite(r.vol5m) &&
      r.liq >= 200_000 &&
      r.vol5m >= 20_000,
  );
  printPolicyRow('Фильтр liq≥200k AND vol5m≥20k (одна сделка = один факт входа)', liq200vol20, {
    n: baselineN,
    sum: baselineSum,
  });

  const comboLoss24 = policyLossOnlyExitCooldown(enriched, 24).filter(
    (r) =>
      r.liq != null &&
      r.vol5m != null &&
      r.liq >= 200_000 &&
      r.vol5m >= 20_000,
  );
  printPolicyRow('Комбо: loss-only exit 24h ∩ liq≥200k ∩ vol5m≥20k', comboLoss24, {
    n: baselineN,
    sum: baselineSum,
  });

  const twoLoss24 = policyTwoLossStreakThenBlock(enriched, 24);

  console.log(`\n======== H) Очередь журнала × слоты капитала (эмпирическая замена) ========`);
  console.log(
    `Сделки упорядочены по entryTs. Политика задаёт подмножество (как в G). Greedy: следующая **разрешённая** сделка занимает слот, если entryTs не раньше освобождения слота; иначе пропуск по нехватке слотов (cap_skip).`,
  );
  console.log(
    `«Замена» здесь = следующие фактические строки журнала, а не смоделированные альтернативные входы. Параметр --slots задаёт K параллельных позиций (default 1,2,4).`,
  );
  console.log(
    `maxDD — максимальная просадка по кумулятивному realized net **принятых** сделок в порядке исполнения (масштаб $${normFirstLegUsd} первый вход).\n`,
  );

  const baselineKeys = toKeySet(enriched);
  const baselineBySlots = new Map<number, ReturnType<typeof slotQueueSim>>();
  for (const k of slotsKs) {
    baselineBySlots.set(k, slotQueueSim(enriched, baselineKeys, k));
  }

  const policiesH: Array<{ name: string; rows: Row[] }> = [
    { name: '(baseline) все сделки', rows: enriched },
    { name: 'Exit→entry ≥24h после любого закрытия', rows: keptExit24All },
    { name: 'Loss-only exit cooldown 24h', rows: policyLossOnlyExitCooldown(enriched, 24) },
    { name: 'Loss-only exit cooldown 12h', rows: policyLossOnlyExitCooldown(enriched, 12) },
    { name: 'Два минуса подряд → блок 24h', rows: twoLoss24 },
    { name: 'liq≥200k ∩ vol5m≥20k', rows: liq200vol20 },
    { name: 'Комбо loss24 ∩ liq/vol', rows: comboLoss24 },
  ];

  for (const pol of policiesH) {
    const keys = toKeySet(pol.rows);
    const sub = sumNet(pol.rows);
    console.log(`--- ${pol.name} ---`);
    console.log(`  subset (игнорируя слоты / пересечения): ${fmt(sub)}`);
    for (const k of slotsKs) {
      const sim = slotQueueSim(enriched, keys, k);
      const baseSim = baselineBySlots.get(k)!;
      const dUsd = sim.sum - baseSim.sum;
      const dPct =
        baseSim.sum !== 0 ? (100 * dUsd) / Math.abs(baseSim.sum) : baseSim.sum === 0 && dUsd === 0 ? 0 : NaN;
      const pctStr = Number.isFinite(dPct) ? `${dPct >= 0 ? '+' : ''}${dPct.toFixed(1)}%` : 'n/a';
      console.log(
        `  slots=${String(k).padStart(2)}: exec n=${String(sim.n).padStart(3)} sum=$${sim.sum.toFixed(2).padStart(9)} avg=${sim.n ? (sim.sum / sim.n).toFixed(2) : '0.00'} maxDD=$${sim.maxDdUsd.toFixed(2)}  policy_skip=${sim.blockedPolicy} cap_skip=${sim.blockedCapacity}  Δvs baseline: $${dUsd >= 0 ? '+' : ''}${dUsd.toFixed(2)} (${pctStr})`,
      );
    }
  }

  printCooldownSweepSection(enriched, slotsKs);

  console.log(
    `\nОговорки: (G) сумма net по подмножеству без учёта пересечений позиций. (H) учитывает непересечение интервалов [entry, exit] в пределах K слотов; blockedPolicy — сделки, выкинутые правилом; cap_skip — правило разрешило, но все слоты заняты. (J) оптимум H зависит от K и журнала — см. строки «Лучший exec» vs «Лучший subset».`,
  );

  printOptimizationSection({
    sinceH,
    normFirstLegUsd,
    enriched,
    slotsKs,
    base,
    baselineBySlots,
    policiesH,
    bestLiq,
    bestV,
    bestJ,
    minRetainFrac,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
