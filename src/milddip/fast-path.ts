/**
 * Fast entry lane — stream / leader triggered.
 *
 * Avoids the slow Dex enrich batch (80 mints behind 120 RPM). One Dex fetch
 * (or cache hit) for structural gates + stream drawdown for timing.
 */
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import type { MildDipCandidate } from './discover.js';
import { evaluateFlatMicroDip, type MildDipCandidateMetrics } from './gates.js';
import {
  evaluateMildStabilizeFromRing,
  mildStabilizeLaneAllowed,
} from './mild-stabilize.js';
import { mildDipPriceRing } from './price-ring.js';

export type StructuralCacheEntry = {
  fetchedAtMs: number;
  priceUsd: number;
  metrics: MildDipCandidateMetrics;
};

const structuralCache = new Map<string, StructuralCacheEntry>();
const lastFastAttemptMs = new Map<string, number>();
/** Per-mint throttle for Dex probes when stream drawdown is not yet in band. */
const lastHotDexProbeMs = new Map<string, number>();
let hotDexProbeWindowStartMs = 0;
let hotDexProbeCount = 0;

/** Test helper. */
export function resetFastPathStateForTests(): void {
  structuralCache.clear();
  lastFastAttemptMs.clear();
  lastHotDexProbeMs.clear();
  hotDexProbeWindowStartMs = 0;
  hotDexProbeCount = 0;
}

/**
 * Rate-limit Dex structural fetches for hot stream mints that lack a local
 * stream drawdown yet (Agmu8X-class: Dex already −18%, ring empty → only
 * leader seed used to wake us).
 */
export function allowHotDexProbe(
  mint: string,
  nowMs: number,
  gapMs: number,
  maxPerMin: number,
): boolean {
  if (!mint || gapMs < 0 || maxPerMin <= 0) return false;
  if (nowMs - hotDexProbeWindowStartMs >= 60_000) {
    hotDexProbeWindowStartMs = nowMs;
    hotDexProbeCount = 0;
  }
  if (hotDexProbeCount >= maxPerMin) return false;
  const last = lastHotDexProbeMs.get(mint) ?? 0;
  if (nowMs - last < gapMs) return false;
  lastHotDexProbeMs.set(mint, nowMs);
  hotDexProbeCount += 1;
  return true;
}

export function noteStructuralCache(
  mint: string,
  priceUsd: number,
  metrics: MildDipCandidateMetrics,
  fetchedAtMs: number,
): void {
  if (!mint || !(priceUsd > 0)) return;
  structuralCache.set(mint, { fetchedAtMs, priceUsd, metrics });
}

export function getStructuralCache(
  mint: string,
  nowMs: number,
  maxAgeMs: number,
): StructuralCacheEntry | null {
  const hit = structuralCache.get(mint);
  if (!hit) return null;
  if (nowMs - hit.fetchedAtMs > maxAgeMs) return null;
  return hit;
}

export function streamDrawdownPct(
  mint: string,
  lookbackMs: number,
  nowMs: number,
): number | null {
  const dd = mildDipPriceRing.drawdownFromPeakPct(mint, lookbackMs, nowMs);
  return dd != null && Number.isFinite(dd) ? dd : null;
}

export function inDipBand(
  dipPct: number | null | undefined,
  minDipPct: number,
  maxDipPct: number,
): boolean {
  return dipPct != null && Number.isFinite(dipPct) && dipPct > minDipPct && dipPct <= maxDipPct;
}

/** Exported for unit tests — structural floors on fast-path candidates. */
export function structuralOk(metrics: MildDipCandidateMetrics, cfg: MildDipConfig): boolean {
  const g = cfg.entry;
  if (metrics.volume5mUsd == null || !(metrics.volume5mUsd >= g.minVolume5mUsd)) return false;
  if (metrics.liquidityUsd == null || !(metrics.liquidityUsd >= g.minLiquidityUsd)) return false;
  if (metrics.marketCapUsd == null || !(metrics.marketCapUsd >= g.minMarketCapUsd)) return false;
  if (metrics.marketCapUsd > g.maxMarketCapUsd) return false;
  if (metrics.pairAgeHours == null || metrics.pairAgeHours < g.minPairAgeHours) return false;
  if (g.maxPairAgeHours > 0 && metrics.pairAgeHours > g.maxPairAgeHours) return false;
  if (g.allowedDexIds.length > 0) {
    const dex = (metrics.dexId ?? '').toLowerCase();
    if (!dex || !g.allowedDexIds.includes(dex)) return false;
  }
  return true;
}

