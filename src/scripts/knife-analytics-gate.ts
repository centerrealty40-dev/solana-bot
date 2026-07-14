/**
 * Knife-catcher analytics gate — reuse Oscar volume/runner guards so we only knife real runners,
 * not wash-inflated low-holder junk.
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { loadPaperTraderConfig, type PaperTraderConfig } from '../papertrader/config.js';
import {
  evaluateVolumeEphemeralGuard,
  fetchVolumeEphemeralContextMap,
} from '../papertrader/discovery/volume-ephemeral-guard.js';
import {
  evaluateVolumeSybilGuard,
  fetchVolumeSybilContextMap,
} from '../papertrader/discovery/volume-sybil-guard.js';
import { isHealthyLiveVolumeSpread } from '../papertrader/discovery/volume-spread-health.js';
import {
  evaluateRunner,
  fetchRunnerContextMap,
  type RunnerWindowFeatures,
} from '../papertrader/discovery/runner-mode.js';
import type { SnapshotCandidateRow } from '../papertrader/types.js';

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

function envNum(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export interface KnifeAnalyticsConfig {
  enabled: boolean;
  watchlistPoolMult: number;
  minHolderCount: number;
  /**
   * When holder data is missing (holder_count = 0, e.g. pump.fun mints not yet in `tokens`),
   * skip the min-holder floor instead of hard-rejecting. The floor is meant to filter
   * KNOWN low-holder junk, not unknown data — rejecting on 0 nukes the whole watchlist.
   */
  holderGateSkipWhenUnknown: boolean;
  maxVolPerHolder1hUsd: number;
  minAgeMin: number;
  maxAgeMin: number;
  requireHealthyVolSpread: boolean;
  volumeSybilEnabled: boolean;
  volumeEphemeralEnabled: boolean;
  runnerGateEnabled: boolean;
  minMcapUsd: number;
  maxMcapUsd: number;
  minVol1hUsd: number;
  minVol12hUsd: number;
  velocityMinX: number;
  minVol5mPeak1hUsd: number;
  bs1hMin: number;
  bs12hMin: number;
  liqVsP25Min: number;
  priceHoldMin: number;
  minLiqUsd: number;
  staleVolRatioMax: number;
  minPgSamples24h: number;
}

export function loadKnifeAnalyticsConfig(env: NodeJS.ProcessEnv = process.env): KnifeAnalyticsConfig {
  return {
    enabled: envBool(env.KNIFE_ANALYTICS_ENABLED, true),
    watchlistPoolMult: Math.max(2, Math.round(envNum(env.KNIFE_WATCHLIST_POOL_MULT, 8))),
    minHolderCount: Math.round(envNum(env.KNIFE_MIN_HOLDER_COUNT, 3000)),
    holderGateSkipWhenUnknown: envBool(env.KNIFE_HOLDER_GATE_SKIP_WHEN_UNKNOWN, true),
    maxVolPerHolder1hUsd: envNum(env.KNIFE_MAX_VOL_PER_HOLDER_1H_USD, 50),
    minAgeMin: Math.round(envNum(env.KNIFE_MIN_AGE_MIN, 720)),
    maxAgeMin: Math.round(envNum(env.KNIFE_MAX_AGE_MIN, 2880)),
    requireHealthyVolSpread: envBool(env.KNIFE_REQUIRE_HEALTHY_VOL_SPREAD, true),
    volumeSybilEnabled: envBool(env.KNIFE_VOLUME_SYBIL_GUARD_ENABLED, true),
    volumeEphemeralEnabled: envBool(env.KNIFE_VOLUME_EPHEMERAL_GUARD_ENABLED, true),
    runnerGateEnabled: envBool(env.KNIFE_RUNNER_GATE_ENABLED, true),
    minMcapUsd: envNum(env.KNIFE_MIN_MCAP_USD, 1_000_000),
    maxMcapUsd: envNum(env.KNIFE_MAX_MCAP_USD, 30_000_000),
    minVol1hUsd: envNum(env.KNIFE_RUNNER_MIN_VOL_1H_USD, 60_000),
    minVol12hUsd: envNum(env.KNIFE_RUNNER_MIN_VOL_12H_USD, 400_000),
    velocityMinX: envNum(env.KNIFE_RUNNER_VELOCITY_MIN_X, 1.5),
    minVol5mPeak1hUsd: envNum(env.KNIFE_RUNNER_MIN_VOL_5M_PEAK_1H_USD, 20_000),
    bs1hMin: envNum(env.KNIFE_RUNNER_BS_1H_MIN, 0.95),
    bs12hMin: envNum(env.KNIFE_RUNNER_BS_12H_MIN, 1.0),
    liqVsP25Min: envNum(env.KNIFE_RUNNER_LIQ_VS_P25_MIN, 0.85),
    priceHoldMin: envNum(env.KNIFE_RUNNER_PRICE_HOLD_MIN, 0.6),
    minLiqUsd: envNum(env.KNIFE_MIN_LIQ_USD, 80_000),
    staleVolRatioMax: envNum(env.KNIFE_RUNNER_STALE_VOL_RATIO_MAX, 0.5),
    minPgSamples24h: Math.round(envNum(env.KNIFE_RUNNER_MIN_PG_SAMPLES_24H, 36)),
  };
}

