/**
 * Impact threshold counterfactual + distribution (signals-only, $1000 instant, HL taker fees).
 * Reuses simulated trades from clean backtest; re-filters entry plan at 2/4/5 %/h with 9m duration floor.
 */
process.env.HL_TWAP_UNRESTRICTED = '1';
process.env.HL_TWAP_MICRO_MIN_MINUTES = '9';
process.env.HL_TWAP_MICRO_MAX_MINUTES = '15';

import fs from 'node:fs';
import path from 'node:path';

import {
  aggregateCoinHourlyImpacts,
  aggregateCoinImpacts,
  crossingImpactDecision,
  twapHourlyImpactPct,
  type ActiveTwapLookup,
  type CoinEntryPlan,
} from '../src/hyperliquid/twap/coin-twap-analysis.js';
import { computeTwapSchedule } from '../src/hyperliquid/twap/twap-schedule.js';
import {
  isMicroTwapMinutes,
  twapDurationGate,
  twapMicroMinMinutesInclusive,
} from '../src/hyperliquid/twap/twap-duration.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

const SIGNALS = path.join(
  process.cwd(),
  process.env.HL_BT_SIGNALS ?? 'scripts-tmp/_prod_hl_signals_full.jsonl',
);
const CLEAN_BT = path.join(process.cwd(), 'scripts-tmp/_hl_signals_clean_backtest.json');
const OUT_THRESH = path.join(process.cwd(), 'scripts-tmp/_hl_impact_threshold_backtest.json');
const OUT_DIST = path.join(process.cwd(), 'scripts-tmp/_hl_impact_distribution.json');

const THRESHOLDS = [2, 4, 5] as const;
const FAT_BUCKETS = [4, 5, 10] as const;
const NOTIONAL = Number(process.env.HL_BT_NOTIONAL_USD ?? 1000);
const FEE_BPS = Number(process.env.HL_BT_FEE_BPS ?? 4.5);
const MIN_DURATION = twapMicroMinMinutesInclusive();

type TradeRow = {
  hash: string;
  coin: string;
  minutes: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  error?: string;
  signalAt?: string;
};

type Agg = {
  n: number;
  wins: number;
  grossSum: number;
  feesSum: number;
  netSum: number;
  winPct: number;
  avgNet: number;
};

function agg(rows: TradeRow[]): Agg {
  const ok = rows.filter((r) => !r.error);
  const n = ok.length;
  const wins = ok.filter((r) => r.netPnlUsd > 0).length;
  const grossSum = ok.reduce((s, r) => s + r.grossPnlUsd, 0);
  const feesSum = ok.reduce((s, r) => s + r.feesUsd, 0);
  const netSum = ok.reduce((s, r) => s + r.netPnlUsd, 0);
  return {
    n,
    wins,
    grossSum,
    feesSum,
    netSum,
    winPct: n ? (100 * wins) / n : 0,
    avgNet: n ? netSum / n : 0,
  };
}

function normalizeSig(payload: Record<string, unknown>): NormalizedTwapSignal | null {
  const raw = (payload.sig as NormalizedTwapSignal | undefined) ?? (payload as NormalizedTwapSignal);
  if (!raw?.hash || !raw.coin || !raw.side) return null;
  return raw;
}

function buildActiveAt(
  starts: Array<{ sig: NormalizedTwapSignal; signalAtMs: number }>,
  ends: Map<string, { endAtMs: number }>,
  atMs: number,
): ActiveTwapLookup {
  const activeByHash = new Map<string, NormalizedTwapSignal>();
  for (const { sig, signalAtMs } of starts) {
    if (signalAtMs > atMs) continue;
    const end = ends.get(sig.hash);
    const sched = computeTwapSchedule(sig);
    const naturalEndMs = end?.endAtMs > 0 ? end.endAtMs : sched.lastCycleEtaMs;
    if (naturalEndMs > atMs) activeByHash.set(sig.hash, sig);
  }
  return { activeByHash };
}

