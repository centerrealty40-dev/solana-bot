/**
 * Candidate mint discovery for the mild-dip bot.
 * Universe: stream hot-list (+ boosts/profiles/leaders/pg_volume/gecko).
 * Metrics: DexScreener. Price samples always land in the price-ring
 * (even on gate fail / cooldown) so we remember the trough while waiting to rebuy.
 */
import fs from 'node:fs';
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import type { MildDipConfig } from './config.js';
import {
  discoverGeckoTrendingMints,
  discoverPgVolumeMints,
  readLeaderSeedMints,
} from './discover-extra.js';
import { noteStructuralCache } from './fast-path.js';
import { mapPool } from './exit-engine.js';
import {
  evaluateFlatMicroDip,
  evaluateMildDipEntry,
  knifeStabilizeMinMarketCapUsd,
  type MildDipCandidateMetrics,
} from './gates.js';
import { mildDipHotMints } from './hot-mints.js';
import {
  evaluateKnifeStabilizeReady,
  isKnifeDipPct,
  upsertKnifeWatch,
  type KnifeStabilizeGates,
  type KnifeWatchEntry,
} from './knife-stabilize.js';
import { mildDipPriceRing } from './price-ring.js';
import { evaluateTurnDumpGate } from './turn-dump.js';

function turnDumpAllowsCandidate(
  cfg: MildDipConfig,
  metrics: MildDipCandidateMetrics,
): boolean {
  if (!cfg.turnDumpGateEnabled) return true;
  return evaluateTurnDumpGate({
    enabled: true,
    pc5m: metrics.priceChange5mPct,
    volume5mUsd: metrics.volume5mUsd,
    liquidityUsd: metrics.liquidityUsd,
    alpha: cfg.turnDumpAlpha,
    beta: cfg.turnDumpBeta,
    shallowSlackPct: cfg.turnDumpShallowSlackPct,
    deepSlackPct: cfg.turnDumpDeepSlackPct,
  }).pass;
}

export type MildDipCandidate = {
  mint: string;
  symbol: string;
  priceUsd: number;
  metrics: MildDipCandidateMetrics;
  /** How the dip signal passed: Dex pc5m and/or stream drawdown. */
  dipSource:
    | 'dex'
    | 'stream'
    | 'dex+stream'
    | 'h1_red_shallow'
    | 'flat_micro_dip'
    | 'knife_stabilize'
    | 'mild_stabilize'
    | 'wait_dip';
  /** Present when dipSource=knife_stabilize. */
  knifeMode?: 'bounce' | 'stabilize';
  knifeBouncePct?: number | null;
  knifeWatch?: KnifeWatchEntry;
  /** Present when dipSource=mild_stabilize. */
  mildStabilizeDumpPct?: number | null;
  mildStabilizeBouncePct?: number | null;
  mildStabilizeTroughPriceUsd?: number | null;
  mildStabilizeTroughAtMs?: number | null;
  /** Present when dipSource=wait_dip. */
  waitDipSignalPriceUsd?: number | null;
  waitDipOriginalSource?: string | null;
  waitDipDumpFromSignalPct?: number | null;
};

const SOLANA_CHAIN = 'solana';

async function fetchJson(url: string): Promise<unknown> {
  try {
    const { fetch } = await import('undici');
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function mintFromBoostOrProfile(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as { chainId?: string; tokenAddress?: string };
  if ((o.chainId ?? '').toLowerCase() !== SOLANA_CHAIN) return null;
  const m = (o.tokenAddress ?? '').trim();
  return m.length >= 32 ? m : null;
}

async function discoverBoostMints(): Promise<string[]> {
  const data = await fetchJson('https://api.dexscreener.com/token-boosts/top/v1');
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const row of data) {
    const m = mintFromBoostOrProfile(row);
    if (m) out.push(m);
  }
  return out;
}

async function discoverProfileMints(): Promise<string[]> {
  const data = await fetchJson('https://api.dexscreener.com/token-profiles/latest/v1');
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const row of data) {
    const m = mintFromBoostOrProfile(row);
    if (m) out.push(m);
  }
  return out;
}