export function buildKnifeGuardPaperCfg(analytics: KnifeAnalyticsConfig): PaperTraderConfig {
  const base = loadPaperTraderConfig();
  return {
    ...base,
    volumeSybilGuardEnabled: analytics.volumeSybilEnabled,
    volumeEphemeralGuardEnabled: analytics.volumeEphemeralEnabled,
    runnerModeEnabled: analytics.runnerGateEnabled,
    runnerMinMcapUsd: analytics.minMcapUsd,
    runnerMaxMcapUsd: analytics.maxMcapUsd,
    runnerMinVol1hUsd: analytics.minVol1hUsd,
    runnerMinVol12hUsd: analytics.minVol12hUsd,
    runnerVelocityMinX: analytics.velocityMinX,
    runnerMinVol5mPeak1hUsd: analytics.minVol5mPeak1hUsd,
    runnerBs1hMin: analytics.bs1hMin,
    runnerBs12hMin: analytics.bs12hMin,
    runnerLiqVsP25Min: analytics.liqVsP25Min,
    runnerPriceHoldMin: analytics.priceHoldMin,
    runnerMinLiqUsd: analytics.minLiqUsd,
    runnerStaleVolRatioMax: analytics.staleVolRatioMax,
    runnerMinPgSamples24h: analytics.minPgSamples24h,
  };
}

export type KnifeAnalyticsVerdict = {
  pass: boolean;
  reasons: string[];
  holders: number;
  vol1hUsd: number;
  volPerHolder1h: number | null;
  mcapUsd: number;
};

export function evaluateKnifeHolderWash(
  analytics: KnifeAnalyticsConfig,
  row: SnapshotCandidateRow,
): string[] {
  const reasons: string[] = [];
  const holders = Number(row.holder_count ?? 0);
  const vol1h = Number(row.volume_1h ?? 0);
  const ageMin = Number(row.token_age_min ?? 0);
  const mcapUsd = Number(row.market_cap_usd ?? 0);

  if (analytics.minMcapUsd > 0 && mcapUsd > 0 && mcapUsd < analytics.minMcapUsd) {
    reasons.push(`knife_mcap<${analytics.minMcapUsd}($${Math.round(mcapUsd)})`);
  }
  if (analytics.maxMcapUsd > 0 && mcapUsd > analytics.maxMcapUsd) {
    reasons.push(`knife_mcap>${analytics.maxMcapUsd}($${Math.round(mcapUsd)})`);
  }

  const holderDataMissing = !(holders > 0);
  if (
    analytics.minHolderCount > 0 &&
    !(holderDataMissing && analytics.holderGateSkipWhenUnknown) &&
    holders < analytics.minHolderCount
  ) {
    reasons.push(`knife_holders<${analytics.minHolderCount}(${holders})`);
  }
  if (analytics.maxVolPerHolder1hUsd > 0 && holders > 0 && vol1h > 0) {
    const vph = vol1h / holders;
    if (vph > analytics.maxVolPerHolder1hUsd) {
      reasons.push(
        `knife_vol_per_holder>${analytics.maxVolPerHolder1hUsd}($${Math.round(vph)}/holder,vol1h=$${Math.round(vol1h)},holders=${holders})`,
      );
    }
  }
  if (analytics.minAgeMin > 0 && ageMin < analytics.minAgeMin) {
    reasons.push(`knife_age<${analytics.minAgeMin}m(${Math.round(ageMin)}m)`);
  }
  if (analytics.maxAgeMin > 0 && ageMin > analytics.maxAgeMin) {
    reasons.push(`knife_age>${analytics.maxAgeMin}m(${Math.round(ageMin)}m)`);
  }
  return reasons;
}