async function loadStructural(
  mint: string,
  cfg: MildDipConfig,
  nowMs: number,
): Promise<StructuralCacheEntry | null> {
  const cached = getStructuralCache(mint, nowMs, cfg.fastPathStructuralCacheMs);
  if (cached) return cached;

  const details = await fetchDexScreenerPairDetails(mint, {
    nowMs,
    bypassCache: false,
    cacheTtlMs: Math.min(5_000, cfg.fastPathStructuralCacheMs),
    allowedDexIds: cfg.entry.allowedDexIds,
  });
  if (!details || !(details.priceUsd != null && details.priceUsd > 0)) return null;

  mildDipPriceRing.note(mint, details.priceUsd, { tsMs: nowMs, source: 'dex' });
  const pairAgeHours =
    details.pairCreatedAtMs != null && details.pairCreatedAtMs > 0
      ? Math.max(0, (nowMs - details.pairCreatedAtMs) / 3_600_000)
      : null;
  const metrics: MildDipCandidateMetrics = {
    priceChange5mPct: details.priceChangeM5Pct,
    volume5mUsd: details.volume5mUsd,
    liquidityUsd: details.liquidityUsd,
    marketCapUsd: details.marketCapUsd,
    pairAgeHours,
    dexId: details.dexId,
    buys5m: details.buys5m,
    sells5m: details.sells5m,
    volume1hUsd: details.volume1hUsd,
    priceChange1hPct: details.priceChangeH1Pct,
  };
  const entry = { fetchedAtMs: nowMs, priceUsd: details.priceUsd, metrics };
  noteStructuralCache(mint, entry.priceUsd, metrics, nowMs);
  return entry;
}

/**
 * Build a fast-path candidate if stream drawdown and/or Dex pc5m is in band
 * and structural floors pass. Returns null when not actionable (incl. deep knife).
 */