function readSeedMints(seedPath: string | undefined): string[] {
  if (!seedPath) return [];
  try {
    const raw = fs.readFileSync(seedPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((m) => m.length >= 32 && !m.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Mints we must keep enriching while cooling / just after cooldown so the
 * price-ring records the trough before we consider a rebuy.
 */
export function priorityMintsFromCooldown(
  cooldownUntilMs: Record<string, number>,
  nowMs: number,
  opts?: { postCooldownMs?: number },
): string[] {
  const post = opts?.postCooldownMs ?? 120_000;
  const out: string[] = [];
  for (const [mint, until] of Object.entries(cooldownUntilMs)) {
    if (!mint || typeof until !== 'number') continue;
    // Still cooling, or cooled down within post window (about to decide).
    if (until > nowMs || (nowMs - until >= 0 && nowMs - until <= post)) {
      out.push(mint);
    }
  }
  // Soonest-to-ready first (cooling ending soon / just ended).
  out.sort((a, b) => (cooldownUntilMs[a] ?? 0) - (cooldownUntilMs[b] ?? 0));
  return out;
}

/**
 * Keep recently traded mints in the enrich universe even after stream hot-list
 * TTL (15m) forgets them. Liquid names we already know must be pinned even when
 * volume/list sources are offline.
 */
export function priorityMintsFromRecentTrades(
  cooldownUntilMs: Record<string, number>,
  nowMs: number,
  opts?: { watchMs?: number; max?: number },
): string[] {
  const watchMs = Math.max(0, opts?.watchMs ?? 6 * 3_600_000);
  const max = Math.max(0, Math.floor(opts?.max ?? 40));
  const rows: Array<{ mint: string; until: number }> = [];
  for (const [mint, until] of Object.entries(cooldownUntilMs)) {
    if (!mint || mint.length < 32 || typeof until !== 'number') continue;
    // `until` is cooldown-end; treat it as last-touch proxy for ~watchMs after.
    if (until >= nowMs - watchMs) rows.push({ mint, until });
  }
  rows.sort((a, b) => b.until - a.until);
  return rows.slice(0, max).map((r) => r.mint);
}

/** Keep enriching active deep-knife watches so trough / bounce can resolve. */
export function priorityMintsFromKnifeWatch(
  knifeWatch: Record<string, KnifeWatchEntry> | undefined,
): string[] {
  if (!knifeWatch) return [];
  return Object.keys(knifeWatch).filter((m) => m.length >= 32);
}

function knifeGatesFromConfig(cfg: MildDipConfig): KnifeStabilizeGates {
  return {
    enabled: cfg.knifeStabilizeEnabled,
    minDipPct: cfg.knifeStabilizeMinDipPct,
    maxDipPct: cfg.knifeStabilizeMaxDipPct,
    waitMs: cfg.knifeStabilizeWaitMs,
    maxWatchMs: cfg.knifeStabilizeMaxWatchMs,
    quietMs: cfg.knifeStabilizeQuietMs,
    stabilizeBandPct: cfg.knifeStabilizeBandPct,
    minBouncePct: cfg.knifeStabilizeMinBouncePct,
    maxBouncePct: cfg.knifeStabilizeMaxBouncePct,
  };
}

/** Prefer the deeper (more negative) of Dex pc5m vs stream drawdown. */
export function resolveKnifeDipPct(
  dexPc5m: number | null | undefined,
  streamDrawdownPct: number | null | undefined,
): number | null {
  const vals = [dexPc5m, streamDrawdownPct].filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  if (vals.length === 0) return null;
  return Math.min(...vals);
}

export async function collectCandidateMints(
  cfg: MildDipConfig,
  opts?: { priorityMints?: string[]; nowMs?: number },
): Promise<string[]> {
  const sources = new Set(
    cfg.discoverSources
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (m: string) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    ordered.push(m);
  };

  const nowMs = opts?.nowMs ?? Date.now();

  // 1) Cooldown-watched / just-ready — must win enrich slots.
  for (const m of opts?.priorityMints ?? []) push(m);

  // 2) Leader buys (few, high-signal) — refresh hot-list TTL without Dex fan-out.
  if (sources.has('leaders')) {
    const leaders = readLeaderSeedMints(cfg.leaderSeedPath, nowMs, {
      maxAgeMs: cfg.leaderSeedMaxAgeMs,
      max: cfg.leaderSeedMax,
    });
    for (const m of leaders) {
      mildDipHotMints.note(m, nowMs, 1);
      push(m);
    }
  }

  // 3) Stream-hot (freshest on-chain activity).
  if (sources.has('stream')) {
    for (const m of mildDipHotMints.list(nowMs)) push(m);
  }
  if (sources.has('boosts')) {
    try {
      for (const m of await discoverBoostMints()) push(m);
    } catch {
      /* soft-fail — keep stream universe */
    }
  }
  if (sources.has('profiles')) {
    try {
      for (const m of await discoverProfileMints()) push(m);
    } catch {
      /* soft-fail */
    }
  }

  // 4) Volume/trending fillers — AFTER stream/boosts so they cannot steal
  // enrich slots from fresher activity. Do NOT note into hot-list (would
  // churn maxMints and push out stream names).
  if (sources.has('pg_volume')) {
    try {
      for (const m of await discoverPgVolumeMints({
        nowMs,
        max: cfg.pgVolumeMax,
        cacheMs: cfg.pgVolumeCacheMs,
        lookbackMin: cfg.pgVolumeLookbackMin,
        minVolume5mUsd: cfg.entry.minVolume5mUsd,
        minLiquidityUsd: cfg.entry.minLiquidityUsd,
        minMarketCapUsd: cfg.entry.minMarketCapUsd,
      })) {
        push(m);
      }
    } catch {
      /* soft-fail */
    }
  }
  if (sources.has('gecko')) {
    try {
      for (const m of await discoverGeckoTrendingMints({
        nowMs,
        max: cfg.geckoMax,
        cacheMs: cfg.geckoCacheMs,
        pages: cfg.geckoPages,
      })) {
        push(m);
      }
    } catch {
      /* soft-fail */
    }
  }

  if (sources.has('seed')) {
    for (const m of readSeedMints(cfg.seedMintsPath)) push(m);
  }
  return ordered;
}

function streamDipInBand(
  cfg: MildDipConfig,
  mint: string,
  nowMs: number,
): { ok: boolean; drawdownPct: number | null } {
  const dd = mildDipPriceRing.drawdownFromPeakPct(
    mint,
    cfg.cooldownBounceLookbackMs,
    nowMs,
  );
  if (dd == null || !Number.isFinite(dd)) return { ok: false, drawdownPct: dd };
  const ok = dd > cfg.entry.minDipPct && dd <= cfg.entry.maxDipPct;
  return { ok, drawdownPct: dd };
}

export type MildDipEnrichPassResult = {
  candidates: MildDipCandidate[];
  /** Updated knife-watch map after this enrich pass. */
  knifeWatch: Record<string, KnifeWatchEntry>;
  /** Journal-friendly watch lifecycle events. */
  knifeEvents: Array<Record<string, unknown>>;
};

type EnrichRow =
  | {
      kind: 'candidate';
      candidate: MildDipCandidate;
      /** Optional watch-clear when mild path supersedes a knife watch. */
      clearEvent?: Record<string, unknown>;
    }
  | {
      kind: 'knife';
      mint: string;
      watch: KnifeWatchEntry;
      event?: Record<string, unknown>;
      candidate?: MildDipCandidate;
    }
  | { kind: 'knife_clear'; mint: string; event: Record<string, unknown> }
  | null;

export async function enrichAndFilterCandidates(
  cfg: MildDipConfig,
  mints: string[],
  opts?: {
    nowMs?: number;
    maxEnrich?: number;
    enrichConcurrency?: number;
    /** Prefer shared Dex cache — background lane must not starve the gate. */
    bypassCache?: boolean;
    cacheTtlMs?: number;
    /** Always enrich these even past maxEnrich (cooldown / knife watch). */
    forceEnrich?: string[];
    /** Prior knife watches (mutated copy returned). */
    knifeWatch?: Record<string, KnifeWatchEntry>;
  },
): Promise<MildDipEnrichPassResult> {
  const nowMs = opts?.nowMs ?? Date.now();
  const maxEnrich = opts?.maxEnrich ?? cfg.enrichMax ?? 12;
  const enrichConcurrency = opts?.enrichConcurrency ?? cfg.enrichConcurrency ?? 12;
  const bypassCache = opts?.bypassCache ?? false;
  const cacheTtlMs = opts?.cacheTtlMs ?? 3_000;
  const knifeGates = knifeGatesFromConfig(cfg);
  const knifeWatchIn: Record<string, KnifeWatchEntry> = {
    ...(opts?.knifeWatch ?? {}),
  };

  const force = new Set((opts?.forceEnrich ?? []).filter(Boolean));
  const slice: string[] = [];
  const seen = new Set<string>();
  for (const m of [...force, ...mints]) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    slice.push(m);
    // force mints do not count against maxEnrich budget the same way —
    // allow force + maxEnrich headroom capped at maxEnrich + force.size
    if (slice.length >= maxEnrich + force.size) break;
  }

  const denied = new Set(cfg.deniedMints.map((m) => m.trim()).filter(Boolean));

  const rows = await mapPool(slice, enrichConcurrency, async (mint): Promise<EnrichRow> => {
    try {
      if (denied.has(mint)) return null;
      const details = await fetchDexScreenerPairDetails(mint, {
        bypassCache,
        cacheTtlMs: bypassCache ? undefined : cacheTtlMs,
        nowMs,
        allowedDexIds: cfg.entry.allowedDexIds,
      });
      if (!details || !(details.priceUsd != null && details.priceUsd > 0)) return null;

      // Always record Dex mark — including during cooldown / failed gates.
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
      noteStructuralCache(mint, details.priceUsd, metrics, nowMs);

      const dexVerdict = evaluateMildDipEntry(metrics, cfg.entry);
      const stream = streamDipInBand(cfg, mint, nowMs);
      // Structural Dex gates (liq/mcap/age/dex) must pass; dip may come from stream.
      const structuralOk = structuralGatesPass(metrics, cfg);
      const h1RedShallowOk =
        cfg.h1RedShallowEnabled &&
        structuralOk &&
        metrics.priceChange1hPct != null &&
        Number.isFinite(metrics.priceChange1hPct) &&
        metrics.priceChange1hPct <= cfg.h1RedShallowH1MaxPct &&
        metrics.priceChange5mPct != null &&
        Number.isFinite(metrics.priceChange5mPct) &&
        metrics.priceChange5mPct > cfg.h1RedShallowMinDipPct &&
        metrics.priceChange5mPct <= cfg.h1RedShallowMaxDipPct;

      const flatMicroPc5m =
        metrics.priceChange5mPct != null && Number.isFinite(metrics.priceChange5mPct)
          ? metrics.priceChange5mPct
          : null;
      const flatMicroStreamDd =
        stream.drawdownPct != null && Number.isFinite(stream.drawdownPct)
          ? stream.drawdownPct
          : null;
      const flatMicroDipPct =
        flatMicroPc5m != null &&
        flatMicroPc5m > cfg.flatMicroMinDipPct &&
        flatMicroPc5m <= cfg.flatMicroMaxDipPct
          ? flatMicroPc5m
          : flatMicroStreamDd != null &&
              flatMicroStreamDd > cfg.flatMicroMinDipPct &&
              flatMicroStreamDd <= cfg.flatMicroMaxDipPct
            ? flatMicroStreamDd
            : flatMicroPc5m;
      const flatMicroOk =
        cfg.flatMicroDipEnabled &&
        structuralOk &&
        evaluateFlatMicroDip({
          priceChange5mPct: flatMicroDipPct,
          priceChange1hPct: metrics.priceChange1hPct,
          minDipPct: cfg.flatMicroMinDipPct,
          maxDipPct: cfg.flatMicroMaxDipPct,
          h1MinPct: cfg.flatMicroH1MinPct,
          h1MaxPct: cfg.flatMicroH1MaxPct,
        }).pass;

      let dipSource: MildDipCandidate['dipSource'] | null = null;
      if (dexVerdict.pass && stream.ok) dipSource = 'dex+stream';
      else if (dexVerdict.pass) dipSource = 'dex';
      else if (cfg.streamDipEntryEnabled && stream.ok && structuralOk) {
        // Same as fast-path: do not stream-enter when Dex already healed.
        const dexPc = metrics.priceChange5mPct;
        const dexStillDump =
          !cfg.streamOnlyRequireDexDip ||
          (dexPc != null &&
            Number.isFinite(dexPc) &&
            dexPc <= cfg.streamOnlyDexMaxDipPct);
        if (dexStillDump) dipSource = 'stream';
      } else if (h1RedShallowOk) {
        dipSource = 'h1_red_shallow';
      } else if (flatMicroOk) {
        dipSource = 'flat_micro_dip';
      }

      if (dipSource) {
        // Normal mild path wins — drop any knife watch for this mint.
        const candidateMetrics =
          dipSource === 'stream' && stream.drawdownPct != null
            ? { ...metrics, priceChange5mPct: stream.drawdownPct }
            : dipSource === 'flat_micro_dip' &&
                flatMicroDipPct != null &&
                flatMicroDipPct !== metrics.priceChange5mPct
              ? { ...metrics, priceChange5mPct: flatMicroDipPct }
              : metrics;
        if (!turnDumpAllowsCandidate(cfg, candidateMetrics)) {
          return null;
        }
        const candidate: MildDipCandidate = {
          mint,
          symbol: mint.slice(0, 6),
          priceUsd: details.priceUsd,
          metrics: candidateMetrics,
          dipSource,
        };
        return {
          kind: 'candidate',
          candidate,
          clearEvent: knifeWatchIn[mint]
            ? {
                kind: 'mild_dip_knife_watch_clear',
                mint,
                reason: 'mild_path_pass',
                dipSource,
              }
            : undefined,
        };
      }

      // Deep-knife wait branch (only when mild path did not pass).
      // 1.11.746 — micro tier on ⇒ knife may arm down to microMin mcap ($15k).
      const knifeStructuralOk = structuralGatesPass(metrics, cfg, {
        minMarketCapUsd: knifeStabilizeMinMarketCapUsd({
          entryMinMarketCapUsd: cfg.entry.minMarketCapUsd,
          microPositionUsd: cfg.microPositionUsd,
          microMinMarketCapUsd: cfg.microMinMarketCapUsd,
        }),
      });
      if (!knifeGates.enabled || !knifeStructuralOk) return null;

      const rawStreamDd = mildDipPriceRing.drawdownFromPeakPct(
        mint,
        cfg.cooldownBounceLookbackMs,
        nowMs,
      );
      const knifeDip = resolveKnifeDipPct(metrics.priceChange5mPct, rawStreamDd);
      const prev = knifeWatchIn[mint];
      const inKnifeNow = isKnifeDipPct(knifeDip, knifeGates);

      if (!prev && !inKnifeNow) return null;

      // Still watching previously detected knife even if Dex pc5m recovered some.
      if (!prev && knifeDip == null) return null;

      const peak = mildDipPriceRing.maxPrice(mint, cfg.cooldownBounceLookbackMs, nowMs);
      const watch = upsertKnifeWatch(prev, {
        nowMs,
        priceUsd: details.priceUsd,
        dipPct: knifeDip ?? prev!.knifeDipPct,
        peakPriceUsd: peak?.priceUsd ?? null,
      });

      const ready = evaluateKnifeStabilizeReady(
        watch,
        knifeGates,
        nowMs,
        details.priceUsd,
      );

      if (ready.expire) {
        return {
          kind: 'knife_clear',
          mint,
          event: {
            kind: 'mild_dip_knife_watch_expire',
            mint,
            mode: ready.mode,
            bouncePct: ready.bouncePct,
            knifeDipPct: watch.knifeDipPct,
            troughPriceUsd: watch.troughPriceUsd,
            reasons: ready.reasons,
          },
        };
      }

      const started = !prev;
      const event = started
        ? {
            kind: 'mild_dip_knife_watch_start',
            mint,
            knifeDipPct: watch.knifeDipPct,
            priceUsd: details.priceUsd,
            troughPriceUsd: watch.troughPriceUsd,
            peakPriceUsd: watch.peakPriceUsd,
            waitMs: knifeGates.waitMs,
          }
        : undefined;

      if (ready.ready) {
        const notify = !(watch.readyNotifiedAtMs != null && watch.readyNotifiedAtMs > 0);
        const readyWatch: KnifeWatchEntry = notify
          ? { ...watch, readyNotifiedAtMs: nowMs }
          : watch;
        const knifeMetrics = {
          ...metrics,
          // Surface knife depth for journaling / prebuy context.
          priceChange5mPct: readyWatch.knifeDipPct,
        };
        if (!turnDumpAllowsCandidate(cfg, knifeMetrics)) {
          return { kind: 'knife', mint, watch: readyWatch, event: undefined };
        }
        return {
          kind: 'knife',
          mint,
          watch: readyWatch,
          event: notify
            ? {
                kind: 'mild_dip_knife_ready',
                mint,
                mode: ready.mode,
                bouncePct: ready.bouncePct,
                knifeDipPct: readyWatch.knifeDipPct,
                troughPriceUsd: readyWatch.troughPriceUsd,
                priceUsd: details.priceUsd,
                reasons: ready.reasons,
                ageMs: nowMs - readyWatch.detectedAtMs,
              }
            : undefined,
          candidate: {
            mint,
            symbol: mint.slice(0, 6),
            priceUsd: details.priceUsd,
            metrics: knifeMetrics,
            dipSource: 'knife_stabilize',
            knifeMode: ready.mode ?? undefined,
            knifeBouncePct: ready.bouncePct,
            knifeWatch: readyWatch,
          },
        };
      }

      return { kind: 'knife', mint, watch, event };
    } catch {
      return null;
    }
  });

  const candidates: MildDipCandidate[] = [];
  const knifeWatch: Record<string, KnifeWatchEntry> = { ...knifeWatchIn };
  const knifeEvents: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    if (!row) continue;
    if (row.kind === 'candidate') {
      candidates.push(row.candidate);
      delete knifeWatch[row.candidate.mint];
      if (row.clearEvent) knifeEvents.push(row.clearEvent);
      continue;
    }
    if (row.kind === 'knife_clear') {
      delete knifeWatch[row.mint];
      knifeEvents.push(row.event);
      continue;
    }
    if (row.kind === 'knife') {
      knifeWatch[row.mint] = row.watch;
      if (row.event) knifeEvents.push(row.event);
      if (row.candidate) {
        candidates.push(row.candidate);
        // Keep watch until buy succeeds / chase expire — a failed prebuy must
        // not restart the 2m wait from scratch.
      }
    }
  }

  // Prefer deeper dips first; knife_stabilize sorts by recorded knife depth.
  candidates.sort(
    (a, b) => (a.metrics.priceChange5mPct ?? 0) - (b.metrics.priceChange5mPct ?? 0),
  );

  return { candidates, knifeWatch, knifeEvents };
}

/** Liq / mcap / age / dex without requiring Dex pc5m. */
function structuralGatesPass(
  metrics: MildDipCandidateMetrics,
  cfg: MildDipConfig,
  opts?: { minMarketCapUsd?: number },
): boolean {
  const g = cfg.entry;
  const minMcap =
    opts?.minMarketCapUsd != null && Number.isFinite(opts.minMarketCapUsd)
      ? opts.minMarketCapUsd
      : g.minMarketCapUsd;
  if (metrics.volume5mUsd == null || !(metrics.volume5mUsd >= g.minVolume5mUsd)) return false;
  if (metrics.liquidityUsd == null || !(metrics.liquidityUsd >= g.minLiquidityUsd)) return false;
  if (metrics.marketCapUsd == null || !(metrics.marketCapUsd >= minMcap)) return false;
  if (metrics.marketCapUsd > g.maxMarketCapUsd) return false;
  if (metrics.pairAgeHours == null || metrics.pairAgeHours < g.minPairAgeHours) return false;
  if (g.maxPairAgeHours > 0 && metrics.pairAgeHours > g.maxPairAgeHours) return false;
  if (g.allowedDexIds.length > 0) {
    const dex = (metrics.dexId ?? '').toLowerCase();
    if (!dex || !g.allowedDexIds.includes(dex)) return false;
  }
  return true;
}