export function evaluateKnifeAnalyticsSync(
  analytics: KnifeAnalyticsConfig,
  paperCfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx: {
    sybil?: ReturnType<typeof evaluateVolumeSybilGuard>;
    ephemeral?: ReturnType<typeof evaluateVolumeEphemeralGuard>;
    runner?: ReturnType<typeof evaluateRunner>;
  },
): KnifeAnalyticsVerdict {
  const reasons: string[] = [...evaluateKnifeHolderWash(analytics, row)];
  const holders = Number(row.holder_count ?? 0);
  const vol1h = Number(row.volume_1h ?? 0);
  const mcapUsd = Number(row.market_cap_usd ?? 0);
  const volPerHolder1h = holders > 0 && vol1h > 0 ? vol1h / holders : null;

  if (analytics.requireHealthyVolSpread && vol1h >= paperCfg.volumeGuardNewMintVol1hWashMinUsd) {
    if (!isHealthyLiveVolumeSpread(paperCfg, row)) {
      reasons.push('knife_unhealthy_vol_spread');
    }
  }

  if (analytics.volumeSybilEnabled && ctx.sybil?.blocked) {
    reasons.push(...ctx.sybil.blockedReasons);
  }
  if (analytics.volumeEphemeralEnabled && ctx.ephemeral?.blocked) {
    reasons.push(...ctx.ephemeral.blockedReasons);
  }
  if (analytics.runnerGateEnabled && ctx.runner && !ctx.runner.pass) {
    reasons.push(...ctx.runner.reasons.map((r) => `knife_${r}`));
  }

  return {
    pass: reasons.length === 0,
    reasons,
    holders,
    vol1hUsd: vol1h,
    volPerHolder1h,
    mcapUsd,
  };
}

export interface KnifeWatchlistCandidate extends SnapshotCandidateRow {
  vol_rank: number;
}

export async function fetchKnifeWatchlistPool(
  lookbackMin: number,
  minVol1hUsd: number,
  poolSize: number,
): Promise<KnifeWatchlistCandidate[]> {
  const lookback = Math.max(5, Math.min(180, lookbackMin));
  const limit = Math.max(1, Math.min(200, poolSize));
  const rows = (await db.execute(dsql.raw(`
    WITH latest AS (
      SELECT DISTINCT ON (s.base_mint)
        s.base_mint AS mint,
        s.price_usd,
        s.liquidity_usd,
        s.volume_5m,
        s.volume_1h,
        s.buys_5m,
        s.sells_5m,
        COALESCE(s.market_cap_usd, s.fdv_usd, 0)::float AS market_cap_usd,
        COALESCE(t.holder_count, 0)::int AS holder_count,
        EXTRACT(EPOCH FROM (now() - COALESCE(s.launch_ts, t.first_seen_at))) / 60.0 AS token_age_min,
        s.pair_address,
        COALESCE(s.source, 'pumpswap') AS source
      FROM pumpswap_pair_snapshots s
      INNER JOIN tokens t ON t.mint = s.base_mint
      WHERE s.ts >= now() - interval '${lookback} minutes'
        AND COALESCE(s.volume_1h, 0) >= ${minVol1hUsd}
        AND COALESCE(s.price_usd, 0) > 0
      ORDER BY s.base_mint, s.ts DESC
    )
    SELECT *, ROW_NUMBER() OVER (ORDER BY volume_1h DESC) AS vol_rank
    FROM latest
    ORDER BY volume_1h DESC
    LIMIT ${limit}
  `))) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    mint: String(r.mint ?? ''),
    symbol: String(r.mint ?? '').slice(0, 8),
    ts: new Date(),
    launch_ts: null,
    age_min: r.token_age_min != null ? Number(r.token_age_min) : null,
    price_usd: Number(r.price_usd ?? 0),
    liquidity_usd: Number(r.liquidity_usd ?? 0),
    volume_5m: Number(r.volume_5m ?? 0),
    volume_1h: Number(r.volume_1h ?? 0),
    buys_5m: Number(r.buys_5m ?? 0),
    sells_5m: Number(r.sells_5m ?? 0),
    market_cap_usd: r.market_cap_usd != null ? Number(r.market_cap_usd) : null,
    holder_count: Number(r.holder_count ?? 0),
    token_age_min: Number(r.token_age_min ?? 0),
    pair_address: r.pair_address != null ? String(r.pair_address) : null,
    source: String(r.source ?? 'pumpswap'),
    vol_rank: Number(r.vol_rank ?? 0),
  }));
}

