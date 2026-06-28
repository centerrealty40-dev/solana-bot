/**
 * E+2 (1.11.515+): apply avg1 −10% + DIP10_FIRST_TP5 to opens entered before deploy.
 * One-time dip10 backfill from PG price path on restore / first tracker tick.
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import { sourceSnapshotTable } from '../dip-detector.js';
import {
  applyCanonicalStagedEntrySizing,
  resolveLiveOscarStagedAvgFirstDropPct,
} from '../live-oscar-entry-sizing.js';
import { resolveLiveOscarTradeTierFromOpen } from '../live-oscar-mcap-tier.js';
import { isLiveOscarTradingStrategyId } from '../../preset-c/live-oscar-family.js';
import type { OpenTrade } from '../types.js';
import {
  isWaveBExitPolicy,
  waveBHalf8TpTaken,
  WAVE_B_FLAT_TP_HALF8_RUNNER,
} from './exit-policy-wave-b.js';
import { LADDER_PNL_EPS } from './tp-ladder-state.js';

const DEX_SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;
import { reconcileEntrySplitV2FromLegs, stagedAveragingConfigured } from './live-staged-entry-gates.js';

const e2Dip10BackfillInFlight = new Set<string>();

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Signal anchor for staged-entry drop % (fixed at discovery / leg-1). */
export function resolveOpenSignalAnchorUsd(ot: OpenTrade): number | null {
  const st = ot.liveStagedEntry;
  const fromStaged =
    (st?.signalPriceUsd ?? 0) > 0
      ? st!.signalPriceUsd
      : (st?.entrySplitAnchorUsd ?? 0) > 0
        ? st!.entrySplitAnchorUsd!
        : 0;
  if (fromStaged > 0) return fromStaged;
  const openLeg = ot.legs.find((l) => l.reason === 'open');
  const px = openLeg?.marketPrice ?? openLeg?.price ?? ot.entryMcUsd;
  return px > 0 ? px : null;
}

export function signalDropPctFromAnchor(signalPx: number, pricePx: number): number | null {
  if (!(signalPx > 0) || !(pricePx > 0)) return null;
  return (pricePx / signalPx - 1) * 100;
}

/** Chronological replay — mirrors `waveBUpdateDip10ReachedBeforeTp8` tick semantics. */
export function replayDip10ArmingFromPriceSeries(args: {
  points: Array<{ ts: number; minPx: number; maxPx: number }>;
  signalPx: number;
  avgEntry: number;
  signalDropThresholdPct: number;
  half8PnlFrac?: number;
}): boolean {
  const {
    points,
    signalPx,
    avgEntry,
    signalDropThresholdPct,
    half8PnlFrac = WAVE_B_FLAT_TP_HALF8_RUNNER.gridStepPnl,
  } = args;
  if (!(signalPx > 0) || !(avgEntry > 0) || !(signalDropThresholdPct > 0)) return false;

  let peakPnlVsAvg = 0;
  let armed = false;
  const sorted = [...points].sort((a, b) => a.ts - b.ts);

  for (const bucket of sorted) {
    if (armed) break;
    const minDrop = signalDropPctFromAnchor(signalPx, bucket.minPx);
    const maxPnl = bucket.maxPx / avgEntry - 1;
    const peakBefore = peakPnlVsAvg;
    const peakAtCheck = Math.max(peakBefore, maxPnl);
    if (peakAtCheck + LADDER_PNL_EPS >= half8PnlFrac) {
      peakPnlVsAvg = peakAtCheck;
      continue;
    }
    if (minDrop != null && minDrop <= -signalDropThresholdPct) {
      armed = true;
      break;
    }
    peakPnlVsAvg = peakAtCheck;
  }
  return armed;
}

