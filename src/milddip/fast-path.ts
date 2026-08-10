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
import type { LeaderSeedHit } from './discover-extra.js';
import { appendMildDipJournal } from './state.js';
import { evaluateTurnDumpGate, turnover5mLiq } from './turn-dump.js';

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

  // 1.11.798 — bot is stream-priced: no entry on Dex pc5m alone when the
  // Helius swap→ring tape is silent (green-candle Dex fills).
  if (cfg.requireStreamPriceEntry) {
    const last = mildDipPriceRing.lastPrice(mint, nowMs);
    const maxAge = cfg.requireStreamPriceMaxAgeMs;
    const streamFresh =
      last != null &&
      last.source === 'stream' &&
      last.priceUsd > 0 &&
      (maxAge <= 0 || nowMs - last.tsMs <= maxAge);
    if (!streamFresh) {
      return skip('no_stream_price', {
        lastSource: last?.source ?? null,
        lastAgeMs: last ? Math.max(0, nowMs - last.tsMs) : null,
        maxAgeMs: maxAge,
      });
    }
  }

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
  if (!structuralOk(struct.metrics, cfg)) {
    return skip('structural_fail', {
      structSource,
      vol5m: struct.metrics.volume5mUsd,
      liq: struct.metrics.liquidityUsd,
      mcap: struct.metrics.marketCapUsd,
      ageH: struct.metrics.pairAgeHours,
      pc5m: struct.metrics.priceChange5mPct,
    });
  }

  const dexPc = struct.metrics.priceChange5mPct;
  const dexInMain = inDipBand(dexPc, cfg.entry.minDipPct, cfg.entry.maxDipPct);

  // 1.11.793 — 7BNax OR: deep+hot (dump≥30 & turn≥0.3) buys now on this wallet.
  const deepestPc =
    streamDd != null && dexPc != null
      ? Math.min(streamDd, dexPc)
      : streamDd != null
        ? streamDd
        : dexPc;
  const turnNow = turnover5mLiq(struct.metrics.volume5mUsd, struct.metrics.liquidityUsd);
  const knifeOrOk =
    cfg.turnDumpGateEnabled &&
    cfg.turnDumpKnifeBranchEnabled &&
    deepestPc != null &&
    deepestPc < 0 &&
    turnNow != null &&
    evaluateTurnDumpGate(turnDumpArgsFromCfg(cfg, deepestPc, struct.metrics)).branch ===
      'knife';

  // Deep knife band — leave to knife-stabilize wait path (not instant blade catch),
  // unless the 7BNax knife OR already qualifies for an immediate seat.
  const deepKnife =
    (streamDd != null &&
      streamDd > cfg.knifeStabilizeMinDipPct &&
      streamDd <= cfg.knifeStabilizeMaxDipPct) ||
    (dexPc != null &&
      dexPc > cfg.knifeStabilizeMinDipPct &&
      dexPc <= cfg.knifeStabilizeMaxDipPct);
  if (cfg.knifeStabilizeEnabled && deepKnife && !streamInMain && !dexInMain && !knifeOrOk) {
    return skip('deep_knife_defer', { streamDd, dexPc });
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
    // Stream-only: deep ring dump; Dex confirm OR near-trough fallback (1.11.779).
    if (streamDd == null || !(streamDd <= cfg.streamOnlyMaxDipPct)) {
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
      const bounce = mildDipPriceRing.bounceFromTroughPct(
        mint,
        lastPx,
        cfg.cooldownBounceLookbackMs,
        nowMs,
      );
      const samples = mildDipPriceRing.sampleCount(
        mint,
        cfg.cooldownBounceLookbackMs,
        nowMs,
      );
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
        metrics = { ...metrics, priceChange5mPct: streamDd };
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

  if (!dipSource && knifeOrOk && deepestPc != null) {
    dipSource = 'turn_dump_knife';
    metrics = { ...metrics, priceChange5mPct: deepestPc };
    const last = mildDipPriceRing.lastPrice(mint, nowMs);
    if (last && last.priceUsd > 0) priceUsd = last.priceUsd;
  }

  if (!dipSource) {
    return skip('no_dip_source', {
      structSource,
      streamDd,
      dexPc,
      pc1h: metrics.priceChange1hPct,
    });
  }

  // 1.11.773 — turn→dump: buy now if depth matches turnover; skip if too shallow.
  // 1.11.779 — prefer deeper stream ring dump vs lagging Dex pc5m for the gate.
  if (cfg.turnDumpGateEnabled) {
    const tdPc5m =
      streamDd != null &&
      Number.isFinite(streamDd) &&
      (metrics.priceChange5mPct == null ||
        !Number.isFinite(metrics.priceChange5mPct) ||
        streamDd < metrics.priceChange5mPct)
        ? streamDd
        : metrics.priceChange5mPct;
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

  // Leader/stream triggers: require a real dip print (not green chase).
  if (trigger === 'leader' || trigger === 'stream') {
    if (
      dipSource === 'h1_red_shallow' ||
      dipSource === 'flat_micro_dip' ||
      dipSource === 'mild_stabilize' ||
      dipSource === 'turn_dump_knife'
    ) {
      /* ok — shallow / bounce-confirm / 7BNax knife OR */
    } else if (!streamInMain && !dexInMain) {
      return skip('not_in_main_band', { dipSource, streamDd, dexPc, structSource });
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