function computeEntryPlanAsOf(
  sig: NormalizedTwapSignal,
  state: ActiveTwapLookup,
  minHourPct: number,
  asOfMs: number,
): CoinEntryPlan {
  const duration = twapDurationGate(sig.minutes);
  if (!duration.allow) {
    const activeOnCoin = [...state.activeByHash.values()].filter((t) => t.coin === sig.coin);
    const allIncludingSig = activeOnCoin.some((t) => t.hash === sig.hash)
      ? activeOnCoin
      : [...activeOnCoin, sig];
    const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(allIncludingSig);
    const { diffPct, dominant } = crossingImpactDecision(
      buyPctPerHour,
      sellPctPerHour,
      minHourPct,
    );
    const { buyPct, sellPct } = aggregateCoinImpacts(allIncludingSig);
    const sched = computeTwapSchedule(sig);
    return {
      allow: false,
      reason: duration.reason,
      buyPct,
      sellPct,
      buyPctPerHour,
      sellPctPerHour,
      diffPct,
      dominant,
      openAtMs: sched.paperOpenAtMs,
      waitForOppositeEndsMs: null,
    };
  }

  const activeOnCoin = [...state.activeByHash.values()].filter((t) => t.coin === sig.coin);
  const allIncludingSig = activeOnCoin.some((t) => t.hash === sig.hash)
    ? activeOnCoin
    : [...activeOnCoin, sig];
  const sched = computeTwapSchedule(sig);
  const baseOpenMs = sched.paperOpenAtMs;

  const deny = (reason: string): CoinEntryPlan => {
    const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(allIncludingSig);
    const { diffPct, dominant } = crossingImpactDecision(
      buyPctPerHour,
      sellPctPerHour,
      minHourPct,
    );
    const { buyPct, sellPct } = aggregateCoinImpacts(allIncludingSig);
    return {
      allow: false,
      reason,
      buyPct,
      sellPct,
      buyPctPerHour,
      sellPctPerHour,
      diffPct,
      dominant,
      openAtMs: baseOpenMs,
      waitForOppositeEndsMs: null,
    };
  };

  const tryAt = (twaps: NormalizedTwapSignal[], openAtMs: number, reason: string): CoinEntryPlan | null => {
    if (twapHourlyImpactPct(sig) == null) return null;
    const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(twaps);
    const { allow, dominant, diffPct } = crossingImpactDecision(
      buyPctPerHour,
      sellPctPerHour,
      minHourPct,
    );
    if (!allow || !dominant || dominant !== sig.side) return null;
    const effectiveOpen = Math.max(openAtMs, sched.paperOpenAtMs);
    const { buyPct, sellPct } = aggregateCoinImpacts(twaps);
    return {
      allow: true,
      reason,
      buyPct,
      sellPct,
      buyPctPerHour,
      sellPctPerHour,
      diffPct,
      dominant,
      openAtMs: effectiveOpen,
      waitForOppositeEndsMs: reason === 'deferred_opposite_end' ? effectiveOpen : null,
    };
  };

  const okReason = isMicroTwapMinutes(sig.minutes) ? 'ok_micro' : 'ok';
  const nowPlan = tryAt(allIncludingSig, Math.max(baseOpenMs, asOfMs), okReason);
  if (nowPlan) return nowPlan;

  const opposing = allIncludingSig.filter((t) => t.side !== sig.side);
  const endEvents = opposing
    .map((t) => ({ twap: t, endMs: computeTwapSchedule(t).lastCycleEtaMs }))
    .sort((a, b) => a.endMs - b.endMs);

  for (let i = 0; i < endEvents.length; i++) {
    const cutoff = endEvents[i]!.endMs;
    const endedHashes = new Set(endEvents.slice(0, i + 1).map((e) => e.twap.hash));
    const remaining = allIncludingSig.filter((t) => !endedHashes.has(t.hash));
    const plan = tryAt(remaining, cutoff, 'deferred_opposite_end');
    if (plan) return plan;
  }

  return deny('hourly_impact_no_edge');
}

