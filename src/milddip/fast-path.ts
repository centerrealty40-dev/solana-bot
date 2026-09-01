/**
 * Fast entry lane — stream / leader triggered.
 *
 * Avoids the slow Dex enrich batch (80 mints behind 120 RPM). One Dex fetch
 * (or cache hit) for structural gates + stream drawdown for timing.
 */
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import { evaluateGreenLane } from './green-lane.js';
import { greenLaneGatesFrom } from './green-would-buy.js';
import { requestGreenMinuteJupiterRefresh } from './green-minute-jupiter-refresh.js';
import {
  confirmedTroughGatePasses,
  evaluateConfirmedTrough,
} from './confirmed-trough.js';
import type { MildDipConfig } from './config.js';
import type { MildDipCandidate } from './discover.js';
import {
  evaluateFlatMicroDip,
  evaluateMildDipImpulseEntry,
  type MildDipCandidateMetrics,
} from './gates.js';
import {
  evaluateMildStabilizeFromRing,
  mildStabilizeDexDipOk,
  mildStabilizeLaneAllowed,
  mildStabilizeSkipTelemetryEligible,
  takeMildStabilizeSkipTelemetrySlot,
} from './mild-stabilize.js';
import { mildDipPriceRing } from './price-ring.js';
import { mildDipPairAgeRegistry } from './pair-age-registry.js';
import type { LeaderSeedHit } from './discover-extra.js';
import { isLeaderFreshCoBuy } from './discover-extra.js';
import { appendMildDipJournal } from './state.js';
import { leaderActiveNow } from './leader-active.js';
import {
  fetchMildDipStructuralFallback,
  type StructuralFallbackSnapshot,
} from './structural-fallback.js';
import {
  evaluateTurnDumpGate,
  metricsHotDeepDumpOk,
  turnDumpKnifeBranchLive,
} from './turn-dump.js';

export { effectiveRunnerTapeCap } from './green-would-buy.js';

function turnDumpArgsFromCfg(
  cfg: MildDipConfig,
  pc5m: number | null | undefined,
  metrics: MildDipCandidateMetrics,
  hotDeepKnifeSeat = false,
) {
  return {
    enabled: true as const,
    pc5m,
    volume5mUsd: metrics.volume5mUsd,
    liquidityUsd: metrics.liquidityUsd,
    alpha: cfg.turnDumpAlpha,
    beta: cfg.turnDumpBeta,
    shallowSlackPct: cfg.turnDumpShallowSlackPct,
    deepSlackPct: cfg.turnDumpDeepSlackPct,
    shallowBranchEnabled: cfg.turnDumpShallowBranchEnabled,
    shallowAlpha: cfg.turnDumpShallowAlpha,
    shallowBeta: cfg.turnDumpShallowBeta,
    shallowBandPct: cfg.turnDumpShallowBandPct,
    knifeBranchEnabled: turnDumpKnifeBranchLive(cfg.turnDumpKnifeBranchEnabled, {
      hotDeepKnifeSeat,
    }),
    knifeMinDumpPct: cfg.turnDumpKnifeMinDumpPct,
    knifeMinTurn: cfg.turnDumpKnifeMinTurn,
  };
}

/** Fresh enough observer Dex to skip a second DexScreener round-trip. */
const LEADER_SEED_DEX_MAX_AGE_MS = 120_000;

function structuralFromLeaderSeed(
  hit: LeaderSeedHit,
  nowMs: number,
): StructuralCacheEntry | null {
  if (nowMs - hit.lastSeenAtMs > LEADER_SEED_DEX_MAX_AGE_MS) return null;
  if (hit.ageHours != null) {
    mildDipPairAgeRegistry.notePairAgeHours(hit.mint, hit.ageHours, hit.lastSeenAtMs);
  }
  const priceUsd = hit.priceUsd;
  const vol = hit.vol5m;
  const liq = hit.liq;
  const mcap = hit.mcap;
  if (
    priceUsd == null ||
    !(priceUsd > 0) ||
    vol == null ||
    liq == null ||
    mcap == null
  ) {
    return null;
  }
  return {
    fetchedAtMs: hit.lastSeenAtMs,
    source: 'leader_seed',
    priceUsd,
    metrics: {
      priceChange5mPct: hit.pc5m ?? null,
      priceChange1hPct: hit.pc1h ?? null,
      volume5mUsd: vol,
      liquidityUsd: liq,
      marketCapUsd: mcap,
      pairAgeHours: hit.ageHours ?? null,
      dexId: hit.dexId ?? null,
      buys5m: null,
      sells5m: null,
      volume1hUsd: null,
    },
  };
}

export type StructuralCacheEntry = {
  fetchedAtMs: number;
  priceUsd: number;
  metrics: MildDipCandidateMetrics;
  source: 'leader_seed' | 'dex' | 'gecko';
};

const structuralCache = new Map<string, StructuralCacheEntry>();
const lastFastAttemptMs = new Map<string, number>();
/** Per-mint throttle for Dex probes when stream drawdown is not yet in band. */
const lastHotDexProbeMs = new Map<string, number>();
/** Rate-limit leader fast-path skip journals (wake is every 2s). */
const lastLeaderSkipJournalMs = new Map<string, number>();
/** Rate-limit failed GREEN verdict journals to one event per mint/minute. */
const lastGreenSkipJournalMs = new Map<string, number>();
/** Rate-limit enriched leader-seen skip journals to one event per mint/minute. */
const lastLeaderSeenSkipJournalMs = new Map<string, number>();
/** Rate-limit explicit GREEN leader-gate bypass journals by write site. */
const lastGreenLeaderBypassJournalMs = new Map<string, number>();
let hotDexProbeWindowStartMs = 0;
let hotDexProbeCount = 0;

export function shouldJournalGreenVerdict(mint: string, nowMs: number): boolean {
  const previous = lastGreenSkipJournalMs.get(mint);
  if (previous != null && nowMs - previous < 60_000) return false;
  lastGreenSkipJournalMs.set(mint, nowMs);
  return true;
}

export type LeaderSeenSkipJournalSite = 'entry' | 'fastpath_first_touch' | 'fastpath';

export function shouldJournalLeaderSeenSkip(
  mint: string,
  site: LeaderSeenSkipJournalSite,
  nowMs: number,
): boolean {
  const key = `${mint}:${site}`;
  const previous = lastLeaderSeenSkipJournalMs.get(key);
  if (previous != null && nowMs - previous < 60_000) return false;
  lastLeaderSeenSkipJournalMs.set(key, nowMs);
  return true;
}

export function shouldJournalGreenLeaderSeenBypass(
  mint: string,
  site: LeaderSeenSkipJournalSite,
  nowMs: number,
): boolean {
  const key = `${mint}:${site}`;
  const previous = lastGreenLeaderBypassJournalMs.get(key);
  if (previous != null && nowMs - previous < 60_000) return false;
  lastGreenLeaderBypassJournalMs.set(key, nowMs);
  return true;
}