/** Lower bound on signal drop from known leg / partial / last-observed prices (no PG). */
export function minSignalDropPctFromOpenTradeMarks(ot: OpenTrade): number | null {
  const signalPx = resolveOpenSignalAnchorUsd(ot);
  if (signalPx == null) return null;
  let minPx = Infinity;
  for (const leg of ot.legs) {
    const px = leg.marketPrice ?? leg.price;
    if (px > 0) minPx = Math.min(minPx, px);
  }
  for (const p of ot.partialSells) {
    const px = p.marketPrice ?? p.price;
    if (px > 0) minPx = Math.min(minPx, px);
  }
  if (typeof ot.lastObservedPriceUsd === 'number' && ot.lastObservedPriceUsd > 0) {
    minPx = Math.min(minPx, ot.lastObservedPriceUsd);
  }
  if (!Number.isFinite(minPx)) return null;
  return signalDropPctFromAnchor(signalPx, minPx);
}

function dip10BackfillEligible(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return false;
  if (!cfg.liveOscarDip10FirstTp5Enabled) return false;
  if (!isWaveBExitPolicy(ot)) return false;
  if (ot.liveWaveFlatTpMode !== 'half8_runner') return false;
  if (ot.liveWaveDip10ReachedBeforeTp8 === true) return false;
  if (ot.liveWaveDip10FirstTp5PartialTaken) return false;
  if (waveBHalf8TpTaken(ot)) return false;
  if (ot.remainingFraction <= 1e-9) return false;
  return true;
}

/** Sync: infer dip10 from open marks when PG unavailable. */
export function tryBackfillDip10FromOpenTradeState(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!dip10BackfillEligible(ot, cfg)) return false;

  const signalPx = resolveOpenSignalAnchorUsd(ot);
  const avgEntry = ot.avgEntry;
  if (signalPx == null || !(avgEntry > 0)) return false;

  const peakPnl = ot.liveWavePeakPnlFrac ?? 0;
  if (peakPnl + LADDER_PNL_EPS >= WAVE_B_FLAT_TP_HALF8_RUNNER.gridStepPnl) return false;

  const minDrop = minSignalDropPctFromOpenTradeMarks(ot);
  if (minDrop == null || minDrop > -cfg.liveOscarDip10FirstTp5SignalDropPct) return false;

  ot.liveWaveDip10ReachedBeforeTp8 = true;
  return true;
}