export type KnifeWatchlistFilterResult = {
  mints: string[];
  passed: Array<{ mint: string; verdict: KnifeAnalyticsVerdict }>;
  rejected: Array<{ mint: string; verdict: KnifeAnalyticsVerdict }>;
};

export async function filterKnifeWatchlist(
  analytics: KnifeAnalyticsConfig,
  paperCfg: PaperTraderConfig,
  lookbackMin: number,
  minVol1hUsd: number,
  topN: number,
): Promise<KnifeWatchlistFilterResult> {
  const poolSize = Math.max(topN, topN * analytics.watchlistPoolMult);
  const pool = await fetchKnifeWatchlistPool(lookbackMin, minVol1hUsd, poolSize);
  if (!analytics.enabled) {
    const mints = pool.slice(0, topN).map((r) => r.mint).filter(Boolean);
    return { mints, passed: [], rejected: [] };
  }

  const sybilMap = await fetchVolumeSybilContextMap(paperCfg, pool);
  const ephemeralMap = await fetchVolumeEphemeralContextMap(paperCfg, pool);
  const runnerMap = await fetchRunnerContextMap(paperCfg, pool);

  const passed: KnifeWatchlistFilterResult['passed'] = [];
  const rejected: KnifeWatchlistFilterResult['rejected'] = [];

  for (const row of pool) {
    const sybilCtx = sybilMap.get(row.mint);
    const ephemeralCtx = ephemeralMap.get(row.mint);
    const runnerCtx = runnerMap.get(row.mint) as RunnerWindowFeatures | undefined;
    const verdict = evaluateKnifeAnalyticsSync(analytics, paperCfg, row, {
      sybil: evaluateVolumeSybilGuard(paperCfg, row, sybilCtx),
      ephemeral: evaluateVolumeEphemeralGuard(paperCfg, row, ephemeralCtx),
      runner: evaluateRunner(paperCfg, row, runnerCtx),
    });
    if (verdict.pass) passed.push({ mint: row.mint, verdict });
    else rejected.push({ mint: row.mint, verdict });
  }

  passed.sort((a, b) => {
    const av = pool.find((r) => r.mint === a.mint)?.volume_1h ?? 0;
    const bv = pool.find((r) => r.mint === b.mint)?.volume_1h ?? 0;
    return bv - av;
  });

  return {
    mints: passed.slice(0, topN).map((p) => p.mint),
    passed,
    rejected,
  };
}

/** In-memory cache: mint -> last analytics verdict from watchlist refresh. */
const analyticsCache = new Map<string, { verdict: KnifeAnalyticsVerdict; tsMs: number }>();

export function cacheKnifeAnalyticsVerdict(mint: string, verdict: KnifeAnalyticsVerdict, tsMs = Date.now()): void {
  analyticsCache.set(mint, { verdict, tsMs });
}

export function getCachedKnifeAnalyticsVerdict(mint: string, maxAgeMs = 300_000): KnifeAnalyticsVerdict | null {
  const c = analyticsCache.get(mint);
  if (!c) return null;
  if (Date.now() - c.tsMs > maxAgeMs) return null;
  return c.verdict;
}

export function isKnifeEntryAllowed(mint: string, analytics: KnifeAnalyticsConfig): boolean {
  if (!analytics.enabled) return true;
  const v = getCachedKnifeAnalyticsVerdict(mint);
  return v?.pass === true;
}

export function __resetKnifeAnalyticsCacheForTests(): void {
  analyticsCache.clear();
}