export function streamObservabilitySnapshot(
  mint: string,
  lookbackMs: number,
  nowMs: number,
  pairAgeHours?: number | null,
  tapeOptions?: Parameters<typeof mildDipPriceRing.tapeMinuteMetrics>[5],
): Record<string, unknown> {
  const stream = mildDipPriceRing.streamWindowMetrics(mint, lookbackMs, nowMs);
  const tape = mildDipPriceRing.tapeMinuteMetrics(
    mint,
    nowMs,
    60_000,
    360_000,
    180_000,
    tapeOptions,
  );
  return {
    streamPriceUsd: stream.freshPriceUsd,
    streamBounceFromTroughPct: stream.bounceFromTroughPct,
    streamRallyIntoPeakPct: stream.rallyIntoPeakPct,
    streamDumpExtentFromPeakPct: stream.dumpExtentFromPeakPct,
    streamSampleCount: stream.sampleCount,
    streamOldestSampleAgeMs: stream.oldestSampleAgeMs,
    tapeRet1mPct: tape.tapeRet1mPct,
    tapePrior5mPct: tape.tapePrior5mPct,
    tapeSampleCount: tape.sampleCount,
    tapeCoverageMs: tape.coverageMs,
    tapeLatestSampleAgeMs: tape.latestSampleAgeMs,
    tapeMinuteFailureReason: tape.failureReason,
    pairAgeHours:
      pairAgeHours ?? mildDipPairAgeRegistry.pairAgeHours(mint, nowMs),
  };
}

export function greenTapeMinuteOptions(
  cfg: MildDipConfig,
): Parameters<typeof mildDipPriceRing.tapeMinuteMetrics>[5] {
  return cfg.green.tapeMinuteStrictFreshnessEnabled
    ? {
        strictFreshness: true,
        minRecentSamples: cfg.green.tapeMinuteMinRecentSamples,
        latestMaxAgeMs: cfg.green.tapeMinuteLatestMaxAgeMs,
        boundaryMinAgeMs: cfg.green.tapeMinuteBoundaryMinAgeMs,
        boundaryMaxAgeMs: cfg.green.tapeMinuteBoundaryMaxAgeMs,
        priorAnchorMinAgeMs: cfg.green.tapeMinutePriorAnchorMinAgeMs,
        priorAnchorMaxAgeMs: cfg.green.tapeMinutePriorAnchorMaxAgeMs,
        anchorMedianMs: cfg.green.tapeMinuteAnchorMedianMs,
      }
    : { strictFreshness: false, anchorMedianMs: cfg.green.tapeMinuteAnchorMedianMs };
}

/** Test helper. */
export function resetFastPathStateForTests(): void {
  structuralCache.clear();
  lastFastAttemptMs.clear();
  lastHotDexProbeMs.clear();
  lastLeaderSkipJournalMs.clear();
  lastGreenSkipJournalMs.clear();
  lastLeaderSeenSkipJournalMs.clear();
  lastGreenLeaderBypassJournalMs.clear();
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
  source: StructuralCacheEntry['source'] = 'dex',
): void {
  if (!mint || !(priceUsd > 0)) return;
  structuralCache.set(mint, { fetchedAtMs, priceUsd, metrics, source });
}