function loadSignals(): {
  starts: Array<{ sig: NormalizedTwapSignal; signalAt: string; signalAtMs: number }>;
  ends: Map<string, { endAtMs: number }>;
} {
  const raw = fs.readFileSync(SIGNALS, 'utf8');
  const startsByHash = new Map<
    string,
    { sig: NormalizedTwapSignal; signalAt: string; signalAtMs: number }
  >();
  const ends = new Map<string, { endAtMs: number }>();

  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let row: { at?: string; event?: string; payload?: Record<string, unknown> };
    try {
      row = JSON.parse(ln);
    } catch {
      continue;
    }
    const at = row.at ?? '';
    const atMs = Date.parse(at);
    if (row.event === 'twap_start' && row.payload) {
      const sig = normalizeSig(row.payload);
      if (!sig) continue;
      const prev = startsByHash.get(sig.hash);
      if (!prev || at < prev.signalAt) {
        startsByHash.set(sig.hash, {
          sig,
          signalAt: at,
          signalAtMs: Number.isFinite(atMs) ? atMs : sig.startedAtMs,
        });
      }
    } else if (row.event === 'twap_end' && row.payload) {
      const hash =
        (row.payload.sig as { hash?: string } | undefined)?.hash ??
        (row.payload.hash as string | undefined);
      if (!hash) continue;
      ends.set(hash, { endAtMs: Number.isFinite(atMs) ? atMs : 0 });
    }
  }
  return { starts: [...startsByHash.values()], ends };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

function deciles(values: number[]): Array<{ decile: number; min: number; max: number; count: number }> {
  const sorted = [...values].sort((a, b) => a - b);
  const out: Array<{ decile: number; min: number; max: number; count: number }> = [];
  for (let d = 1; d <= 10; d++) {
    const lo = Math.ceil(((d - 1) / 10) * sorted.length);
    const hi = Math.ceil((d / 10) * sorted.length);
    const slice = sorted.slice(lo, hi);
    out.push({
      decile: d,
      min: slice[0] ?? 0,
      max: slice[slice.length - 1] ?? 0,
      count: slice.length,
    });
  }
  return out;
}

function histogram(values: number[], edges: number[]): Array<{ lo: number; hi: number; count: number; pct: number }> {
  const n = values.length;
  const out: Array<{ lo: number; hi: number; count: number; pct: number }> = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!;
    const hi = edges[i + 1]!;
    const count = values.filter((v) => v >= lo && (i === edges.length - 2 ? v <= hi : v < hi)).length;
    out.push({ lo, hi, count, pct: n ? (100 * count) / n : 0 });
  }
  return out;
}