export async function evaluateFastPathCandidate(
  cfg: MildDipConfig,
  mint: string,
  nowMs: number,
  trigger: 'stream' | 'leader' | 'scan',
): Promise<MildDipCandidate | null> {
  if (!cfg.fastPathEnabled) return null;
  if (!mint || mint.length < 32) return null;
  if (cfg.deniedMints.includes(mint)) return null;

  const prevAttempt = lastFastAttemptMs.get(mint) ?? 0;
  if (nowMs - prevAttempt < cfg.fastPathMinGapMs) return null;

  const streamDd = streamDrawdownPct(mint, cfg.cooldownBounceLookbackMs, nowMs);
  const streamInMain = inDipBand(streamDd, cfg.entry.minDipPct, cfg.entry.maxDipPct);

  // Stream trigger without local drawdown: still Dex-probe (throttled).
  // Previously we returned null without cache → only leader seeds discovered
  // Dex-printed dumps (Agmu8X −18% bought 31s after 8zkg).
  if (trigger === 'stream' && !streamInMain) {
    const cached = getStructuralCache(mint, nowMs, cfg.fastPathStructuralCacheMs);
    if (!cached) {
      if (!cfg.fastPathHotDexProbeEnabled) return null;
      if (
        !allowHotDexProbe(
          mint,
          nowMs,
          cfg.fastPathHotDexProbeGapMs,
          cfg.fastPathHotDexProbeMaxPerMin,
        )
      ) {
        return null;
      }
    }
  }

  // Need Dex for structural (and for Dex/h1 timing when stream not yet in band).
  const struct = await loadStructural(mint, cfg, nowMs);
  if (!struct || !structuralOk(struct.metrics, cfg)) {
    return null;
  }

  const dexPc = struct.metrics.priceChange5mPct;
  const dexInMain = inDipBand(dexPc, cfg.entry.minDipPct, cfg.entry.maxDipPct);

  // Deep knife band — leave to knife-stabilize wait path (not instant blade catch).
  const deepKnife =
    (streamDd != null &&
      streamDd > cfg.knifeStabilizeMinDipPct &&
      streamDd <= cfg.knifeStabilizeMaxDipPct) ||
    (dexPc != null &&
      dexPc > cfg.knifeStabilizeMinDipPct &&
      dexPc <= cfg.knifeStabilizeMaxDipPct);
  if (cfg.knifeStabilizeEnabled && deepKnife && !streamInMain && !dexInMain) {
    return null;
  }

  let dipSource: MildDipCandidate['dipSource'] | null = null;
  let priceUsd = struct.priceUsd;
  let metrics = { ...struct.metrics };

  if (streamInMain && dexInMain) {
    dipSource = 'dex+stream';
    // Prefer deeper (more negative) for journaling.
    const dip = Math.min(streamDd!, dexPc!);
    metrics = { ...metrics, priceChange5mPct: dip };
    const last = mildDipPriceRing.lastPrice(mint, nowMs);
    if (last && last.priceUsd > 0) priceUsd = last.priceUsd;
  } else if (streamInMain && cfg.streamDipEntryEnabled) {
    // Stream-only: require a real dump, not a −5% ring wiggle (Gs2Liw-class).
    if (streamDd == null || !(streamDd <= cfg.streamOnlyMaxDipPct)) {
      /* fall through — maybe Dex / h1 / flat_micro still qualify */
    } else {
      dipSource = 'stream';
      metrics = { ...metrics, priceChange5mPct: streamDd };
      const last = mildDipPriceRing.lastPrice(mint, nowMs);
      if (last && last.priceUsd > 0) priceUsd = last.priceUsd;
    }
  }
  if (!dipSource && dexInMain) {
    dipSource = 'dex';
  }
  if (
    !dipSource &&
    cfg.h1RedShallowEnabled &&
    metrics.priceChange1hPct != null &&
    metrics.priceChange1hPct <= cfg.h1RedShallowH1MaxPct &&
    inDipBand(dexPc, cfg.h1RedShallowMinDipPct, cfg.h1RedShallowMaxDipPct)
  ) {
    dipSource = 'h1_red_shallow';
  }
  if (!dipSource && cfg.flatMicroDipEnabled) {
    const streamInFlat = inDipBand(streamDd, cfg.flatMicroMinDipPct, cfg.flatMicroMaxDipPct);
    const dexInFlat = inDipBand(dexPc, cfg.flatMicroMinDipPct, cfg.flatMicroMaxDipPct);
    const flatDip = dexInFlat ? dexPc : streamInFlat ? streamDd : dexPc;
    const flatOk = evaluateFlatMicroDip({
      priceChange5mPct: flatDip,
      priceChange1hPct: metrics.priceChange1hPct,
      minDipPct: cfg.flatMicroMinDipPct,
      maxDipPct: cfg.flatMicroMaxDipPct,
      h1MinPct: cfg.flatMicroH1MinPct,
      h1MaxPct: cfg.flatMicroH1MaxPct,
    }).pass;
    if (flatOk) {
      dipSource = 'flat_micro_dip';
      if (streamInFlat && !dexInFlat && streamDd != null) {
        metrics = { ...metrics, priceChange5mPct: streamDd };
        const last = mildDipPriceRing.lastPrice(mint, nowMs);
        if (last && last.priceUsd > 0) priceUsd = last.priceUsd;
      }
    }
  }

  let mildDumpPct: number | null = null;
  let mildBouncePct: number | null = null;
  let mildTrough: number | null = null;
  let mildTroughAtMs: number | null = null;
  if (
    mildStabilizeLaneAllowed({
      enabled: cfg.mildStabilizeEnabled,
      freshEntryEnabled: cfg.mildStabilizeFreshEntryEnabled,
      hasOtherDipSource: Boolean(dipSource),
    })
  ) {
    const mild = evaluateMildStabilizeFromRing(mildDipPriceRing, mint, nowMs, {
      enabled: true,
      minDumpPct: cfg.mildStabilizeMinDumpPct,
      maxDumpPct: cfg.mildStabilizeMaxDumpPct,
      minBouncePct: cfg.mildStabilizeMinBouncePct,
      maxBouncePct: cfg.mildStabilizeMaxBouncePct,
      troughMinAgeMs: cfg.mildStabilizeTroughMinAgeMs,
      lookbackMs: cfg.cooldownBounceLookbackMs,
      minBelowPeakPct: cfg.mildStabilizeMinBelowPeakPct,
    });
    if (mild.pass) {
      dipSource = 'mild_stabilize';
      mildDumpPct = mild.dumpPct;
      mildBouncePct = mild.bouncePct;
      mildTrough = mild.troughPriceUsd;
      mildTroughAtMs = mild.troughAtMs;
      if (mild.lastPriceUsd != null && mild.lastPriceUsd > 0) priceUsd = mild.lastPriceUsd;
      if (mild.dumpPct != null) {
        metrics = { ...metrics, priceChange5mPct: mild.dumpPct };
      }
    }
  }

  if (!dipSource) return null;

  // Leader/stream triggers: require a real dip print (not green chase).
  if (trigger === 'leader' || trigger === 'stream') {
    if (
      dipSource === 'h1_red_shallow' ||
      dipSource === 'flat_micro_dip' ||
      dipSource === 'mild_stabilize'
    ) {
      /* ok — shallow / bounce-confirm */
    } else if (!streamInMain && !dexInMain) {
      return null;
    }
  }

  lastFastAttemptMs.set(mint, nowMs);
  return {
    mint,
    symbol: mint.slice(0, 6),
    priceUsd,
    metrics,
    dipSource,
    ...(dipSource === 'mild_stabilize'
      ? {
          mildStabilizeDumpPct: mildDumpPct,
          mildStabilizeBouncePct: mildBouncePct,
          mildStabilizeTroughPriceUsd: mildTrough,
          mildStabilizeTroughAtMs: mildTroughAtMs,
        }
      : {}),
  };
}

export function fastPathChasePct(cfg: MildDipConfig): number {
  return Math.max(cfg.maxChasePct, cfg.fastPathChasePct);
}