export function invalidateStructuralCache(mint: string): void {
  structuralCache.delete(mint);
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

/** Current mark vs swing peak (last/peak). Pump wick looks like a tiny dump here. */
export function streamDrawdownPct(
  mint: string,
  lookbackMs: number,
  nowMs: number,
): number | null {
  const dd = mildDipPriceRing.drawdownFromPeakPct(mint, lookbackMs, nowMs);
  return dd != null && Number.isFinite(dd) ? dd : null;
}

/** True dump: peak → post-peak trough. */
export function streamDumpExtentPct(
  mint: string,
  lookbackMs: number,
  nowMs: number,
): number | null {
  const dd = mildDipPriceRing.dumpExtentFromPeakPct(mint, lookbackMs, nowMs);
  return dd != null && Number.isFinite(dd) ? dd : null;
}

/**
 * Reject micro-wicks after a pump: |dump| must cover ≥ frac of the rally into peak.
 * Off when minRallyPct or minDumpFracOfRally is 0.
 */
export function dumpRallyGateOk(args: {
  dumpExtentPct: number | null | undefined;
  rallyIntoPeakPct: number | null | undefined;
  minRallyPct: number;
  minDumpFracOfRally: number;
}): boolean {
  if (!(args.minRallyPct > 0) || !(args.minDumpFracOfRally > 0)) return true;
  const dump = args.dumpExtentPct;
  if (dump == null || !Number.isFinite(dump)) return false;
  const rally = args.rallyIntoPeakPct;
  if (rally == null || !Number.isFinite(rally) || rally < args.minRallyPct) return true;
  return Math.abs(dump) + 1e-9 >= rally * args.minDumpFracOfRally;
}

/**
 * 1.11.801 — D2zNEW / 3XeNADY: H1 +46%, peak 30 → buy 27 (−10%).
 * Ring rally gate can miss when samples start mid-pump; Dex H1 still shows the pump.
 * When pc1h ≥ h1PumpMinPct, dump must be ≤ minDumpPct (e.g. −15). 0 h1 = off.
 */
export function dumpH1PumpGateOk(args: {
  priceChange1hPct: number | null | undefined;
  dumpExtentPct: number | null | undefined;
  /** Dex pc5m (or deepest) when ring dump extent is thin/missing. */
  fallbackDumpPct?: number | null | undefined;
  h1PumpMinPct: number;
  minDumpPct: number;
}): boolean {
  if (!(args.h1PumpMinPct > 0) || !(args.minDumpPct < 0)) return true;
  const h1 = args.priceChange1hPct;
  if (h1 == null || !Number.isFinite(h1) || h1 < args.h1PumpMinPct) return true;
  const dump =
    args.dumpExtentPct != null && Number.isFinite(args.dumpExtentPct)
      ? args.dumpExtentPct
      : args.fallbackDumpPct != null && Number.isFinite(args.fallbackDumpPct)
        ? args.fallbackDumpPct
        : null;
  if (dump == null || !Number.isFinite(dump)) return false;
  return dump <= args.minDumpPct + 1e-9;
}

/**
 * Stream qualifies as a real dip in band:
 * dump extent + current drawdown both in (min,max], and not a pump-wick.
 */
export function streamDipInBandOk(args: {
  dumpExtentPct: number | null;
  currentDrawdownPct: number | null;
  rallyIntoPeakPct: number | null;
  minDipPct: number;
  maxDipPct: number;
  dumpRallyGateMinPct: number;
  dumpRallyMinFrac: number;
}): boolean {
  if (!inDipBand(args.dumpExtentPct, args.minDipPct, args.maxDipPct)) return false;
  if (!inDipBand(args.currentDrawdownPct, args.minDipPct, args.maxDipPct)) return false;
  return dumpRallyGateOk({
    dumpExtentPct: args.dumpExtentPct,
    rallyIntoPeakPct: args.rallyIntoPeakPct,
    minRallyPct: args.dumpRallyGateMinPct,
    minDumpFracOfRally: args.dumpRallyMinFrac,
  });
}

export function inDipBand(
  dipPct: number | null | undefined,
  minDipPct: number,
  maxDipPct: number,
): boolean {
  return dipPct != null && Number.isFinite(dipPct) && dipPct > minDipPct && dipPct <= maxDipPct;
}

/**
 * Stream-only Dex confirm.
 * - requireDexDip: Dex must print ≤ dexMaxDipPct (classic).
 * - allowMissingDex: null Dex OK (API lag) when require on.
 * - blockDexGreen: Dex > 0 always fails (reclaim), even if require off.
 */
export function streamOnlyDexDipOk(args: {
  requireDexDip: boolean;
  dexPc5m: number | null | undefined;
  dexMaxDipPct: number;
  allowMissingDex?: boolean;
  blockDexGreen?: boolean;
}): boolean {
  const d = args.dexPc5m;
  if (args.blockDexGreen !== false && d != null && Number.isFinite(d) && d > 0) {
    return false;
  }
  if (!args.requireDexDip) return true;
  if (d == null || !Number.isFinite(d)) return args.allowMissingDex === true;
  return d <= args.dexMaxDipPct;
}

/**
 * 1.11.779 — when Dex has not confirmed the dump yet, still allow stream-only
 * if the ring is near the trough (not a post-reclaim phantom).
 * JBKWfC: ring −21% after reclaim → large bounce off trough → reject.
 * Early dump: Dex flat/lagging, price still at lows → allow (beat leader-seed).
 */
export function streamOnlyNearTroughOk(args: {
  enabled: boolean;
  bounceFromTroughPct: number | null | undefined;
  maxBouncePct: number;
  sampleCount: number;
  minSamples: number;
}): boolean {
  if (!args.enabled) return false;
  if (args.sampleCount < Math.max(1, args.minSamples)) return false;
  const b = args.bounceFromTroughPct;
  if (b == null || !Number.isFinite(b)) return false;
  return b <= Math.max(0, args.maxBouncePct);
}

export type KnifeStreamGuardReasonCode =
  | 'dex_green_vetoes_stream_knife'
  | 'knife_stream_divergence'
  | 'knife_dex_unknown_stream_untrusted';

export type KnifeStreamGuardDetail =
  | {
      code: 'dex_green_vetoes_stream_knife';
      streamDd: number;
      dexPc: number;
      greenMinPc5m: number;
    }
  | {
      code: 'knife_stream_divergence';
      streamDd: number;
      dexPc: number;
      divergencePp: number;
      maxPp: number;
    }
  | {
      code: 'knife_dex_unknown_stream_untrusted';
      streamDd: number;
    };

export type KnifeStreamGuardResult = {
  streamPc5mForKnife: number | null;
  blocked: boolean;
  reasons: KnifeStreamGuardReasonCode[];
  details: KnifeStreamGuardDetail[];
};

/**
 * Keep a malformed stream ring out of the knife/turn-dump branch.
 *
 * A green Dex print vetoes stream-derived knife evidence when enabled. A
 * stream print that is materially deeper than Dex is treated as corrupted and
 * blocks knife entirely; other entry sources remain independent of this guard.
 */
export function evaluateKnifeStreamGuard(args: {
  streamDd: number | null | undefined;
  dexPc: number | null | undefined;
  dexGreenVeto: boolean;
  dexGreenMinPc5m?: number;
  maxDivergencePp: number;
}): KnifeStreamGuardResult {
  const stream = args.streamDd != null && Number.isFinite(args.streamDd) ? args.streamDd : null;
  const dex = args.dexPc != null && Number.isFinite(args.dexPc) ? args.dexPc : null;
  if (stream == null) {
    return { streamPc5mForKnife: stream, blocked: false, reasons: [], details: [] };
  }
  if (dex == null) {
    return {
      streamPc5mForKnife: null,
      blocked: true,
      reasons: ['knife_dex_unknown_stream_untrusted'],
      details: [{ code: 'knife_dex_unknown_stream_untrusted', streamDd: stream }],
    };
  }

  const reasons: KnifeStreamGuardReasonCode[] = [];
  const details: KnifeStreamGuardDetail[] = [];
  const greenMin = args.dexGreenMinPc5m ?? 0;
  if (args.dexGreenVeto && dex >= greenMin) {
    reasons.push('dex_green_vetoes_stream_knife');
    details.push({
      code: 'dex_green_vetoes_stream_knife',
      streamDd: stream,
      dexPc: dex,
      greenMinPc5m: greenMin,
    });
  }

  const divergencePp = dex - stream;
  if (args.maxDivergencePp >= 0 && divergencePp > args.maxDivergencePp) {
    reasons.push('knife_stream_divergence');
    details.push({
      code: 'knife_stream_divergence',
      streamDd: stream,
      dexPc: dex,
      divergencePp,
      maxPp: args.maxDivergencePp,
    });
  }

  return {
    streamPc5mForKnife: reasons.length > 0 ? null : stream,
    blocked: reasons.length > 0,
    reasons,
    details,
  };
}

/**
 * Exported for unit tests — structural floors on fast-path candidates.
 *
 * `leaderSeen` lowers the age floor to `minPairAgeHoursLeaderSeen`. The floor
 * exists because a young pair is usually unformed, but a name two leaders are
 * actively buying is evidence about that specific pair which the clock does not
 * carry. 4CmYEyg is the case: they traded it 26 times while it sat behind our 6h
 * floor, and by the time it cleared, the phase they had traded was over.
 */
export function structuralOk(
  metrics: MildDipCandidateMetrics,
  cfg: MildDipConfig,
  leaderSeen = false,
  /** Fresh leader co-buy only — relaxes turn/vol ceilings, not age. */
  leaderFreshBuy = false,
  /** Stream/Dex hot deep dump (dump≥knifeMin & turn≥knifeMin) — same relax, no leader. */
  hotDeepDump = false,
): boolean {
  const g = cfg.entry;
  const minAge =
    leaderSeen && g.minPairAgeHoursLeaderSeen > 0
      ? Math.min(g.minPairAgeHoursLeaderSeen, g.minPairAgeHours)
      : g.minPairAgeHours;
  /**
   * Turnover/vol ceilings relax on fresh leader co-buy OR on our own hot-blade
   * signal (dump≥30 & turn≥0.3). The latter is how we compete on the same
   * proлив as 7BNax without waiting for his buy.
   */
  const relaxTurnVol = leaderFreshBuy || hotDeepDump;
  const maxTurn = relaxTurnVol ? 0 : g.maxTurnover5mLiq;
  const minTurn = relaxTurnVol ? 0 : g.minTurnover5mLiq;
  const maxVol = relaxTurnVol ? 0 : g.maxVolume5mUsd;
  if (metrics.volume5mUsd == null || !(metrics.volume5mUsd >= g.minVolume5mUsd)) return false;
  if (maxVol > 0 && metrics.volume5mUsd > maxVol) return false;
  if (metrics.liquidityUsd == null || !(metrics.liquidityUsd >= g.minLiquidityUsd)) return false;
  if (metrics.marketCapUsd == null || !(metrics.marketCapUsd >= g.minMarketCapUsd)) return false;
  if (metrics.marketCapUsd > g.maxMarketCapUsd) return false;
  if (metrics.pairAgeHours == null || metrics.pairAgeHours < minAge) return false;
  if (
    (minTurn > 0 || maxTurn > 0) &&
    metrics.volume5mUsd != null &&
    metrics.liquidityUsd != null &&
    metrics.liquidityUsd > 0
  ) {
    const turn = metrics.volume5mUsd / metrics.liquidityUsd;
    if (minTurn > 0 && turn < minTurn) return false;
    if (maxTurn > 0 && turn > maxTurn) return false;
  }
  if (g.maxPairAgeHours > 0 && metrics.pairAgeHours > g.maxPairAgeHours) return false;
  if (g.allowedDexIds.length > 0) {
    const dex = (metrics.dexId ?? '').toLowerCase();
    if (!dex || !g.allowedDexIds.includes(dex)) return false;
  }
  return true;
}

/** Turnover floor unless a leader is actively co-buying this dip. */
export function leaderCoBuyAlignOk(
  cfg: MildDipConfig,
  metrics: MildDipCandidateMetrics,
  args: {
    nowMs: number;
    trigger: 'stream' | 'leader' | 'scan';
    seedHit?: LeaderSeedHit | null;
    leaderSeenAtMs?: number | null;
  },
): { ok: boolean; turn: number | null; leaderFresh: boolean } {
  if (!cfg.leaderCoBuyAlignEnabled || !(cfg.leaderCoBuyAlignMinTurn > 0)) {
    return { ok: true, turn: null, leaderFresh: false };
  }
  const v5 = metrics.volume5mUsd;
  const liq = metrics.liquidityUsd;
  const turn =
    v5 != null && liq != null && liq > 0 && Number.isFinite(v5) ? v5 / liq : null;
  const leaderFresh = isLeaderFreshCoBuy({
    nowMs: args.nowMs,
    maxAgeMs: cfg.leaderCoBuyAlignMaxMs,
    trigger: args.trigger,
    seedHit: args.seedHit,
    leaderSeenAtMs: args.leaderSeenAtMs,
  });
  if (turn != null && turn < cfg.leaderCoBuyAlignMinTurn && !leaderFresh) {
    return { ok: false, turn, leaderFresh };
  }
  return { ok: true, turn, leaderFresh };
}

export function leaderTrustStructuralOk(args: {
  nowMs: number;
  leaderCoBuyAlignMaxMs: number;
  entryLeaderTrustStructuralMs: number;
  leaderFreshBuy: boolean;
  trigger: 'stream' | 'leader' | 'scan';
  seedHit?: LeaderSeedHit | null;
  leaderSeenAtMs?: number | null;
}): boolean {
  const trustWindowMs =
    args.entryLeaderTrustStructuralMs > 0
      ? args.entryLeaderTrustStructuralMs
      : args.leaderCoBuyAlignMaxMs;
  return (
    args.leaderFreshBuy ||
    (args.trigger === 'leader' && args.seedHit != null) ||
    (args.seedHit != null && args.nowMs - args.seedHit.lastSeenAtMs <= trustWindowMs) ||
    (args.leaderSeenAtMs != null && args.nowMs - args.leaderSeenAtMs <= trustWindowMs)
  );
}

/**
 * Stale structural reuse when live Dex blips null (not Enrich — same snapshot).
 * Window is configurable because `structural_fetch_null` accounted for 27% of all
 * fast-path skips (25_222 of 93_529): DexScreener is rate limited on this host and
 * a 30s ceiling threw away snapshots whose fields barely move.
 */
const STRUCTURAL_STALE_FALLBACK_MS = 30_000;
const STRUCTURAL_FETCH_RETRIES = 2;
const STRUCTURAL_RETRY_GAP_MS = 80;

export function structuralFromDexDetails(
  mint: string,
  details: NonNullable<Awaited<ReturnType<typeof fetchDexScreenerPairDetails>>>,
  nowMs: number,
  opts?: { notePriceRing?: boolean },
): StructuralCacheEntry {
  if (opts?.notePriceRing !== false) {
    mildDipPriceRing.note(mint, details.priceUsd!, { tsMs: nowMs, source: 'dex' });
  }
  const pairAgeHours =
    details.pairCreatedAtMs != null && details.pairCreatedAtMs > 0
      ? Math.max(0, (nowMs - details.pairCreatedAtMs) / 3_600_000)
      : null;
  if (details.pairCreatedAtMs != null) {
    mildDipPairAgeRegistry.notePairCreatedAt(mint, details.pairCreatedAtMs, nowMs);
  }
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
  const entry: StructuralCacheEntry = {
    fetchedAtMs: nowMs,
    priceUsd: details.priceUsd!,
    metrics,
    source: 'dex',
  };
  noteStructuralCache(mint, entry.priceUsd, metrics, nowMs, 'dex');
  return entry;
}

/**
 * Dex structural load: fresh cache → fetch with 1 retry → stale cache → Gecko fallback.
 * One null blip must not kill a TD-eligible mint (`structural_fetch_null` spam).
 */
export type StructuralLoadDeps = {
  fetchDex?: typeof fetchDexScreenerPairDetails;
  fetchFallback?: (
    mint: string,
    cfg: MildDipConfig,
    nowMs: number,
  ) => Promise<StructuralFallbackSnapshot | null>;
};

export async function loadStructural(
  mint: string,
  cfg: MildDipConfig,
  nowMs: number,
  allowFallback = false,
  deps?: StructuralLoadDeps,
): Promise<StructuralCacheEntry | null> {
  const freshMs = cfg.fastPathStructuralCacheMs;
  const cached = getStructuralCache(mint, nowMs, freshMs);
  if (cached) return cached;

  const fetchDex = deps?.fetchDex ?? fetchDexScreenerPairDetails;
  for (let attempt = 0; attempt < STRUCTURAL_FETCH_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, STRUCTURAL_RETRY_GAP_MS));
    }
    const details = await fetchDex(mint, {
      nowMs,
      bypassCache: attempt > 0,
      cacheTtlMs: Math.min(5_000, freshMs),
      allowedDexIds: cfg.entry.allowedDexIds,
    });
    if (details && details.priceUsd != null && details.priceUsd > 0) {
      return structuralFromDexDetails(mint, details, nowMs);
    }
  }

  const staleMs =
    cfg.fastPathStructuralStaleMs > 0
      ? cfg.fastPathStructuralStaleMs
      : STRUCTURAL_STALE_FALLBACK_MS;
  const stale = getStructuralCache(mint, nowMs, staleMs);
  if (stale) return stale;
  if (allowFallback && cfg.structuralFallbackEnabled) {
    const fetchFallback = deps?.fetchFallback ?? fetchMildDipStructuralFallback;
    const snapshot = await fetchFallback(mint, cfg, nowMs);
    if (snapshot) {
      const metrics: MildDipCandidateMetrics = {
        priceChange5mPct: snapshot.priceChange5mPct,
        priceChange1hPct: snapshot.priceChange1hPct,
        volume5mUsd: snapshot.volume5mUsd,
        liquidityUsd: snapshot.liquidityUsd,
        marketCapUsd: null,
        pairAgeHours: snapshot.pairAgeHours,
        dexId: snapshot.dexId,
        buys5m: snapshot.buys5m,
        sells5m: snapshot.sells5m,
        volume1hUsd: snapshot.volume1hUsd,
      };
      const entry: StructuralCacheEntry = {
        fetchedAtMs: nowMs,
        priceUsd: snapshot.priceUsd,
        metrics,
        source: 'gecko',
      };
      noteStructuralCache(mint, entry.priceUsd, metrics, nowMs, 'gecko');
      return entry;
    }
  }
  return null;
}