function main() {
  if (!fs.existsSync(SIGNALS)) {
    console.error(`Missing signals: ${SIGNALS}`);
    process.exit(1);
  }
  if (!fs.existsSync(CLEAN_BT)) {
    console.error(`Run hl-twap-signals-clean-backtest.ts first: ${CLEAN_BT}`);
    process.exit(1);
  }

  const { starts, ends } = loadSignals();
  const allStartsMeta = starts.map((s) => ({ sig: s.sig, signalAtMs: s.signalAtMs }));
  const startByHash = new Map(starts.map((s) => [s.sig.hash, s]));

  const hourlyImpacts: number[] = [];
  const netImpacts: number[] = [];
  let missingImpact = 0;
  let belowMinDuration = 0;

  for (const start of starts) {
    const m = Math.round(start.sig.minutes);
    if (m < MIN_DURATION) belowMinDuration += 1;
    const h = twapHourlyImpactPct(start.sig);
    if (h == null) {
      missingImpact += 1;
      continue;
    }
    hourlyImpacts.push(h);

    const plan = computeEntryPlanAsOf(
      start.sig,
      buildActiveAt(allStartsMeta, ends, start.signalAtMs),
      2,
      start.signalAtMs,
    );
    if (plan.diffPct != null) netImpacts.push(plan.diffPct);
  }

  const sorted = [...hourlyImpacts].sort((a, b) => a - b);
  const fatCounts = Object.fromEntries(
    FAT_BUCKETS.map((b) => [String(b), hourlyImpacts.filter((h) => h >= b).length]),
  ) as Record<string, number>;
  const fatPct = Object.fromEntries(
    FAT_BUCKETS.map((b) => [
      String(b),
      hourlyImpacts.length ? (100 * fatCounts[String(b)!]!) / hourlyImpacts.length : 0,
    ]),
  ) as Record<string, number>;

  const topDecileThreshold = percentile(sorted, 90);
  const topDecileVolumeShare =
    hourlyImpacts.length > 0
      ? (hourlyImpacts.filter((h) => h >= topDecileThreshold).reduce((s, h) => s + h, 0) /
          hourlyImpacts.reduce((s, h) => s + h, 0)) *
        100
      : 0;

  const distribution = {
    generatedAt: new Date().toISOString(),
    source: SIGNALS,
    uniqueTwapStarts: starts.length,
    withHourlyImpact: hourlyImpacts.length,
    missingHourlyImpact: missingImpact,
    belowMinDurationMinutes: belowMinDuration,
    minDurationMinutes: MIN_DURATION,
    hourlyImpactPct: {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] ?? 0,
      mean: sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0,
      deciles: deciles(hourlyImpacts),
      histogramPctPerHour: histogram(hourlyImpacts, [0, 1, 2, 3, 4, 5, 7, 10, 15, 25, 50, 200]),
    },
    fatOrders: {
      thresholdsPctPerHour: FAT_BUCKETS,
      countAtOrAbove: fatCounts,
      pctOfSignalsAtOrAbove: fatPct,
      topDecileThresholdPctPerHour: topDecileThreshold,
      topDecileShareOfTotalImpactVolumePct: topDecileVolumeShare,
    },
    netDominantImpactAt2Pct: {
      count: netImpacts.length,
      p50: percentile([...netImpacts].sort((a, b) => a - b), 50),
      p90: percentile([...netImpacts].sort((a, b) => a - b), 90),
    },
  };

  fs.writeFileSync(OUT_DIST, JSON.stringify(distribution, null, 2));

  const clean = JSON.parse(fs.readFileSync(CLEAN_BT, 'utf8')) as {
    trades: TradeRow[];
    period?: { from?: string; to?: string };
    methodology?: Record<string, unknown>;
  };
  const tradesByHash = new Map(clean.trades.filter((t) => !t.error).map((t) => [t.hash, t]));

  const byThreshold: Record<
    string,
    Agg & {
      thresholdPctPerHour: number;
      eligibleSignals: number;
      blockedByDuration: number;
    }
  > = {};

  for (const threshold of THRESHOLDS) {
    let eligibleSignals = 0;
    let blockedByDuration = 0;
    const matched: TradeRow[] = [];

    for (const start of starts) {
      const m = Math.round(start.sig.minutes);
      if (m < MIN_DURATION) {
        blockedByDuration += 1;
        continue;
      }
      const plan = computeEntryPlanAsOf(
        start.sig,
        buildActiveAt(allStartsMeta, ends, start.signalAtMs),
        threshold,
        start.signalAtMs,
      );
      if (!plan.allow || twapHourlyImpactPct(start.sig) == null) continue;
      eligibleSignals += 1;
      const trade = tradesByHash.get(start.sig.hash);
      if (trade) matched.push(trade);
    }

    byThreshold[String(threshold)] = {
      thresholdPctPerHour: threshold,
      eligibleSignals,
      blockedByDuration,
      ...agg(matched),
    };
  }

  const thresholdReport = {
    generatedAt: new Date().toISOString(),
    methodology: {
      ...(clean.methodology ?? {}),
      notionalUsd: NOTIONAL,
      feesBpsPerLeg: FEE_BPS,
      minDurationMinutes: MIN_DURATION,
      thresholdsPctPerHour: THRESHOLDS,
      note: 'Counterfactual filter on clean backtest trades ($1000 instant, fees on entry+exit); PNL unchanged per trade',
      impactDistributionFile: OUT_DIST,
    },
    period: clean.period,
    byThreshold,
    sizingNote: {
      tradesAt2Pct: byThreshold['2']?.n ?? 0,
      tradesAt5Pct: byThreshold['5']?.n ?? 0,
      concentrationRatio:
        (byThreshold['5']?.n ?? 0) > 0
          ? (byThreshold['2']?.n ?? 0) / (byThreshold['5']?.n ?? 0)
          : null,
      avgNetAt2Pct: byThreshold['2']?.avgNet ?? 0,
      avgNetAt5Pct: byThreshold['5']?.avgNet ?? 0,
    },
  };

  fs.writeFileSync(OUT_THRESH, JSON.stringify(thresholdReport, null, 2));

  console.log(JSON.stringify({ distribution: OUT_DIST, threshold: OUT_THRESH, byThreshold }, null, 2));
}

main();
