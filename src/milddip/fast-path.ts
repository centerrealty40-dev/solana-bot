/**
 * Fast entry lane — stream / leader triggered.
 *
 * Avoids the slow Dex enrich batch (80 mints behind 120 RPM). One Dex fetch
 * (or cache hit) for structural gates + stream drawdown for timing.
 */
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import { evaluateGreenLane } from './green-lane.js';
import type { MildDipConfig } from './config.js';
import type { MildDipCandidate } from './discover.js';
import { evaluateFlatMicroDip, type MildDipCandidateMetrics } from './gates.js';
import {
  evaluateMildStabilizeFromRing,
  mildStabilizeDexDipOk,
  mildStabilizeLaneAllowed,
} from './mild-stabilize.js';
import { mildDipPriceRing } from './price-ring.js';
import type { LeaderSeedHit } from './discover-extra.js';
import { appendMildDipJournal } from './state.js';
import { evaluateTurnDumpGate, turnDumpKnifeOrOk } from './turn-dump.js';

function turnDumpArgsFromCfg(
  cfg: MildDipConfig,
  pc5m: number | null | undefined,
  metrics: MildDipCandidateMetrics,
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
    knifeBranchEnabled: cfg.turnDumpKnifeBranchEnabled,
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
};

const structuralCache = new Map<string, StructuralCacheEntry>();
const lastFastAttemptMs = new Map<string, number>();
/** Per-mint throttle for Dex probes when stream drawdown is not yet in band. */
const lastHotDexProbeMs = new Map<string, number>();
/** Rate-limit leader fast-path skip journals (wake is every 2s). */
const lastLeaderSkipJournalMs = new Map<string, number>();
let hotDexProbeWindowStartMs = 0;
let hotDexProbeCount = 0;