/**
 * Stream ring required for stream-timed sources; Dex/TD formula paths may enter
 * on Dex alone.
 *
 * 1.11.807 — `wait_dip` is exempt too. A parked seat is priced against its own
 * signal anchor (ceiling + chase caps), so demanding a stream print on top just
 * killed it: 886 `no_stream_price` rejects in 15m, one seat burning 363 ready
 * ticks before expiring.
 */
export function requireStreamPriceForDipSource(
  dipSource: MildDipCandidate['dipSource'] | null | undefined,
): boolean {
  if (dipSource == null) return true;
  return (
    dipSource !== 'dex' &&
    dipSource !== 'dex+stream' &&
    dipSource !== 'turn_dump_knife' &&
    dipSource !== 'wait_dip' &&
    // Green and leader mirror are decided from Dex/Jupiter snapshots; stream adds nothing.
    dipSource !== 'green_momentum' &&
    dipSource !== 'leader_mirror'
  );
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
  seedHit?: LeaderSeedHit | null,
  /**
   * 1.11.914 — when a leader last traded this mint (from state memory). Used for
   * age-floor relax and, when fresh, turnover co-buy align.
   */
  leaderSeenAtMs?: number | null,
  greenOnly = false,
  shadow?: {
    onSkip: (reason: string, details?: Record<string, unknown>) => void;
  },
): Promise<MildDipCandidate | null> {
  const skipContext: Record<string, unknown> = {};
  const skip = (reason: string, extra?: Record<string, unknown>): null => {
    const details = { ...skipContext, ...extra };
    shadow?.onSkip(reason, details);
    // Leave a trail for leader + stream wakes (silent null hid stream misses).
    // Throttle: wake ticks every 2s; journal at most every 15s per mint.
    if ((trigger === 'leader' || trigger === 'stream') && reason !== 'min_gap') {
      const prevJ = lastLeaderSkipJournalMs.get(mint) ?? 0;
      if (nowMs - prevJ >= 15_000) {
        lastLeaderSkipJournalMs.set(mint, nowMs);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_fast_path_skip',
          mint,
          lane: 'fast',
          trigger,
          reason,
          ...details,
        });
      }
    }
    return null;
  };
  const shadowSkip = (reason: string, extra?: Record<string, unknown>): null => {
    shadow?.onSkip(reason, { ...skipContext, ...extra });
    return null;
  };

  if (!cfg.fastPathEnabled) return skip('fast_path_off');
  if (!mint || mint.length < 32) return skip('bad_mint');
  if (cfg.deniedMints.includes(mint)) return skip('denied_mint');

  // 1.11.802 — do NOT hard-block here on stream ring. Dex/TD entries may
  // proceed without a stream print; stream-timed sources still checked below.

  const prevAttempt = lastFastAttemptMs.get(mint) ?? 0;
  if (nowMs - prevAttempt < cfg.fastPathMinGapMs) return shadowSkip('fast_path_min_gap');

  const lookbackMs = cfg.cooldownBounceLookbackMs;
  const streamCurrentDd = streamDrawdownPct(mint, lookbackMs, nowMs);
  const streamDump = streamDumpExtentPct(mint, lookbackMs, nowMs);
  const streamRally = mildDipPriceRing.rallyIntoPeakPct(mint, lookbackMs, nowMs);
  const streamWindow = mildDipPriceRing.streamWindowMetrics(mint, lookbackMs, nowMs);
  const greenStreamRally = streamWindow.rallyIntoPeakPct;
  const tapeOptions = greenTapeMinuteOptions(cfg);
  // Journal / turn-dump prefer true dump extent; fall back to mark-vs-peak.
  const streamDd = streamDump ?? streamCurrentDd;
  /**
   * 1.11.915 — one flag for "a leader has traded this name", read from our own
   * memory as well as from the wake that found the coin, and applied to every
   * prior that was fitted on names we know nothing else about.
   */
  const leaderSeenName =
    trigger === 'leader' || seedHit != null || leaderSeenAtMs != null;
  const leaderFreshBuy = isLeaderFreshCoBuy({
    nowMs,
    maxAgeMs: cfg.leaderCoBuyAlignMaxMs,
    trigger,
    seedHit: seedHit ?? null,
    leaderSeenAtMs,
  });
  /**
   * The dip ceiling exists because our -4..0 entries were negative in every
   * window. A leader buying at -2% is not that population. Flat is as far as it
   * goes though - green candles stay out, which is what the ceiling was for.
   *
   * CgnQ8a: 36 days old, $52k liquidity, pc5m -2.12, leader in for $496.69.
   */
  const maxDip = leaderSeenName ? Math.max(cfg.entry.maxDipPct, 0) : cfg.entry.maxDipPct;
  const streamInMain = streamDipInBandOk({
    dumpExtentPct: streamDump,
    currentDrawdownPct: streamCurrentDd,
    rallyIntoPeakPct: streamRally,
    minDipPct: cfg.entry.minDipPct,
    maxDipPct: maxDip,
    dumpRallyGateMinPct: cfg.dumpRallyGateMinPct,
    dumpRallyMinFrac: cfg.dumpRallyMinFrac,
  });

  // Stream trigger without local drawdown: still Dex-probe (throttled).
  // Previously we returned null without cache → only leader seeds discovered
  // Dex-printed dumps (Agmu8X −18% bought 31s after 8zkg).
  if (trigger === 'stream' && !streamInMain) {
    const cached = getStructuralCache(mint, nowMs, cfg.fastPathStructuralCacheMs);
    if (!cached) {
      if (!cfg.fastPathHotDexProbeEnabled) return shadowSkip('hot_dex_probe_off');
      if (
        !allowHotDexProbe(
          mint,
          nowMs,
          cfg.fastPathHotDexProbeGapMs,
          cfg.fastPathHotDexProbeMaxPerMin,
        )
      ) {
        return shadowSkip('hot_dex_probe_rate_limited');
      }
    }
  }

  // 1.11.775 — leader wake: prefer observer Dex snapshot (same print he bought on).
  let struct: StructuralCacheEntry | null =
    trigger === 'leader' && seedHit ? structuralFromLeaderSeed(seedHit, nowMs) : null;
  let structSource: 'leader_seed' | 'dex' | 'gecko' = struct?.source ?? 'dex';
  if (!struct) {
    const allowStructuralFallback = trigger === 'leader' || streamInMain;
    struct = await loadStructural(mint, cfg, nowMs, allowStructuralFallback);
    structSource = struct?.source ?? 'dex';
  } else {
    // Keep cache warm for follow-up ticks.
    noteStructuralCache(mint, struct.priceUsd, struct.metrics, nowMs, struct.source);
  }
  if (!struct) return skip('structural_fetch_null', { structSource });
  // Age of the snapshot the decision rests on — lets us check afterwards whether
  // entries taken off a stale snapshot perform worse than fresh ones.
  const structAgeMs = Math.max(0, nowMs - struct.fetchedAtMs);
  skipContext.structSource = structSource;
  skipContext.structAgeMs = structAgeMs;
  /**
   * Green lane, evaluated before the dip floors because it is a different
   * trade with its own floors, its own clip and its own exit. A momentum name
   * is younger and hotter than anything the dip lane wants, so running it
   * through `structuralOk` would reject it on the 6h age floor that was fitted
   * on dip P&L.
   */
  if (cfg.green.enabled) {
    // Dex round-trip above takes seconds; the pre-fetch tape snapshot reads as
    // missing data even when the stream printed meanwhile.
    const greenTapeNowMs = Math.max(nowMs, Date.now());
    const greenTape = mildDipPriceRing.tapeMinuteMetrics(
      mint,
      greenTapeNowMs,
      60_000,
      360_000,
      180_000,
      tapeOptions,
    );
    const greenRunnerRelax = leaderActiveNow({
      gates: {
        enabled: cfg.green.runnerRelaxEnabled,
        windowMs: cfg.green.runnerLeaderActiveMs,
      },
      nowMs,
      leaderSeenAtMs,
      seedHitAtMs: seedHit?.lastSeenAtMs ?? null,
    });
    const greenGates = greenLaneGatesFrom(cfg.green, greenRunnerRelax);
    const dexImpulse =
      struct.metrics.priceChange5mPct != null &&
      struct.metrics.priceChange5mPct >= Math.max(cfg.green.minPc5mPct, 0);
    const streamImpulse =
      greenStreamRally != null &&
      greenStreamRally >= cfg.green.jupiterMinuteStreamImpulsePct;
    const dipShape =
      cfg.green.minDumpFromPeakPct > 0 &&
      streamDump != null &&
      Math.abs(streamDump) >= cfg.green.minDumpFromPeakPct;
    if (dexImpulse || streamImpulse || dipShape) {
      requestGreenMinuteJupiterRefresh({
        mint,
        nowMs,
        snapshotPriceUsd: struct.priceUsd,
        enabled: cfg.green.jupiterMinuteEnabled,
        minGapMs: Math.max(
          cfg.green.jupiterMinuteMinGapMs,
          cfg.green.jupiterMinuteIntervalMs,
        ),
        ttlMs: cfg.green.jupiterMinuteTtlMs,
        maxMints: cfg.green.jupiterMinuteMaxMints,
        maxInFlight: cfg.green.jupiterMinuteMaxInFlight,
        probeUsd: cfg.green.jupiterMinuteProbeUsd,
        slippageBps: cfg.green.jupiterMinuteSlippageBps,
        tokenDecimals: mildDipPriceRing.mintDecimals(mint) ?? undefined,
      });
    }
    const g = evaluateGreenLane(
      {
        pc5mPct: struct.metrics.priceChange5mPct,
        pc1hPct: struct.metrics.priceChange1hPct,
        dumpExtentFromPeakPct: streamWindow.dumpExtentFromPeakPct,
        rallyIntoPeakPct: streamWindow.rallyIntoPeakPct,
        bounceFromTroughPct: streamWindow.bounceFromTroughPct,
        tapeRet1mPct: greenTape.tapeRet1mPct,
        tapePrior5mPct: greenTape.tapePrior5mPct,
        volume5mUsd: struct.metrics.volume5mUsd,
        volume1hUsd: struct.metrics.volume1hUsd,
        liquidityUsd: struct.metrics.liquidityUsd,
        buys5m: struct.metrics.buys5m,
        sells5m: struct.metrics.sells5m,
        pairAgeHours: struct.metrics.pairAgeHours,
      },
      greenGates,
    );
    if (g.pass) {
      return {
        mint,
        symbol: mint.slice(0, 6),
        priceUsd: struct.priceUsd,
        metrics: struct.metrics,
        dipSource: 'green_momentum',
        greenRunnerRelax,
        greenImpulse: g.impulse,
        tapeRet1mPct: greenTape.tapeRet1mPct,
        tapePrior5mPct: greenTape.tapePrior5mPct,
        tapeSampleCount: greenTape.sampleCount,
        tapeCoverageMs: greenTape.coverageMs,
        tapeMinuteFailureReason: greenTape.failureReason,
        structSource,
        structAgeMs,
        streamWindowSampleCount: streamWindow.sampleCount,
        streamCoverageMs: streamWindow.oldestSampleAgeMs,
        streamBounceFromTroughPct: streamWindow.bounceFromTroughPct,
        streamRallyIntoPeakPct: streamWindow.rallyIntoPeakPct,
        streamDumpExtentFromPeakPct: streamWindow.dumpExtentFromPeakPct,
      };
    }
    if (shouldJournalGreenVerdict(mint, nowMs)) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_green_lane_skip',
        mint,
        trigger,
        ...streamObservabilitySnapshot(
          mint,
          cfg.cooldownBounceLookbackMs,
          greenTapeNowMs,
          struct.metrics.pairAgeHours,
          tapeOptions,
        ),
        tapeNowSkewMs: greenTapeNowMs - nowMs,
        reasons: g.reasons,
        structSource,
        structAgeMs,
        pc5m: struct.metrics.priceChange5mPct,
        pc1h: struct.metrics.priceChange1hPct,
        vol5m: struct.metrics.volume5mUsd,
        liq: struct.metrics.liquidityUsd,
        turnover: g.turnover,
        ageH: struct.metrics.pairAgeHours,
        buyShare: g.buyShare,
        runnerRelax: greenRunnerRelax,
        effMinLiquidityUsd: greenGates.minLiquidityUsd,
        effMinPairAgeHours: greenGates.minPairAgeHours,
        effMaxBounceFromTroughPct: greenGates.maxBounceFromTroughPct,
        effMaxTapeRet1mPct: Number.isFinite(greenGates.maxTapeRet1mPct)
          ? greenGates.maxTapeRet1mPct
          : null,
        effMaxTapePrior5mPct: Number.isFinite(greenGates.maxTapePrior5mPct ?? 0)
          ? (greenGates.maxTapePrior5mPct ?? null)
          : null,
      });
    }
    if (greenOnly) return null;
  }

  const impulseEntry = evaluateMildDipImpulseEntry({
    buys5m: struct.metrics.buys5m,
    sells5m: struct.metrics.sells5m,
    volume5mUsd: struct.metrics.volume5mUsd,
    liquidityUsd: struct.metrics.liquidityUsd,
    minTxns5m: cfg.entryMinTxns5m,
    minTurnover5mLiq: cfg.entryMinTurnover5mLiq,
  });
  if (!impulseEntry.pass) {
    return skip('entry_impulse_fail', {
      reasons: impulseEntry.reasons,
      impulseMetricsUnknown: impulseEntry.unknownReasons ?? null,
      buys5m: struct.metrics.buys5m,
      sells5m: struct.metrics.sells5m,
      vol5m: struct.metrics.volume5mUsd,
      liq: struct.metrics.liquidityUsd,
      minTxns5m: cfg.entryMinTxns5m,
      minTurnover5mLiq: cfg.entryMinTurnover5mLiq,
    });
  }

  // A name a leader is buying gets the younger age floor (1.11.905).
  const dexPc = struct.metrics.priceChange5mPct;
  const knifeStreamGuard = evaluateKnifeStreamGuard({
    streamDd,
    dexPc,
    dexGreenVeto: cfg.knifeDexGreenVeto,
    dexGreenMinPc5m: cfg.knifeDexGreenMinPc5m,
    maxDivergencePp: cfg.knifeStreamDivergenceMaxPp,
  });
  const streamPc5mForKnife = knifeStreamGuard.streamPc5mForKnife;
  const deepestPc =
    streamPc5mForKnife != null && dexPc != null
      ? Math.min(streamPc5mForKnife, dexPc)
      : streamPc5mForKnife != null
        ? streamPc5mForKnife
        : dexPc;
  /**
   * Hot deep dump on our own tape: dump≥knifeMin & turn≥knifeMin. Evaluated *before*
   * structural so high turnover (vol5m/liq) does not block the blade we are
   * trying to catch ahead of anyone else.
   */
  const hotDeepKnifeOk =
    !knifeStreamGuard.blocked && metricsHotDeepDumpOk(cfg, struct.metrics, deepestPc);

  const leaderSeenForAge = leaderSeenName;
  /**
   * 1.11.928 — when a leader just bought (seed / memory), the observer already
   * passed Dex floors. Re-checking on a later scan/stream tick often fails on
   * decayed vol/liq and blocks the co-buy we are trying to mirror.
   */
  const leaderTrustStructuralWindowMs =
    cfg.entryLeaderTrustStructuralMs > 0
      ? cfg.entryLeaderTrustStructuralMs
      : cfg.leaderCoBuyAlignMaxMs;
  const leaderTrustStructural = leaderTrustStructuralOk({
    nowMs,
    leaderCoBuyAlignMaxMs: cfg.leaderCoBuyAlignMaxMs,
    entryLeaderTrustStructuralMs: cfg.entryLeaderTrustStructuralMs,
    leaderFreshBuy,
    trigger,
    seedHit,
    leaderSeenAtMs,
  });
  if (
    !leaderTrustStructural &&
    !hotDeepKnifeOk &&
    !structuralOk(
      struct.metrics,
      cfg,
      leaderSeenForAge,
      leaderFreshBuy,
      hotDeepKnifeOk,
    )
  ) {
    return skip('structural_fail', {
      structSource,
      structAgeMs,
      leaderSeen: leaderSeenForAge,
      leaderFreshBuy,
      leaderTrustStructural,
      leaderTrustStructuralWindowMs,
      hotDeepKnife: hotDeepKnifeOk,
      vol5m: struct.metrics.volume5mUsd,
      liq: struct.metrics.liquidityUsd,
      mcap: struct.metrics.marketCapUsd,
      ageH: struct.metrics.pairAgeHours,
      pc5m: struct.metrics.priceChange5mPct,
      deepestPc,
      knifeStreamGuardReasons: knifeStreamGuard.reasons,
      knifeStreamGuardDetails: knifeStreamGuard.details,
    });
  }

  const coBuy = leaderCoBuyAlignOk(cfg, struct.metrics, {
    nowMs,
    trigger,
    seedHit: seedHit ?? null,
    leaderSeenAtMs,
  });
  if (!coBuy.ok) {
    return skip('leader_co_buy_align', {
      turn: coBuy.turn,
      minTurn: cfg.leaderCoBuyAlignMinTurn,
      leaderFresh: coBuy.leaderFresh,
      maxAgeMs: cfg.leaderCoBuyAlignMaxMs,
      structSource,
      pc5m: struct.metrics.priceChange5mPct,
    });
  }

  const dexInMain = inDipBand(dexPc, cfg.entry.minDipPct, maxDip);

  const knifeOrOk = hotDeepKnifeOk;

  // Deep knife band — leave to knife-stabilize wait path (not instant blade catch),
  // unless the 7BNax knife OR already qualifies for an immediate seat.
  // Use mark-vs-peak (still falling), not dump-extent (already printed).
  const deepKnife =
    (streamCurrentDd != null &&
      streamCurrentDd > cfg.knifeStabilizeMinDipPct &&
      streamCurrentDd <= cfg.knifeStabilizeMaxDipPct) ||
    (dexPc != null &&
      dexPc > cfg.knifeStabilizeMinDipPct &&
      dexPc <= cfg.knifeStabilizeMaxDipPct);
  /**
   * Defer waits 30s for the blade to stop — for cold deep knives only. A hot
   * deep dump (dump≥30 & turn≥0.3 on our stream) buys now; no leader required.
   */
  if (
    cfg.knifeStabilizeEnabled &&
    deepKnife &&
    !streamInMain &&
    !dexInMain &&
    !knifeOrOk
  ) {
    return skip('deep_knife_defer', {
      streamDd,
      streamDump,
      streamCurrentDd,
      dexPc,
      knifeStreamGuardReasons: knifeStreamGuard.reasons,
      knifeStreamGuardDetails: knifeStreamGuard.details,
    });
  }

  let dipSource: MildDipCandidate['dipSource'] | null = null;
  let priceUsd = struct.priceUsd;
  let metrics = { ...struct.metrics };

  if (streamInMain && dexInMain) {
    dipSource = 'dex+stream';
    // Prefer deeper (more negative) for journaling — dump extent vs Dex.
    const dip = Math.min(streamDd!, dexPc!);
    metrics = { ...metrics, priceChange5mPct: dip };
    const last = mildDipPriceRing.lastPrice(mint, nowMs);
    if (last && last.priceUsd > 0) priceUsd = last.priceUsd;
  } else if (streamInMain && cfg.streamDipEntryEnabled) {
    // Stream-only: real dump extent; Dex confirm OR near post-peak trough (1.11.779/790).
    if (streamDump == null || !(streamDump <= cfg.streamOnlyMaxDipPct)) {
      /* fall through — maybe Dex / h1 / flat_micro still qualify */
    } else {
      const dexConfirm = streamOnlyDexDipOk({
        requireDexDip: cfg.streamOnlyRequireDexDip,
        dexPc5m: dexPc,
        dexMaxDipPct: cfg.streamOnlyDexMaxDipPct,
        allowMissingDex: cfg.streamOnlyAllowMissingDex,
        blockDexGreen: cfg.streamOnlyBlockDexGreen,
      });
      const last = mildDipPriceRing.lastPrice(mint, nowMs);
      const lastPx = last && last.priceUsd > 0 ? last.priceUsd : priceUsd;
      const bounce = mildDipPriceRing.bounceFromPostPeakTroughPct(
        mint,
        lastPx,
        lookbackMs,
        nowMs,
      );
      const samples = mildDipPriceRing.sampleCount(mint, lookbackMs, nowMs);
      const nearTrough = streamOnlyNearTroughOk({
        enabled: cfg.streamOnlyNearTroughEnabled,
        bounceFromTroughPct: bounce,
        maxBouncePct: cfg.streamOnlyNearTroughMaxBouncePct,
        sampleCount: samples,
        minSamples: cfg.streamOnlyMinSamples,
      });
      // Green Dex hard-blocks even near-trough (reclaim).
      const dexGreen =
        cfg.streamOnlyBlockDexGreen && dexPc != null && Number.isFinite(dexPc) && dexPc > 0;
      if ((dexConfirm || nearTrough) && !dexGreen) {
        dipSource = 'stream';
        metrics = { ...metrics, priceChange5mPct: streamDump };
        if (last && last.priceUsd > 0) priceUsd = last.priceUsd;
      }
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
    // Flat-micro: mark-vs-peak depth (tiny band); still block pump-wick via rally gate.
    const streamFlatDumpOk =
      inDipBand(streamDump, cfg.flatMicroMinDipPct, cfg.flatMicroMaxDipPct) &&
      inDipBand(streamCurrentDd, cfg.flatMicroMinDipPct, cfg.flatMicroMaxDipPct) &&
      dumpRallyGateOk({
        dumpExtentPct: streamDump,
        rallyIntoPeakPct: streamRally,
        minRallyPct: cfg.dumpRallyGateMinPct,
        minDumpFracOfRally: cfg.dumpRallyMinFrac,
      });
    const dexInFlat = inDipBand(dexPc, cfg.flatMicroMinDipPct, cfg.flatMicroMaxDipPct);
    const flatDip = dexInFlat ? dexPc : streamFlatDumpOk ? streamDump : dexPc;
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
      if (streamFlatDumpOk && !dexInFlat && streamDump != null) {
        metrics = { ...metrics, priceChange5mPct: streamDump };
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
    const mildTroughAgeMs =
      mild.troughAtMs != null ? Math.max(0, nowMs - mild.troughAtMs) : null;
    if (
      mildStabilizeSkipTelemetryEligible({
        pass: mild.pass,
        reasons: mild.reasons,
        dumpPct: mild.dumpPct,
        troughAgeMs: mildTroughAgeMs,
        minDumpPct: cfg.mildStabilizeSkipMinDumpPct,
      }) &&
      takeMildStabilizeSkipTelemetrySlot(cfg.mildStabilizeSkipMaxPerHour, nowMs)
    ) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_mild_stabilize_skip',
        mint,
        structSource,
        structAgeMs,
        dumpPct: mild.dumpPct,
        bouncePct: mild.bouncePct,
        troughAtMs: mild.troughAtMs,
        troughAgeMs: mildTroughAgeMs,
        lastPriceUsd: mild.lastPriceUsd,
        peakPriceUsd: mild.peakPriceUsd,
        reasons: mild.reasons,
      });
    }
    if (mild.pass) {
      // 1.11.800 — do not accept bounce while Dex m5 is already green/flat.
      // Also never overwrite Dex pc5m with ring dump (lied to turn-dump on EjD5Y9).
      if (
        !mildStabilizeDexDipOk({
          requireDexDip: cfg.mildStabilizeRequireDexDip,
          dexPc5m: dexPc,
          dexMaxDipPct: cfg.mildStabilizeDexMaxDipPct,
        })
      ) {
        return skip('mild_stabilize_dex_not_red', {
          streamDd,
          dexPc,
          mildDump: mild.dumpPct,
          mildBounce: mild.bouncePct,
          dexMaxDipPct: cfg.mildStabilizeDexMaxDipPct,
        });
      }
      dipSource = 'mild_stabilize';
      mildDumpPct = mild.dumpPct;
      mildBouncePct = mild.bouncePct;
      mildTrough = mild.troughPriceUsd;
      mildTroughAtMs = mild.troughAtMs;
      if (mild.lastPriceUsd != null && mild.lastPriceUsd > 0) priceUsd = mild.lastPriceUsd;
    }
  }

  if (!dipSource && knifeOrOk && deepestPc != null) {
    dipSource = 'turn_dump_knife';
    metrics = { ...metrics, priceChange5mPct: deepestPc };
    const last = mildDipPriceRing.lastPrice(mint, nowMs);
    if (last && last.priceUsd > 0) priceUsd = last.priceUsd;
  }

  // 1.11.802 — TD pass ⇒ dipSource before no_dip_source (was dead when formula
  // already matched Dex tape but classic main-band dipSource was unset).
  let tdRescue = false;
  const tdPc5mForGate =
    streamPc5mForKnife != null &&
    Number.isFinite(streamPc5mForKnife) &&
    (metrics.priceChange5mPct == null ||
      !Number.isFinite(metrics.priceChange5mPct) ||
      streamPc5mForKnife < (metrics.priceChange5mPct as number))
      ? streamPc5mForKnife
      : (metrics.priceChange5mPct ?? dexPc);
  if (!dipSource && cfg.turnDumpGateEnabled) {
    const tdEarly = evaluateTurnDumpGate(
      turnDumpArgsFromCfg(cfg, tdPc5mForGate, metrics, hotDeepKnifeOk),
    );
    if (tdEarly.pass) {
      tdRescue = true;
      dipSource = tdEarly.branch === 'knife' ? 'turn_dump_knife' : 'dex';
      if (tdPc5mForGate != null && Number.isFinite(tdPc5mForGate)) {
        metrics = { ...metrics, priceChange5mPct: tdPc5mForGate };
      }
    }
  }

  if (!dipSource) {
    return skip(knifeStreamGuard.reasons[0] ?? 'no_dip_source', {
      structSource,
      streamDd,
      streamDump,
      streamCurrentDd,
      streamRally,
      dexPc,
      pc1h: metrics.priceChange1hPct,
      knifeStreamGuardReasons: knifeStreamGuard.reasons,
      knifeStreamGuardDetails: knifeStreamGuard.details,
    });
  }

  if (
    dipSource === 'turn_dump_knife' &&
    (cfg.turnDumpKnifeTroughMinAgeMs > 0 ||
      cfg.turnDumpKnifeTroughMaxBouncePct < 100)
  ) {
    const trough = evaluateConfirmedTrough({
      ring: mildDipPriceRing,
      mint,
      nowMs,
      windowMs: cfg.entryTroughLookbackMs,
      freshPriceUsd: priceUsd,
    });
    if (
      !confirmedTroughGatePasses({
        metrics: trough,
        minTroughAgeMs: cfg.turnDumpKnifeTroughMinAgeMs,
        maxBouncePct: cfg.turnDumpKnifeTroughMaxBouncePct,
      })
    ) {
      return skip('turn_dump_knife_trough_gate', {
        dipSource,
        troughAgeMs: trough.troughAgeMs,
        bounceFromTroughPct: trough.bounceFromTroughPct,
        dropFromWindowHighPct: trough.dropFromWindowHighPct,
        troughAtMs: trough.troughAtMs,
        troughMinAgeMs: cfg.turnDumpKnifeTroughMinAgeMs,
        troughMaxBouncePct: cfg.turnDumpKnifeTroughMaxBouncePct,
        troughWindowMs: trough.windowMs,
      });
    }
  }

  // 1.11.801 — D2zNEW: H1 pump + −10% pullback is not a dip. Knife-OR (≥30) exempt.
  if (
    dipSource !== 'turn_dump_knife' &&
    dipSource !== 'h1_red_shallow' &&
    !dumpH1PumpGateOk({
      priceChange1hPct: metrics.priceChange1hPct,
      dumpExtentPct: streamDump ?? mildDumpPct,
      fallbackDumpPct: deepestPc ?? dexPc,
      h1PumpMinPct: cfg.dumpH1PumpMinPct,
      minDumpPct: cfg.dumpH1PumpMinDumpPct,
    })
  ) {
    return skip('h1_pump_chase', {
      structSource,
      streamDump,
      streamCurrentDd,
      streamRally,
      dexPc,
      pc1h: metrics.priceChange1hPct,
      dipSource,
      needDump: cfg.dumpH1PumpMinDumpPct,
      h1Min: cfg.dumpH1PumpMinPct,
    });
  }

  // 1.11.773 — turn→dump: buy now if depth matches turnover; skip if too shallow.
  // 1.11.779/790 — prefer deeper stream dump-extent vs lagging Dex pc5m for the gate.
  if (cfg.turnDumpGateEnabled) {
    const tdPc5m = tdPc5mForGate;
    const td = evaluateTurnDumpGate(
      turnDumpArgsFromCfg(cfg, tdPc5m, metrics, hotDeepKnifeOk || dipSource === 'turn_dump_knife'),
    );
    if (!td.pass) {
      // 1.11.774 — was silent null; journal so live misses are visible.
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_turn_dump_skip',
        mint,
        dipSource,
        lane: 'fast',
        trigger,
        structSource,
        structAgeMs,
        pc5m: tdPc5m,
        streamDd,
        streamDump,
        streamCurrentDd,
        streamRally,
        dexPc,
        dump: td.dump,
        turn: td.turn,
        pred: td.pred,
        resid: td.resid,
        branch: td.branch,
        reasons: td.reasons,
      });
      return shadowSkip('turn_dump_skip', {
        dump: td.dump,
        turn: td.turn,
        pred: td.pred,
        resid: td.resid,
        branch: td.branch,
        reasons: td.reasons,
      });
    }
  }

  // 1.11.802 — stream ring only for stream-timed sources (Dex/TD may enter without it).
  if (cfg.requireStreamPriceEntry && requireStreamPriceForDipSource(dipSource)) {
    const maxAge = cfg.requireStreamPriceMaxAgeMs;
    const stream = mildDipPriceRing.lastPriceBySource(mint, 'stream', nowMs, maxAge);
    if (!stream || !(stream.priceUsd > 0)) {
      const last = mildDipPriceRing.lastPrice(mint, nowMs);
      return skip('no_stream_price', {
        dipSource,
        lastSource: last?.source ?? null,
        lastAgeMs: last ? Math.max(0, nowMs - last.tsMs) : null,
        maxAgeMs: maxAge,
      });
    }
  }

  // Leader/stream triggers: require a real dip print (not green chase).
  if (trigger === 'leader' || trigger === 'stream') {
    if (
      dipSource === 'h1_red_shallow' ||
      dipSource === 'flat_micro_dip' ||
      dipSource === 'mild_stabilize' ||
      dipSource === 'turn_dump_knife' ||
      tdRescue
    ) {
      /* ok — shallow / bounce-confirm / 7BNax knife OR / TD-rescue dex */
    } else if (!streamInMain && !dexInMain) {
      return skip('not_in_main_band', {
        dipSource,
        streamDd,
        streamDump,
        streamCurrentDd,
        dexPc,
        structSource,
      });
    }
  }

  lastFastAttemptMs.set(mint, nowMs);
  return {
    mint,
    symbol: mint.slice(0, 6),
    priceUsd,
    metrics,
    dipSource,
    structSource,
    structAgeMs,
    streamWindowSampleCount: streamWindow.sampleCount,
    streamCoverageMs: streamWindow.oldestSampleAgeMs,
    streamBounceFromTroughPct: streamWindow.bounceFromTroughPct,
    streamRallyIntoPeakPct: streamWindow.rallyIntoPeakPct,
    streamDumpExtentFromPeakPct: streamWindow.dumpExtentFromPeakPct,
    ...(impulseEntry.unknownReasons
      ? { impulseMetricsUnknown: impulseEntry.unknownReasons }
      : {}),
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