async function fetchHourlyMinMaxSinceEntry(args: {
  mint: string;
  entryTsMs: number;
  source?: string;
}): Promise<Array<{ ts: number; minPx: number; maxPx: number }>> {
  const tables: string[] = [];
  const primary = args.source ? sourceSnapshotTable(args.source) : null;
  if (primary) tables.push(primary);
  for (const t of DEX_SNAPSHOT_TABLES) {
    if (!tables.includes(t)) tables.push(t);
  }

  const startSec = Math.floor(args.entryTsMs / 1000);
  const qm = sqlQuote(args.mint);

  for (const table of tables) {
    const q = `
      SELECT
        (EXTRACT(EPOCH FROM date_trunc('hour', ts)) * 1000)::bigint AS bucket_ms,
        MIN(price_usd) FILTER (WHERE COALESCE(price_usd, 0) > 0)::float8 AS min_px,
        MAX(price_usd) FILTER (WHERE COALESCE(price_usd, 0) > 0)::float8 AS max_px
      FROM ${table}
      WHERE base_mint = ${qm}
        AND ts >= to_timestamp(${startSec})
        AND COALESCE(price_usd, 0) > 0
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    try {
      const r = await db.execute(dsql.raw(q));
      const rows = r as unknown as Array<{ bucket_ms: number | string; min_px: number; max_px: number }>;
      const points = rows
        .map((row) => ({
          ts: Number(row.bucket_ms),
          minPx: Number(row.min_px),
          maxPx: Number(row.max_px),
        }))
        .filter((p) => p.ts > 0 && p.minPx > 0 && p.maxPx > 0);
      if (points.length > 0) return points;
    } catch {
      /* try next table */
    }
  }
  return [];
}

/** Async one-time PG backfill for dip10-before-tp8 on pre-deploy opens. */
export async function attemptE2Dip10BackfillFromPg(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
): Promise<boolean> {
  if (!dip10BackfillEligible(ot, cfg)) return false;
  if (ot.liveE2Dip10BackfillAttempted) return false;

  const signalPx = resolveOpenSignalAnchorUsd(ot);
  const avgEntry = ot.avgEntry;
  if (signalPx == null || !(avgEntry > 0)) {
    ot.liveE2Dip10BackfillAttempted = true;
    return false;
  }

  const points = await fetchHourlyMinMaxSinceEntry({
    mint: ot.mint,
    entryTsMs: ot.entryTs,
    source: ot.source,
  });

  let armed = false;
  if (points.length > 0) {
    armed = replayDip10ArmingFromPriceSeries({
      points,
      signalPx,
      avgEntry,
      signalDropThresholdPct: cfg.liveOscarDip10FirstTp5SignalDropPct,
    });
  }

  if (!armed) {
    armed = tryBackfillDip10FromOpenTradeState(ot, cfg);
  } else {
    ot.liveWaveDip10ReachedBeforeTp8 = true;
  }

  ot.liveE2Dip10BackfillAttempted = true;
  if (armed) {
    console.log(
      `[E2_RECONCILE] ${ot.mint.slice(0, 8)} $${ot.symbol} dip10-before-tp8 backfilled (open pre-E+2)`,
    );
  }
  return armed;
}

/** Retarget pending avg1 from legacy −5% to canonical −10% without double-fill. */
export function reconcileE2StagedAvgThreshold(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return false;
  const st = ot.liveStagedEntry;
  if (!st?.entrySplitV2 || st.mintFirstProbe) return false;
  if (!stagedAveragingConfigured(st)) return false;

  reconcileEntrySplitV2FromLegs(ot);
  if (st.avgFirstLegDone || ot.legs.some((l) => l.reason === 'staged_avg')) return false;

  const tier = resolveLiveOscarTradeTierFromOpen(cfg, ot);
  const prevDrop = st.avgSecondDropPct ?? st.secondDropPct ?? 0;
  const canonicalDrop = resolveLiveOscarStagedAvgFirstDropPct(cfg, tier);

  applyCanonicalStagedEntrySizing(cfg, st, tier, ot.entryMarketCapUsd);

  return prevDrop > 0 && prevDrop < canonicalDrop;
}

/**
 * Sync reconcile on JSONL restore / tracker boot — avg retarget + best-effort dip10 from marks.
 * Returns true if any E+2 field changed.
 */
export function reconcileE2OpenOnRestore(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return false;
  let changed = reconcileE2StagedAvgThreshold(ot, cfg);
  if (tryBackfillDip10FromOpenTradeState(ot, cfg)) changed = true;
  return changed;
}

/**
 * Tracker tick: sync reconcile + schedule one-time async PG dip10 backfill when marks insufficient.
 */
export function reconcileE2OpenOnTrackerTick(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  curMetric?: number,
): void {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return;

  reconcileE2StagedAvgThreshold(ot, cfg);

  if (ot.liveWaveDip10ReachedBeforeTp8 === true) return;
  if (tryBackfillDip10FromOpenTradeState(ot, cfg)) return;
  if (ot.liveE2Dip10BackfillAttempted) return;
  if (e2Dip10BackfillInFlight.has(ot.mint)) return;

  if (curMetric != null && curMetric > 0) {
    const signalPx = resolveOpenSignalAnchorUsd(ot);
    if (signalPx != null) {
      ot.lastObservedPriceUsd = curMetric;
      const drop = signalDropPctFromAnchor(signalPx, curMetric);
      if (drop != null && drop < (minSignalDropPctFromOpenTradeMarks(ot) ?? 0)) {
        if (tryBackfillDip10FromOpenTradeState(ot, cfg)) return;
      }
    }
  }

  e2Dip10BackfillInFlight.add(ot.mint);
  void attemptE2Dip10BackfillFromPg(ot, cfg)
    .catch(() => {
      ot.liveE2Dip10BackfillAttempted = true;
    })
    .finally(() => {
      e2Dip10BackfillInFlight.delete(ot.mint);
    });
}

/** Test helper — reset in-flight guard between vitest cases. */
export function resetE2Dip10BackfillInFlightForTests(): void {
  e2Dip10BackfillInFlight.clear();
}