/** Test helper. */
export function resetFastPathStateForTests(): void {
  structuralCache.clear();
  lastFastAttemptMs.clear();
  lastHotDexProbeMs.clear();
  lastLeaderSkipJournalMs.clear();
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
): boolean {
  const g = cfg.entry;
  const minAge =
    leaderSeen && g.minPairAgeHoursLeaderSeen > 0
      ? Math.min(g.minPairAgeHoursLeaderSeen, g.minPairAgeHours)
      : g.minPairAgeHours;
  if (metrics.volume5mUsd == null || !(metrics.volume5mUsd >= g.minVolume5mUsd)) return false;
  if (g.maxVolume5mUsd > 0 && metrics.volume5mUsd > g.maxVolume5mUsd) return false;
  if (metrics.liquidityUsd == null || !(metrics.liquidityUsd >= g.minLiquidityUsd)) return false;
  if (metrics.marketCapUsd == null || !(metrics.marketCapUsd >= g.minMarketCapUsd)) return false;
  if (metrics.marketCapUsd > g.maxMarketCapUsd) return false;
  if (metrics.pairAgeHours == null || metrics.pairAgeHours < minAge) return false;
  if (
    (g.minTurnover5mLiq > 0 || g.maxTurnover5mLiq > 0) &&
    metrics.volume5mUsd != null &&
    metrics.liquidityUsd != null &&
    metrics.liquidityUsd > 0
  ) {
    const turn = metrics.volume5mUsd / metrics.liquidityUsd;
    if (g.minTurnover5mLiq > 0 && turn < g.minTurnover5mLiq) return false;
    if (g.maxTurnover5mLiq > 0 && turn > g.maxTurnover5mLiq) return false;
  }
  if (g.maxPairAgeHours > 0 && metrics.pairAgeHours > g.maxPairAgeHours) return false;
  if (g.allowedDexIds.length > 0) {
    const dex = (metrics.dexId ?? '').toLowerCase();
    if (!dex || !g.allowedDexIds.includes(dex)) return false;
  }
  return true;
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

function structuralFromDexDetails(
  mint: string,
  details: NonNullable<Awaited<ReturnType<typeof fetchDexScreenerPairDetails>>>,
  nowMs: number,
): StructuralCacheEntry {
  mildDipPriceRing.note(mint, details.priceUsd!, { tsMs: nowMs, source: 'dex' });
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
  const entry = { fetchedAtMs: nowMs, priceUsd: details.priceUsd!, metrics };
  noteStructuralCache(mint, entry.priceUsd, metrics, nowMs);
  return entry;
}

/**
 * Dex structural load: fresh cache → fetch with 1 retry → stale cache ≤30s.
 * One null blip must not kill a TD-eligible mint (`structural_fetch_null` spam).
 */
export async function loadStructural(
  mint: string,
  cfg: MildDipConfig,
  nowMs: number,
): Promise<StructuralCacheEntry | null> {
  const freshMs = cfg.fastPathStructuralCacheMs;
  const cached = getStructuralCache(mint, nowMs, freshMs);
  if (cached) return cached;

  for (let attempt = 0; attempt < STRUCTURAL_FETCH_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, STRUCTURAL_RETRY_GAP_MS));
    }
    const details = await fetchDexScreenerPairDetails(mint, {
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
    // Green is decided entirely off the Dex snapshot; a stream print adds nothing.
    dipSource !== 'green_momentum'
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
): Promise<MildDipCandidate | null> {
  const skip = (reason: string, extra?: Record<string, unknown>): null => {
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
          ...extra,
        });
      }
    }
    return null;
  };

  if (!cfg.fastPathEnabled) return skip('fast_path_off');
  if (!mint || mint.length < 32) return skip('bad_mint');
  if (cfg.deniedMints.includes(mint)) return skip('denied_mint');

  // 1.11.802 — do NOT hard-block here on stream ring. Dex/TD entries may
  // proceed without a stream print; stream-timed sources still checked below.

  const prevAttempt = lastFastAttemptMs.get(mint) ?? 0;
  if (nowMs - prevAttempt < cfg.fastPathMinGapMs) return null;

  const lookbackMs = cfg.cooldownBounceLookbackMs;
  const streamCurrentDd = streamDrawdownPct(mint, lookbackMs, nowMs);
  const streamDump = streamDumpExtentPct(mint, lookbackMs, nowMs);
  const streamRally = mildDipPriceRing.rallyIntoPeakPct(mint, lookbackMs, nowMs);
  // Journal / turn-dump prefer true dump extent; fall back to mark-vs-peak.
  const streamDd = streamDump ?? streamCurrentDd;
  const streamInMain = streamDipInBandOk({
    dumpExtentPct: streamDump,
    currentDrawdownPct: streamCurrentDd,
    rallyIntoPeakPct: streamRally,
    minDipPct: cfg.entry.minDipPct,
    maxDipPct: cfg.entry.maxDipPct,
    dumpRallyGateMinPct: cfg.dumpRallyGateMinPct,
    dumpRallyMinFrac: cfg.dumpRallyMinFrac,
  });

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

  // 1.11.775 — leader wake: prefer observer Dex snapshot (same print he bought on).
  let struct: StructuralCacheEntry | null =
    trigger === 'leader' && seedHit ? structuralFromLeaderSeed(seedHit, nowMs) : null;
  let structSource: 'leader_seed' | 'dex' = struct ? 'leader_seed' : 'dex';
  if (!struct) {
    struct = await loadStructural(mint, cfg, nowMs);
    structSource = 'dex';
  } else {
    // Keep cache warm for follow-up ticks.
    noteStructuralCache(mint, struct.priceUsd, struct.metrics, nowMs);
  }
  if (!struct) return skip('structural_fetch_null', { structSource });
  // Age of the snapshot the decision rests on — lets us check afterwards whether
  // entries taken off a stale snapshot perform worse than fresh ones.
  const structAgeMs = Math.max(0, nowMs - struct.fetchedAtMs);
  /**
   * Green lane, evaluated before the dip floors because it is a different
   * trade with its own floors, its own clip and its own exit. A momentum name
   * is younger and hotter than anything the dip lane wants, so running it
   * through `structuralOk` would reject it on the 6h age floor that was fitted
   * on dip P&L.
   */
  if (cfg.green.enabled) {
    const g = evaluateGreenLane(
      {
        pc5mPct: struct.metrics.priceChange5mPct,
        pc1hPct: struct.metrics.priceChange1hPct,
        volume5mUsd: struct.metrics.volume5mUsd,
        volume1hUsd: struct.metrics.volume1hUsd,
        liquidityUsd: struct.metrics.liquidityUsd,
        buys5m: struct.metrics.buys5m,
        sells5m: struct.metrics.sells5m,
        pairAgeHours: struct.metrics.pairAgeHours,
      },
      {
        enabled: true,
        minTurnover5mLiq: cfg.green.minTurnover5mLiq,
        minVolume5mUsd: cfg.green.minVolume5mUsd,
        minVolume1hUsd: cfg.green.minVolume1hUsd,
        minPc5mPct: cfg.green.minPc5mPct,
        minPc1hPct: cfg.green.minPc1hPct,
        minBuys5m: cfg.green.minBuys5m,
        maxBuyShare5m: cfg.green.maxBuyShare5m,
        minLiquidityUsd: cfg.green.minLiquidityUsd,
        minPairAgeHours: cfg.green.minPairAgeHours,
        maxRet1mPct: cfg.green.maxRet1mPct,
      },
    );
    if (g.pass) {
      return {
        mint,
        symbol: mint.slice(0, 6),
        priceUsd: struct.priceUsd,
        metrics: struct.metrics,
        dipSource: 'green_momentum',
      };
    }
  }

  // A name a leader is buying gets the younger age floor (1.11.905).
  const leaderSeenForAge = trigger === 'leader' || seedHit != null;
  if (!structuralOk(struct.metrics, cfg, leaderSeenForAge)) {
    return skip('structural_fail', {
      structSource,
      structAgeMs,
      leaderSeen: leaderSeenForAge,
      vol5m: struct.metrics.volume5mUsd,
      liq: struct.metrics.liquidityUsd,
      mcap: struct.metrics.marketCapUsd,
      ageH: struct.metrics.pairAgeHours,
      pc5m: struct.metrics.priceChange5mPct,
    });
  }

  const dexPc = struct.metrics.priceChange5mPct;
  const dexInMain = inDipBand(dexPc, cfg.entry.minDipPct, cfg.entry.maxDipPct);

  // 1.11.793/799 — 7BNax OR: deep+hot (dump≥30 & turn≥0.3) buys now.
  // Do not require TD branch==='knife' (hot dumps classify as main first).
  const deepestPc =
    streamDd != null && dexPc != null
      ? Math.min(streamDd, dexPc)
      : streamDd != null
        ? streamDd
        : dexPc;
  const knifeOr = turnDumpKnifeOrOk({
    enabled: cfg.turnDumpGateEnabled,
    knifeBranchEnabled: cfg.turnDumpKnifeBranchEnabled,
    pc5m: deepestPc,
    volume5mUsd: struct.metrics.volume5mUsd,
    liquidityUsd: struct.metrics.liquidityUsd,
    minDumpPct: cfg.turnDumpKnifeMinDumpPct,
    minTurn: cfg.turnDumpKnifeMinTurn,
  });
  const knifeOrOk = knifeOr.ok;

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
  if (cfg.knifeStabilizeEnabled && deepKnife && !streamInMain && !dexInMain && !knifeOrOk) {
    return skip('deep_knife_defer', {
      streamDd,
      streamDump,
      streamCurrentDd,
      dexPc,
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
    streamDd != null &&
    Number.isFinite(streamDd) &&
    (metrics.priceChange5mPct == null ||
      !Number.isFinite(metrics.priceChange5mPct) ||
      streamDd < (metrics.priceChange5mPct as number))
      ? streamDd
      : (metrics.priceChange5mPct ?? dexPc);
  if (!dipSource && cfg.turnDumpGateEnabled) {
    const tdEarly = evaluateTurnDumpGate(turnDumpArgsFromCfg(cfg, tdPc5mForGate, metrics));
    if (tdEarly.pass) {
      tdRescue = true;
      dipSource = tdEarly.branch === 'knife' ? 'turn_dump_knife' : 'dex';
      if (tdPc5mForGate != null && Number.isFinite(tdPc5mForGate)) {
        metrics = { ...metrics, priceChange5mPct: tdPc5mForGate };
      }
    }
  }

  if (!dipSource) {
    return skip('no_dip_source', {
      structSource,
      streamDd,
      streamDump,
      streamCurrentDd,
      streamRally,
      dexPc,
      pc1h: metrics.priceChange1hPct,
    });
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
    const td = evaluateTurnDumpGate(turnDumpArgsFromCfg(cfg, tdPc5m, metrics));
    if (!td.pass) {
      // 1.11.774 — was silent null; journal so live misses are visible.
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_turn_dump_skip',
        mint,
        dipSource,
        lane: 'fast',
        trigger,
        structSource,
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
      return null;
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
