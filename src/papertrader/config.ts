import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { QuoteResilience } from './pricing/jupiter-quote-resilience.js';
import type { DexId } from './types.js';
import { isLiveLeraTradingStrategyId } from '../preset-c/live-oscar-family.js';
import {
  loadPervyyVystrelConfig,
  type PervyyVystrelConfig,
} from './live-oscar-pervyy-vystrel-config.js';

const StrategyKindSchema = z.enum(['fresh', 'dip', 'smart_lottery', 'fresh_validated']);

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

/** `SHYFT_SHADOW_ENABLED` (preferred) or legacy `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED`. */
function resolveShyftShadowEnabledFromEnv(): boolean {
  if (process.env.SHYFT_SHADOW_ENABLED != null && process.env.SHYFT_SHADOW_ENABLED !== '') {
    return envBool(process.env.SHYFT_SHADOW_ENABLED, false);
  }
  return envBool(process.env.PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED, false);
}

/** `SHYFT_STREAM_ENABLED`; when unset follows shadow enabled (legacy compat). */
function resolveShyftStreamEnabledFromEnv(shadowEnabled: boolean): boolean {
  if (process.env.SHYFT_STREAM_ENABLED != null && process.env.SHYFT_STREAM_ENABLED !== '') {
    return envBool(process.env.SHYFT_STREAM_ENABLED, false);
  }
  return shadowEnabled;
}

function envOptNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 1.11.167: восходящий sellFraction-профиль, заданный CSV (e.g. `0.10,0.20,0.30,0.30,0.30`).
 * Каждый элемент — доля remainingFraction, которую TP-grid продаёт на k-й ступени
 * (k=1..); если ступеней больше, чем длина массива — используется последний элемент.
 * Пустая/невалидная строка → [] (используется плоский tpGridSellFraction).
 */
function parseTpGridSellFractionProfile(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  const s = String(v).trim();
  if (!s) return [];
  const parts = s.split(',').map((p) => Number(p.trim()));
  const out: number[] = [];
  for (const n of parts) {
    if (!Number.isFinite(n)) return [];
    if (n < 0 || n > 1) return [];
    out.push(n);
  }
  return out;
}

/** CSV minutes, e.g. `120,360,720`. Empty → `[primaryMin]` only (legacy single-window dip). */
export function resolveDipLookbackWindows(primaryMin: number, csv: string): number[] {
  const t = csv.trim();
  if (!t) return [primaryMin];
  const nums = t
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  return uniq.length ? uniq : [primaryMin];
}

/** Окна только для recovery veto (без fallback на primary). */
export function resolveRecoveryVetoWindows(csv: string): number[] {
  const t = csv.trim();
  if (!t) return [];
  const nums = t
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => a - b);
}

const ConfigSchema = z.object({
  strategyId: z.string().default('paper_v1'),
  strategyKind: StrategyKindSchema.default('fresh'),
  storePath: z.string().default('/tmp/paper-trades.jsonl'),
  discoveryIntervalMs: z.coerce.number().int().positive().default(10_000),
  /** Hard cap for awaiting one discovery tick; does not cancel the in-flight tick (see main.ts mutex). */
  discoveryTickTimeoutMs: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  trackIntervalMs: z.coerce.number().int().positive().default(30_000),
  followupTickMs: z.coerce.number().int().positive().default(30_000),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(10_000),
  solPriceRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  btcContextRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  positionUsd: z.coerce.number().positive().default(100),
  /**
   * Доля **первой** ноги входа от `positionUsd` (1 = как раньше — полная позиция одним свопом).
   * Live Oscar legacy scale-in: при < 1 и `LIVE_ENTRY_SCALE_IN_ENABLED` вторая нога исполняется отдельно в трекере.
   */
  entryFirstLegFraction: z.coerce.number().min(0.01).max(1).default(1),
  /** Live Oscar staged entry: optional signal anchor + timed add-on legs vs signal price (see `liveStagedEntry*`). */
  liveStagedEntryEnabled: z.boolean().default(false),
  /**
   * % drawdown **from signal price** required before the **first cash leg** opens (`0` = first leg at current price ≤ anchor).
   * Add-on legs use `liveStagedEntrySecondDropPct` / `Third`. Prod PM2 (1.11.494): immediate leg-1 ($200), leg-2 @ −5%, leg-3 @ −10% ($300).
   */
  liveStagedEntryFirstDropPct: z.coerce.number().min(0).max(90).default(0),
  liveStagedEntrySecondDropPct: z.coerce.number().min(0).max(90).default(14),
  liveStagedEntryThirdDropPct: z.coerce.number().min(0).max(90).default(0),
  liveStagedEntryKillDropPct: z.coerce.number().min(0).max(95).default(25),
  liveStagedEntryFirstLegUsd: z.coerce.number().nonnegative().default(400),
  liveStagedEntrySecondLegUsd: z.coerce.number().nonnegative().default(1000),
  liveStagedEntryThirdLegUsd: z.coerce.number().nonnegative().default(1000),
  /** 0 = no TTL — staged plan is not dropped by signal age (prod: `PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS=0`). */
  liveStagedEntrySignalTtlMs: z.coerce.number().int().nonnegative().default(0),
  /**
   * Ergonomic entry-wait window for the staged −10%-from-signal trigger, in HOURS.
   * `0` (default) = OFF → behaviour is governed solely by `liveStagedEntrySignalTtlMs`
   * (prod = 0 = no time limit), i.e. byte-for-byte current live behaviour.
   * When `> 0`, it OVERRIDES the staged-signal TTL with `hours * 3_600_000` ms: the staged
   * signal anchor is dropped once it ages past the window without a fill (e.g. `1` = 1h wait).
   * Plumbing only — default preserves today's timing until the owner flips the flag.
   */
  liveStagedEntryWaitHours: z.coerce.number().nonnegative().default(0),
  /** Entry split (NOT averaging): second cash leg after delay if price within band vs leg-1 anchor. */
  liveStagedEntryEntrySplitLegUsd: z.coerce.number().nonnegative().default(500),
  /** Asymmetric split leg-2 USD; `0` = same as leg-1 (symmetric 2× split, backward compat). */
  liveStagedEntryEntrySplitLeg2Usd: z.coerce.number().nonnegative().default(0),
  /** Optional third timed entry-split leg (prod tier: up to 8× split); `0` = two-leg split only. */
  liveStagedEntryEntrySplitLeg3Usd: z.coerce.number().nonnegative().default(0),
  liveStagedEntryEntrySplitLeg4Usd: z.coerce.number().nonnegative().default(0),
  liveStagedEntryEntrySplitLeg5Usd: z.coerce.number().nonnegative().default(0),
  liveStagedEntryEntrySplitLeg6Usd: z.coerce.number().nonnegative().default(0),
  liveStagedEntryEntrySplitLeg7Usd: z.coerce.number().nonnegative().default(0),
  liveStagedEntryEntrySplitLeg8Usd: z.coerce.number().nonnegative().default(0),
  liveStagedEntryEntrySplitDelayMs: z.coerce.number().int().nonnegative().default(10_000),
  liveStagedEntryEntrySplitMaxUpPct: z.coerce.number().min(0).max(50).default(3),
  liveStagedEntryEntrySplitMaxDownPct: z.coerce.number().min(0).max(95).default(10),
  /** When >0: leg-2 split at −N% from signal (replaces delay+corridor). 0 = legacy timed corridor. */
  liveStagedEntryEntrySplitTargetDropPct: z.coerce.number().min(0).max(95).default(0),
  /**
   * Observability only (Stage 0, 1.11.466): warn threshold (ms) for the age of the PG snapshot price
   * used at the entry-decision point. When the polled PG price is older than this, the entry path emits a
   * `live_stale_price_warn` journal event (+ throttled alert). Does **not** change any trading decision.
   * `0` disables the warning. Prod default 45000 (collector poll 30s + reeval throttle 15–30s).
   */
  liveOscarStalePriceWarnMs: z.coerce.number().int().nonnegative().default(45_000),
  /**
   * Stage 1.1 (1.11.467) — Shyft Yellowstone gRPC **shadow** stream for live-oscar. When enabled, a
   * single gRPC consumer subscribes to swap txs for watched/open mints and stores an in-memory last
   * stream price. At the entry / MTM comparison points a `live_shyft_shadow_price` journal record is
   * written next to the PG price to measure how far PG lags behind the stream. **Observability only —
   * the stream price never feeds a gate / eval / execution decision.** Default OFF (byte-for-byte prod).
   * Alias: `SHYFT_SHADOW_ENABLED` (preferred) or legacy `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED`.
   */
  liveOscarShyftShadowEnabled: z.boolean().default(false),
  /**
   * Start the Yellowstone gRPC consumer (`SHYFT_STREAM_ENABLED`). When unset, follows shadow enabled.
   * Shadow journal can be ON while stream is OFF (no observations until stream connects).
   */
  shyftStreamEnabled: z.boolean().default(false),
  /** Max age (ms) a stored stream price may have to still be paired at a comparison point. */
  liveOscarShyftShadowMaxAgeMs: z.coerce.number().int().positive().default(60_000),
  /** Cap on `accountInclude` filter size (narrow, never program-wide firehose). */
  liveOscarShyftShadowMaxMints: z.coerce.number().int().positive().max(2_000).default(256),
  /** After gRPC connect, suppress mint-set resubscribes for this many ms (boot churn). */
  liveOscarShyftShadowConnectGraceMs: z.coerce.number().int().nonnegative().default(15_000),
  /**
   * Conservative shadow rollout: subscribe only to **open** mints (not discovery candidates).
   * Reduces mint-set churn / reconnect storms. Default ON for live-oscar shadow mode.
   */
  liveOscarShyftShadowOpenMintsOnly: z.boolean().default(true),
  /**
   * Stage 1.2 (1.11.468) — use the Shyft **stream** price as PRIMARY for live-oscar decision points
   * (open-position MTM and discovery dip-eval), with a `shyftMaxStaleMs` freshness-gate and PG/Jupiter
   * **fallback** when the stream price is disabled / unseen / stale / non-positive. Master gate; when
   * OFF the price source is byte-for-byte the current PG/Jupiter path. Requires the Stage 1.1 shadow
   * consumer running (`liveOscarShyftShadowEnabled` + `SHYFT_GRPC_TOKEN`) to populate stream prices.
   * Default OFF.
   */
  shyftPricePrimaryEnabled: z.boolean().default(false),
  /** Stage 1.2 scope: apply stream-primary to open-position MTM (only active when master ON). */
  shyftPricePrimaryMtmEnabled: z.boolean().default(true),
  /** Stage 1.2 scope: apply stream-primary to discovery dip-eval (only active when master ON). Default OFF (MTM-first rollout). */
  shyftPricePrimaryDiscoveryEnabled: z.boolean().default(false),
  /** Stage 1.2 freshness-gate (ms): max age of a stream price to accept it as primary. */
  shyftMaxStaleMs: z.coerce.number().int().positive().default(5_000),
  /**
   * Stage 1.3 (1.11.469) — resolve discovery-candidate mcap/liq from the Shyft DeFi API
   * (`/v0/pools/get_by_token`) with a TTL cache + **fallback** to the current PG/pump.fun source.
   * Used to override `refMcap` (tier resolution) + the snapshot mcap/liq gate inputs on candidates.
   * Default OFF; when OFF the mcap/liq source is byte-for-byte the current PG path. Needs
   * `SHYFT_DEFI_API_KEY` (or `SHYFT_API_KEY`) in `.env`; on any failure falls back to PG.
   */
  shyftDefiMcapEnabled: z.boolean().default(false),
  /** Stage 1.3 TTL (ms) for the DeFi mcap/liq in-memory cache (limits req/s burst). */
  shyftDefiMcapTtlMs: z.coerce.number().int().positive().default(12_000),
  /**
   * Shyft Token API holder-count fallback when QN live resolve fails or per-tick budget is exhausted.
   * `GET /sol/v1/token/get_owners` with `SHYFT_API_KEY`. Default ON when min holder gate is used.
   */
  shyftHoldersEnabled: z.boolean().default(true),
  shyftHoldersTtlMs: z.coerce.number().int().positive().default(90_000),
  shyftHoldersTimeoutMs: z.coerce.number().int().positive().default(4_000),
  /**
   * Birdeye REST primary for discovery eval price/mcap/vol (Birdeye → DexScreener → PG).
   * Default OFF; needs `BIRDEYE_API_KEY`. Independent of Shyft stream-primary.
   */
  birdeyePrimaryEnabled: z.boolean().default(false),
  /** TTL (ms) for Birdeye market-data in-memory cache per mint. */
  birdeyeMarketTtlMs: z.coerce.number().int().positive().default(12_000),
  /** Freshness gate (ms): max age of a Birdeye quote to accept as primary over PG. */
  birdeyeMaxStaleMs: z.coerce.number().int().positive().default(15_000),
  /** Emit `birdeye_coverage_gap` when PG snapshot age exceeds this and REST fallbacks miss. */
  birdeyeCoverageGapMinMs: z.coerce.number().int().positive().default(5 * 60_000),
  /** Try Birdeye batch endpoint (`market-data/multiple`, Business tier). Default OFF (Lite uses per-mint). */
  birdeyeBatchEnabled: z.boolean().default(false),
  /** Min ms after entry split leg 1 before staged averaging (−7%) is evaluated. */
  liveStagedEntryAvgCooldownMs: z.coerce.number().int().nonnegative().default(180_000),
  /** Min ms after first staged avg before second avg (−14%). */
  liveStagedEntryAvgSecondCooldownMs: z.coerce.number().int().nonnegative().default(300_000),
  /**
   * Down-add discipline (anti «downhill runner»): block staged averaging-down legs once the position
   * is older than this many ms from the first entry leg. Prevents throwing fresh capital into a coin
   * that has been bleeding for hours (backtest: deep/late adds are the main money pit). `0` disables.
   * Env `PAPER_LIVE_STAGED_AVG_MAX_AGE_MS` (default 14400000 = 4h).
   */
  liveStagedAvgMaxAgeMs: z.coerce.number().int().nonnegative().default(14_400_000),
  /**
   * Down-add discipline depth floor: block staged averaging-down when drop vs signal is at or beyond
   * this %. Keeps shallow recovery adds, cuts the deep adds (−20%+) that historically rode to killstop.
   * `0` disables. Env `PAPER_LIVE_STAGED_AVG_MAX_DEPTH_PCT` (default 20).
   */
  liveStagedAvgMaxDepthPct: z.coerce.number().min(0).max(95).default(20),
  /**
   * Shadow-only: compute a proposed dynamic kill-stop + midpoint DCA from PG `*_pair_snapshots` history.
   * Does **not** affect tracker exits yet — only stamps `OpenTrade.dynamicKillstopShadow` + JSONL mirror fields.
   */
  dynamicKillstopShadowEnabled: z.boolean().default(false),
  dynamicKillstopShadowWindowDays: z.coerce.number().int().min(1).max(60).default(14),
  dynamicKillstopShadowBufferPct: z.coerce.number().min(0).max(50).default(6),
  dynamicKillstopShadowMinKillDropPct: z.coerce.number().min(0).max(95).default(12),
  dynamicKillstopShadowMaxKillDropPct: z.coerce.number().min(1).max(95).default(28),
  dynamicKillstopShadowSupportClusterPct: z.coerce.number().min(0.1).max(20).default(3),
  dynamicKillstopShadowMinTouches: z.coerce.number().int().min(1).max(50).default(2),
  dynamicKillstopShadowMinHourlySamples: z.coerce.number().int().min(8).max(2000).default(72),
  btcMints: z
    .string()
    .default(
      '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E,3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh,7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    )
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  feeBpsPumpfun: z.coerce.number().nonnegative().default(100),
  feeBpsPumpswap: z.coerce.number().nonnegative().default(30),
  feeBpsRaydium: z.coerce.number().nonnegative().default(25),
  feeBpsOrca: z.coerce.number().nonnegative().default(10),
  feeBpsMeteora: z.coerce.number().nonnegative().default(20),
  feeBpsMoonshot: z.coerce.number().nonnegative().default(100),
  slipBaseBpsPumpfun: z.coerce.number().nonnegative().default(200),
  slipBaseBpsPumpswap: z.coerce.number().nonnegative().default(50),
  slipBaseBpsRaydium: z.coerce.number().nonnegative().default(50),
  slipBaseBpsOrca: z.coerce.number().nonnegative().default(50),
  slipBaseBpsMeteora: z.coerce.number().nonnegative().default(50),
  slipBaseBpsMoonshot: z.coerce.number().nonnegative().default(150),
  slipLiquidityCoef: z.coerce.number().nonnegative().default(1.0),
  networkFeeUsd: z.coerce.number().nonnegative().default(0.05),
  fillRatePct: z.coerce.number().min(0).max(100).default(100),
  feeBpsPerSide: z.coerce.number().nonnegative().default(100),
  slippageBpsPerSide: z.coerce.number().nonnegative().default(200),
  dryRun: z.boolean().default(false),

  // ---- discovery lanes (W6.3b) ----
  enableLaunchpadLane: z.boolean().default(false),
  enableMigrationLane: z.boolean().default(true),
  enablePostLane: z.boolean().default(true),

  // ---- discovery window (legacy launchpad) ----
  decisionAgeMin: z.coerce.number().int().min(1).max(120).default(7),
  decisionAgeMaxMin: z.coerce.number().int().min(1).max(360).default(12),
  windowStartMin: z.coerce.number().int().min(0).max(60).default(2),
  bcGraduationSol: z.coerce.number().positive().default(85),

  // ---- global gate ----
  globalMinTokenAgeMin: z.coerce.number().nonnegative().default(0),
  globalMinHolderCount: z.coerce.number().int().nonnegative().default(0),
  /** 0 = no cap. Reject candidates when holder_count **exceeds** this (slice below live Oscar higher tier). */
  globalMaxHolderCount: z.coerce.number().int().nonnegative().default(0),

  // ---- snapshot lanes ----
  laneMigMinLiqUsd: z.coerce.number().nonnegative().default(12_000),
  laneMigMinVol5mUsd: z.coerce.number().nonnegative().default(1_800),
  laneMigMinBuys5m: z.coerce.number().int().nonnegative().default(18),
  laneMigMinSells5m: z.coerce.number().int().nonnegative().default(8),
  laneMigMinAgeMin: z.coerce.number().nonnegative().default(2),
  laneMigMaxAgeMin: z.coerce.number().nonnegative().default(25),
  /** 0 = no cap. Upper bound on pool USD liquidity for migration lane snapshot SQL + evaluateSnapshot. */
  laneMigMaxLiqUsd: z.coerce.number().nonnegative().default(0),
  lanePostMinLiqUsd: z.coerce.number().nonnegative().default(15_000),
  lanePostMinVol5mUsd: z.coerce.number().nonnegative().default(2_500),
  /** 0 = no cap. Upper bound on pool `volume_5m` for post lane (strictly below live tier when set). */
  lanePostMaxVol5mUsd: z.coerce.number().nonnegative().default(0),
  lanePostMinBuys5m: z.coerce.number().int().nonnegative().default(16),
  lanePostMinSells5m: z.coerce.number().int().nonnegative().default(10),
  lanePostMinAgeMin: z.coerce.number().nonnegative().default(25),
  lanePostMaxAgeMin: z.coerce.number().nonnegative().default(180),
  /** 0 = no cap. Upper bound on pool USD liquidity for post lane snapshot SQL + evaluateSnapshot. */
  lanePostMaxLiqUsd: z.coerce.number().nonnegative().default(0),
  /** 0 = off. Min COALESCE(market_cap_usd, fdv_usd) on discovery snapshot row before buy eval. */
  discoveryMinMarketCapUsd: z.coerce.number().nonnegative().default(0),
  /** 0 = off. Max ref mcap on discovery snapshot — excludes large caps from SQL pool and eval (saves PG/CPU). */
  discoveryMaxMarketCapUsd: z.coerce.number().nonnegative().default(0),
  /** Live Oscar: micro коридор $500k–$1.3M (2×$150 entry; avg $210 @ −10%; lane default OFF). */
  liveOscarMicroMcapLaneEnabled: z.boolean().default(false),
  liveOscarMicroMcapMinUsd: z.coerce.number().nonnegative().default(500_000),
  liveOscarMicroMcapMaxUsd: z.coerce.number().nonnegative().default(1_300_000),
  liveOscarMicroMcapDipMinDropPct: z.coerce.number().default(-30),
  liveOscarMicroMcapVol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  liveOscarMicroMcapEntrySplitLegUsd: z.coerce.number().positive().default(150),
  liveOscarMicroMcapEntrySplitLeg2Usd: z.coerce.number().nonnegative().default(150),
  liveOscarMicroMcapPositionUsd: z.coerce.number().positive().default(300),
  /** Leg-3 staged avg @ −10% for micro tier; prod uses `liveStagedEntrySecondLegUsd`. */
  liveOscarMicroMcapStagedAvgLegUsd: z.coerce.number().nonnegative().default(210),
  /** Micro tier first staged avg drop % from signal (E+2 parity with prod/low −10%). */
  liveOscarMicroMcapStagedAvgDropPct: z.coerce.number().min(0).max(90).default(10),
  liveOscarMicroMcapDcaLevelsSpec: z.string().default(''),
  /** Live Oscar: узкий коридор $2M–$3M (отдельные dip/vol/размер); ≥$3M = prod tier. */
  liveOscarLowMcapLaneEnabled: z.boolean().default(false),
  liveOscarLowMcapMinUsd: z.coerce.number().nonnegative().default(2_000_000),
  liveOscarLowMcapMaxUsd: z.coerce.number().nonnegative().default(3_000_000),
  liveOscarLowMcapDipMinDropPct: z.coerce.number().default(-30),
  liveOscarLowMcapVol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  /** Prod tier (mcap ≥ maxUsd): near-miss runner corridor — dip −18%, vol1h ≥$100k. */
  liveOscarProdMcapDipMinDropPct: z.coerce.number().default(-18),
  liveOscarProdMcapVol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  /** Prod sub-tier boundary ($3M floor = low max when low lane ON). */
  liveOscarProdMcapBand12MUsd: z.coerce.number().positive().default(12_000_000),
  liveOscarProdMcapMaxUsd3_12: z.coerce.number().positive().default(5_000),
  liveOscarProdMcapMaxUsd12Plus: z.coerce.number().positive().default(5_000),
  /**
   * Optional GLOBAL hard per-position notional ceiling (USD), tier-independent.
   * `0` = off → the per-position cap is the tier plan max. When `> 0`, the effective
   * ceiling is `min(tier plan max, this)` — a blunt lever to cap ALL positions regardless
   * of tier (e.g. force a strict $2–3k max without re-enabling the low-mcap lane).
   */
  liveOscarHardPositionMaxUsd: z.coerce.number().nonnegative().default(0),
  liveOscarLowMcapEntrySplitLegUsd: z.coerce.number().positive().default(1000),
  liveOscarLowMcapEntrySplitLeg2Usd: z.coerce.number().nonnegative().default(1000),
  /** Low tier: optional third entry-split leg; prod uses `liveStagedEntryEntrySplitLeg3Usd`. */
  liveOscarLowMcapEntrySplitLeg3Usd: z.coerce.number().nonnegative().default(0),
  liveOscarLowMcapEntrySplitLeg4Usd: z.coerce.number().nonnegative().default(0),
  liveOscarLowMcapEntrySplitLeg5Usd: z.coerce.number().nonnegative().default(0),
  liveOscarLowMcapPositionUsd: z.coerce.number().positive().default(2000),
  /** Staged avg drop % from signal for low tier (e.g. 10 = −10%). */
  liveOscarLowMcapStagedAvgDropPct: z.coerce.number().min(0).max(90).default(10),
  /** Leg-3 staged avg @ −10% for low tier; prod uses `liveStagedEntrySecondLegUsd`. */
  liveOscarLowMcapStagedAvgLegUsd: z.coerce.number().nonnegative().default(500),
  liveOscarLowMcapStagedAvgSecondDropPct: z.coerce.number().min(0).max(90).default(20),
  liveOscarLowMcapStagedAvgSecondLegUsd: z.coerce.number().nonnegative().default(500),
  liveOscarLowMcapDcaLevelsSpec: z.string().default('-10:0.375,-20:0.375'),
  /**
   * Live Oscar scalp_wave lane: min age 12h (no max), $800k–$30M mcap, shallow dip −8..−15%,
   * one-shot $300, TP +10% / no kill (phase escalation) / timestop 3h. Mutex with prod unless handoff.
   */
  liveOscarScalpWaveLaneEnabled: z.boolean().default(false),
  liveOscarScalpWaveMinAgeMin: z.coerce.number().nonnegative().default(720),
  /** 0 = no upper age cap (prod default). Legacy env may set a max; prefer unset/0. */
  liveOscarScalpWaveMaxAgeMin: z.coerce.number().nonnegative().default(0),
  liveOscarScalpWaveMinMcapUsd: z.coerce.number().nonnegative().default(800_000),
  liveOscarScalpWaveMaxMcapUsd: z.coerce.number().positive().default(30_000_000),
  liveOscarScalpWaveDipMinDropPct: z.coerce.number().default(-15),
  liveOscarScalpWaveDipMaxDropPct: z.coerce.number().default(-8),
  liveOscarScalpWaveMinImpulsePct: z.coerce.number().nonnegative().default(8),
  liveOscarScalpWaveVol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  liveOscarScalpWavePositionUsd: z.coerce.number().positive().default(300),
  liveOscarScalpWaveMaxConcurrent: z.coerce.number().int().min(1).max(10).default(3),
  liveOscarScalpWaveTpPct: z.coerce.number().min(0.01).max(1).default(0.1),
  liveOscarScalpWaveKillPct: z.coerce.number().min(0.01).max(0.5).default(0.1),
  liveOscarScalpWaveTimeStopHours: z.coerce.number().min(0.5).max(24).default(3),
  /**
   * Fast-dip scalp lane (1.11.x) — DISABLED by default. Backtest (60d, pumpswap 60s bars):
   * entry ≤ −25% vs short rolling-high window, single-shot (no DCA), hard SL, 30m time-stop,
   * front-loaded TP ladder + small trailing runner. Net ≈ +4.4%/trade @2% round-trip, win ~55%.
   * Only pumpswap has the 60s cadence needed; other lanes' 120s bars are too coarse.
   */
  liveOscarFastDipScalpLaneEnabled: z.boolean().default(false),
  /** Short rolling-high dip window (min) — the window our prod detector lacks (prod = 120/360/720). */
  liveOscarFastDipScalpDipWindowMin: z.coerce.number().int().min(1).max(60).default(15),
  /** Entry: current price must be at/below this % vs short-window high (deep, fast flush). */
  liveOscarFastDipScalpDipMinDropPct: z.coerce.number().default(-25),
  /** Reject bottomless knives deeper than this. */
  liveOscarFastDipScalpDipMaxDropPct: z.coerce.number().default(-60),
  liveOscarFastDipScalpMinImpulsePct: z.coerce.number().nonnegative().default(0),
  liveOscarFastDipScalpMinMcapUsd: z.coerce.number().nonnegative().default(3_000_000),
  liveOscarFastDipScalpMaxMcapUsd: z.coerce.number().positive().default(1_000_000_000),
  liveOscarFastDipScalpVol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  /** No 48h prod age gate here — fast flushes happen on fresh momentum coins too. */
  liveOscarFastDipScalpMinAgeMin: z.coerce.number().nonnegative().default(60),
  liveOscarFastDipScalpPositionUsd: z.coerce.number().positive().default(500),
  liveOscarFastDipScalpMaxConcurrent: z.coerce.number().int().min(1).max(10).default(2),
  /** Hard SL as positive fraction (0.15 = −15% from entry). */
  liveOscarFastDipScalpKillPct: z.coerce.number().min(0.01).max(0.9).default(0.15),
  /** Time-stop (min): exit if no TP rung hit by this age. */
  liveOscarFastDipScalpTimeStopMin: z.coerce.number().min(1).max(240).default(30),
  /** TP ladder rungs as fraction gains (e.g. 0.10,0.22). */
  liveOscarFastDipScalpTpRungsPct: z.string().default('0.10,0.22'),
  /** Sell fraction per rung, aligned to rungs (e.g. 0.50,0.30); remainder trails. */
  liveOscarFastDipScalpTpSellFracs: z.string().default('0.50,0.30'),
  /** Trailing runner on remainder: arm at +% gain, exit on step-% drop from peak. */
  liveOscarFastDipScalpTrailArmPct: z.coerce.number().min(0.01).max(2).default(0.18),
  liveOscarFastDipScalpTrailStepPct: z.coerce.number().min(0.01).max(1).default(0.06),
  liveOscarFastDipScalpCooldownMin: z.coerce.number().nonnegative().default(30),
  /**
   * Live Oscar runner_probe lane (tier 2): mcap **≥ $1M** (up to $30M), age 12–48h (720–2880 min),
   * strict runner guards + dip entry, wallet-intel gate, $500 entry parallel to prod.
   * **Tier routing is mcap-first:** strong vol/liq below $1M stays on runner_lite — never promoted here.
   */
  runnerProbeEnabled: z.boolean().default(false),
  runnerProbeMinAgeMin: z.coerce.number().nonnegative().default(720),
  runnerProbeMaxAgeMin: z.coerce.number().nonnegative().default(2880),
  /** 12–24h band requires intel green (§4.3 age relax). */
  runnerProbe12hIntelRequired: z.boolean().default(true),
  runnerProbeMinMcapUsd: z.coerce.number().nonnegative().default(1_000_000),
  runnerProbeMaxMcapUsd: z.coerce.number().positive().default(30_000_000),
  runnerProbePositionUsd: z.coerce.number().positive().default(500),
  runnerProbeMaxConcurrent: z.coerce.number().int().min(1).max(10).default(2),
  runnerProbeMaxExposureUsd: z.coerce.number().positive().default(1000),
  runnerProbeDipMinDropPct: z.coerce.number().default(-20),
  runnerProbeDipMaxDropPct: z.coerce.number().default(-45),
  runnerProbeMinImpulsePct: z.coerce.number().nonnegative().default(12),
  runnerProbeVol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  runnerProbeMinVol1hUsd: z.coerce.number().nonnegative().default(100_000),
  runnerProbeMinVol12hUsd: z.coerce.number().nonnegative().default(400_000),
  runnerProbeVelocityMinX: z.coerce.number().nonnegative().default(1.5),
  runnerProbeMinVol5mPeak1hUsd: z.coerce.number().nonnegative().default(20_000),
  runnerProbeBs1hMin: z.coerce.number().nonnegative().default(0.95),
  runnerProbeBs12hMin: z.coerce.number().nonnegative().default(1.0),
  runnerProbeLiqVsP25Min: z.coerce.number().nonnegative().default(0.85),
  runnerProbePriceHoldMin: z.coerce.number().nonnegative().default(0.6),
  runnerProbeMinLiqUsd: z.coerce.number().nonnegative().default(80_000),
  runnerProbeStaleVolRatioMax: z.coerce.number().nonnegative().default(0.5),
  runnerProbeMinPgSamples24h: z.coerce.number().int().min(0).default(36),
  runnerProbeTpPct: z.coerce.number().min(0.01).max(1).default(0.1),
  runnerProbeKillPct: z.coerce.number().min(0.01).max(0.5).default(0.5),
  runnerProbeTimeStopHours: z.coerce.number().min(0.5).max(48).default(6),
  /** One DCA leg at −25% (+100% of positionUsd, default $500 → max $1000/position). */
  runnerProbeDcaLevelsSpec: z.string().default('-25:1'),
  /**
   * Live Oscar runner_lite lane (tier 1): mcap **$500k – <$1M**, age 12–48h (720–2880 min),
   * relaxed vol gates (vol1h ≥ $60k, vol12h ≥ $200k), 2×$100 entry, optional −25% DCA +⅓, wave_b half8_runner exit.
   * **Mcap band selects lane** — probe-level metrics do not upgrade entry to $500; graduate only when mcap ≥ $1M.
   */
  runnerLiteEnabled: z.boolean().default(false),
  runnerLiteMinAgeMin: z.coerce.number().nonnegative().default(720),
  runnerLiteMaxAgeMin: z.coerce.number().nonnegative().default(2880),
  runnerLite12hIntelRequired: z.boolean().default(false),
  runnerLiteMinMcapUsd: z.coerce.number().nonnegative().default(500_000),
  runnerLiteMaxMcapUsd: z.coerce.number().positive().default(999_999),
  /** Total position cap ($200 = 2×$100 legs). */
  runnerLitePositionUsd: z.coerce.number().positive().default(200),
  runnerLiteLegUsd: z.coerce.number().positive().default(100),
  /** One DCA leg at −25% (+⅓ of positionUsd, default $200 → max ~$266.67/position). */
  runnerLiteDcaLevelsSpec: z.string().default('-25:0.333'),
  runnerLiteMaxConcurrent: z.coerce.number().int().min(1).max(10).default(2),
  runnerLiteMaxExposureUsd: z.coerce.number().positive().default(400),
  runnerLiteDipMinDropPct: z.coerce.number().default(-20),
  runnerLiteDipMaxDropPct: z.coerce.number().default(-45),
  runnerLiteMinImpulsePct: z.coerce.number().nonnegative().default(10),
  runnerLiteVol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  runnerLiteMinVol1hUsd: z.coerce.number().nonnegative().default(100_000),
  runnerLiteMinVol12hUsd: z.coerce.number().nonnegative().default(200_000),
  runnerLiteVelocityMinX: z.coerce.number().nonnegative().default(1.0),
  runnerLiteMinVol5mPeak1hUsd: z.coerce.number().nonnegative().default(10_000),
  runnerLiteBs1hMin: z.coerce.number().nonnegative().default(0.85),
  runnerLiteBs12hMin: z.coerce.number().nonnegative().default(0.9),
  runnerLiteLiqVsP25Min: z.coerce.number().nonnegative().default(0.8),
  runnerLitePriceHoldMin: z.coerce.number().nonnegative().default(0.55),
  runnerLiteMinLiqUsd: z.coerce.number().nonnegative().default(50_000),
  runnerLiteStaleVolRatioMax: z.coerce.number().nonnegative().default(0.35),
  runnerLiteMinPgSamples24h: z.coerce.number().int().min(0).default(24),
  /** Live Oscar coin intelligence overlay (default-OFF; see LIVE_OSCAR_COIN_INTELLIGENCE_SPEC). */
  liveOscarIntelEnabled: z.boolean().default(false),
  liveOscarIntelMode: z.enum(['off', 'shadow', 'advisory', 'gate']).default('off'),
  /** Overrides global mode for runner_probe lane only (`LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE`). */
  liveOscarIntelModeRunnerProbe: z
    .enum(['off', 'shadow', 'advisory', 'gate'])
    .optional(),
  /** Overrides global mode for runner_lite lane (`LIVE_OSCAR_INTEL_MODE_RUNNER_LITE`). */
  liveOscarIntelModeRunnerLite: z
    .enum(['off', 'shadow', 'advisory', 'gate'])
    .optional(),
  /** Overrides global mode for pervyy_vystrel lane (`LIVE_OSCAR_INTEL_MODE_PERVYY_VYSTREL`). */
  liveOscarIntelModePervyyVystrel: z
    .enum(['off', 'shadow', 'advisory', 'gate'])
    .optional(),
  liveOscarIntelWalletGateEnabled: z.boolean().default(false),
  liveOscarIntelFailClosed: z.boolean().default(false),
  liveOscarIntelRequireSwapCoverage: z.boolean().default(false),
  liveOscarIntelEarlyBuyWindowSec: z.coerce.number().int().min(30).max(7200).default(180),
  liveOscarIntelEarlyBuyWalletCap: z.coerce.number().int().min(5).max(300).default(60),
  liveOscarIntelBlockIntelBlockTrade: z.boolean().default(true),
  liveOscarIntelBlockBadTags: z.boolean().default(true),
  liveOscarIntelBlockClusteredWallets: z.boolean().default(true),
  liveOscarIntelBlockScamFarmMeta: z.boolean().default(true),
  /**
   * Lera-only entry on-chain overlay at buy moment (shadow — journals verdict, never blocks).
   * Oscar path untouched for A/B: Oscar = TA only, Lera = TA + on-chain analytics.
   */
  leraEntryOnchainOverlayEnabled: z.boolean().default(false),
  leraEntryOnchainOverlayLookbackSec: z.coerce.number().int().min(30).max(600).default(120),
  leraEntryOnchainOverlayMinSellUsd: z.coerce.number().nonnegative().default(500),
  leraEntryOnchainOverlayLargeSellUsd: z.coerce.number().nonnegative().default(1_500),
  leraEntryOnchainOverlayWhaleDumpMaxAgeSec: z.coerce.number().int().min(10).max(300).default(90),
  leraEntryOnchainOverlayCoordSellWalletMin: z.coerce.number().int().min(2).max(20).default(3),
  leraEntryOnchainOverlayQueryTimeoutMs: z.coerce.number().int().min(100).max(5_000).default(800),
  leraEntryOnchainOverlayBlockIntelBlockTrade: z.boolean().default(true),
  leraEntryOnchainOverlayBlockBadTags: z.boolean().default(true),
  leraEntryOnchainOverlayBlockClusteredWallets: z.boolean().default(true),
  leraEntryOnchainOverlayBlockScamFarmMeta: z.boolean().default(true),
  /** Lera VPS: feed pass-candidate mints to Shyft stream for overlay correlation (observability). */
  leraOnchainOverlayShyftWatchEnabled: z.boolean().default(false),
  /** Telegram when shadow overlay would block but buy still executed (Lera A/B). */
  leraEntryOnchainOverlayTelegramEnabled: z.boolean().default(true),
  /** Max snapshot rows after lane filters (ORDER BY ts DESC). Higher = scan more mints per tick. */
  snapshotCandidateLimit: z.coerce.number().int().min(50).max(5000).default(300),
  /** Min seconds before re-evaluating the same mint in discovery (per process). */
  discoveryReevalSec: z.coerce.number().int().min(5).max(600).default(60),
  /**
   * Live Oscar Risky only: hold a passed entry signal, then re-check the same
   * discovery gates plus price change vs the original signal before opening.
   */
  entryRecheckDelayMs: z.coerce.number().int().min(0).max(3_600_000).default(0),
  entryRecheckMinChangePct: z.coerce.number().min(-99).max(10_000).default(-99),
  entryRecheckMaxChangePct: z.coerce.number().min(-99).max(10_000).default(100),
  snapshotMinBs: z.coerce.number().nonnegative().default(1.0),
  /**
   * Require pair snapshot `volume_5m` to be consistent with `volume_1h` (same row).
   * Fails if hour volume missing/below floor or vol_5m exceeds (vol_1h/12)*mult (spike vs flat hour).
   */
  vol5m1hGuardEnabled: z.boolean().default(false),
  vol1hMinUsd: z.coerce.number().nonnegative().default(100_000),
  /** 0 = no cap. When >0, reject rows whose `volume_1h` **exceeds** this (stay strictly below live tier). */
  vol1hMaxUsd: z.coerce.number().nonnegative().default(0),
  vol5mSpikeMaxMult: z.coerce.number().min(1.01).max(48).default(7),

  // ---- dip detector ----
  dipLookbackMin: z.coerce.number().int().positive().default(60),
  /** Parsed into `dipLookbackWindowsMin` after transform (see `PAPER_DIP_LOOKBACK_WINDOWS_MIN`). */
  dipLookbackWindowsCsv: z.string().default(''),
  dipMinDropPct: z.coerce.number().default(-12),
  dipMaxDropPct: z.coerce.number().default(-45),
  dipMinImpulsePct: z.coerce.number().default(20),
  dipMinAgeMin: z.coerce.number().nonnegative().default(25),

  /**
   * Post-crash fast path (1.11.250): after vol-spike + sharp drop in lookback window,
   * allow entry vs crash peak once stabilized (flat plateau), without waiting for 12h dip.
   */
  postCrashFastPathEnabled: z.boolean().default(false),
  /** PG window to find crash peak + spike (minutes). */
  postCrashFastPathLookbackMin: z.coerce.number().int().min(30).max(720).default(180),
  postCrashFastPathMinPgSamples: z.coerce.number().int().min(0).default(8),
  postCrashFastPathMinDropPct: z.coerce.number().default(-16),
  postCrashFastPathMaxDropPct: z.coerce.number().default(-50),
  /** Min vol5m/(vol1h/12) seen in lookback — confirms there was a crash spike. */
  postCrashFastPathMinVolSpikeMult: z.coerce.number().min(1.5).max(48).default(5),
  /** Wait at least N minutes after crash peak before entry (knife cooldown). */
  postCrashFastPathStabilizeMin: z.coerce.number().int().min(5).max(120).default(25),
  /** Crash must be younger than this (minutes); older → normal dip windows only. */
  postCrashFastPathMaxAgeMin: z.coerce.number().int().min(30).max(720).default(240),
  /** Block if price still falling: 15m change below this (e.g. −8%). */
  postCrashFastPathMaxKnife15mPct: z.coerce.number().default(-8),
  /** Skip local-high-veto on post-crash entries (flat at crash floor). */
  postCrashFastPathBypassLocalHighVeto: z.boolean().default(true),

  dipCooldownMinDefault: z.coerce.number().nonnegative().default(120),
  dipCooldownMinScalp: z.coerce.number().nonnegative().default(20),
  /** После **любого** полного закрытия позиции по mint — пауза повторного входа в тот же mint (часы). 0 = выкл., если заданы минуты. */
  dipLossExitCooldownHours: z.coerce.number().nonnegative().default(0),
  /** То же, в минутах (приоритет над часами при > 0). Env historically `PAPER_DIP_LOSS_EXIT_COOLDOWN_*`. */
  dipLossExitCooldownMinutes: z.coerce.number().nonnegative().default(0),
  /**
   * Включает паузу после полного выхода по mint (profit или loss). When false, минуты/часы не применяются.
   * Env: `PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED` (default true).
   */
  dipLossExitCooldownEnabled: z.boolean().default(true),
  /**
   * Live discovery / hybrid fork: min drop % below last exit before re-entry (0 = off).
   * Env: `LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT` или aliases `PAPER_REENTRY_DIP_BELOW_EXIT_PCT`, `PAPER_REENTRY_MIN_DIP_BELOW_EXIT_PCT`.
   */
  liveReentryMinDropFromLastExitPct: z.coerce.number().nonnegative().max(90).default(0),
  /**
   * Hybrid fork: при цене ≥ lastExit×(1+M%) — bypass dip-wait, стандартные discovery/dip gates.
   * Env: `LIVE_REENTRY_BREAKOUT_ABOVE_EXIT_PCT` или aliases `PAPER_REENTRY_ABORT_DIP_WAIT_ABOVE_EXIT_PCT`, `PAPER_REENTRY_BREAKOUT_ABOVE_EXIT_PCT`.
   */
  liveReentryBreakoutAboveExitPct: z.coerce.number().nonnegative().max(500).default(0),
  /**
   * Hybrid re-entry с `liveReentryMinDropFromLastExitPct`: fork в окне `LIVE_REENTRY_GATE_MAX_AGE_HOURS`
   * (не только post-exit cooldown); legacy price-gap path выкл. при `LIVE_REENTRY_MAX_WAIT_MINUTES` > 0.
   * Env: `LIVE_REENTRY_MAX_WAIT_MINUTES`. `0` = только price-gap без hybrid wrapper.
   */
  liveReentryMaxWaitMinutes: z.coerce.number().nonnegative().max(24 * 60).default(0),
  /** After loss/stress exit: min drop % from last exit (overrides hybrid drop when stricter). */
  liveReentryLossMinDropFromLastExitPct: z.coerce.number().nonnegative().max(90).default(30),
  /** After loss/stress exit: disable hybrid timer-only re-entry (must meet drop gate). */
  liveReentryHybridDisableTimerAfterLoss: z.boolean().default(true),
  /**
   * Re-entry price gate (last exit −N%) — legacy safety cap; основной лимит = post-exit cooldown.
   * Env: `LIVE_REENTRY_GATE_MAX_AGE_HOURS`.
   */
  liveReentryGateMaxAgeHours: z.coerce.number().min(0).max(168).default(4),

  /**
   * After KILLSTOP / stress exit: allow re-entry on modest bounce from short-window low
   * (e.g. mcap 1.8M → 1.87M) when price is far below last exit.
   * Env: `LIVE_STRESS_REENTRY_ENABLED`.
   */
  liveStressReentryEnabled: z.boolean().default(true),
  /** Min drop % from last exit market price to qualify (e.g. 50 = half off exit). */
  liveStressReentryMinDropFromLastExitPct: z.coerce.number().min(0).max(90).default(40),
  /** Max bounce % from local low (30m default window) — veto only above this. */
  liveStressReentryRecoveryVetoMaxBouncePct: z.coerce.number().min(0.1).max(500).default(8),
  /** Only short windows for bounce check (60m low after crash is too stale). */
  liveStressReentryRecoveryVetoMaxWindowMin: z.coerce.number().int().min(0).max(720).default(30),
  /** Relaxed dip max drop when stress re-entry qualifies (e.g. -65 vs -50). */
  liveStressReentryDipMaxDropPct: z.coerce.number().min(-95).max(0).default(-65),

  /**
   * Live JSONL deep audit for whitelist mints: `live_discovery_eval` includes passes; `live_discovery_universe_miss`
   * when mint drops out of snapshot SQL; `live_discovery_tick_skip` on re-eval throttle.
   */
  discoveryDeepAuditJsonl: z.boolean().default(false),
  discoveryDeepAuditWhitelistPath: z.string().optional(),
  discoveryDeepAuditUniverseMissMinMs: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  /** PG lookback for whitelist mint probe (`injectWhitelistDiscoveryCandidates`). */
  whitelistSnapshotLookbackMin: z.coerce.number().int().min(30).max(240).default(60),

  /**
   * Priority discovery tier (1.11.244): 24/7 dip-watch без ops-whitelist.
   * Open positions + near-ready + недавно eval'нутые mint'ы инжектятся в discovery
   * в обход SQL vol5m floor / snapshotCandidateLimit; Jupiter refresh между PG ticks.
   */
  priorityDiscoveryEnabled: z.boolean().default(true),
  priorityDiscoveryReevalSec: z.coerce.number().int().min(5).max(120).default(15),
  priorityDiscoveryLookbackMin: z.coerce.number().int().min(30).max(240).default(120),
  /** Держать mint в priority tier N минут после последнего full eval. */
  priorityDiscoveryRecentEvalMin: z.coerce.number().int().min(30).max(720).default(180),
  priorityDiscoveryMaxMints: z.coerce.number().int().min(10).max(500).default(200),
  priorityDiscoveryJupiterRefreshEnabled: z.boolean().default(true),
  priorityDiscoveryJupiterRefreshMaxPerTick: z.coerce.number().int().min(1).max(50).default(20),
  /** Near-miss dip: Jupiter refresh когда PG dip на gapPct выше порога (minute bucket отстаёт). */
  priorityDiscoveryNearMissJupiterRefreshEnabled: z.boolean().default(true),
  priorityDiscoveryNearMissJupiterGapPct: z.coerce.number().min(0.5).max(12).default(4),
  priorityDiscoveryNearMissJupiterRefreshMaxPerTick: z.coerce.number().int().min(0).max(50).default(15),
  /** Relaxed BS floor for priority dip-watch tier (default 0.85 vs global 0.98). */
  priorityDiscoveryMinBs: z.coerce.number().nonnegative().default(0.85),

  /**
   * Volume-leader tier (1.11.274): top-N mints by peak volume_1h за lookback — guaranteed dip-eval,
   * каноническая пара = max volume (не max liq). Eval-gates (liq/mcap/dip) без изменений.
   */
  volumeLeaderEnabled: z.boolean().default(false),
  volumeLeaderTopN: z.coerce.number().int().min(5).max(100).default(50),
  volumeLeaderReevalSec: z.coerce.number().int().min(5).max(120).default(15),
  volumeLeaderLookbackHours: z.coerce.number().int().min(1).max(48).default(24),
  volumeLeaderQueryCacheSec: z.coerce.number().int().min(15).max(600).default(60),
  volumeLeaderSnapshotLookbackMin: z.coerce.number().int().min(5).max(120).default(30),
  /**
   * Volume-leader inject snapshot SQL: min token age (default 12h).
   * Does NOT inherit PAPER_MIN_TOKEN_AGE_MIN / dip / post 48h prod gates.
   */
  volumeLeaderMinTokenAgeMin: z.coerce.number().nonnegative().default(720),

  /**
   * Discovery snapshot sanity (1.11.275): отсечь liq≈0 при высокой mcap, dead pool (< share max liq mint).
   * Rollback: `PAPER_DISCOVERY_SNAPSHOT_SANITY_ENABLED=0`.
   */
  discoverySnapshotSanityEnabled: z.boolean().default(true),
  discoverySnapshotSanityRefMcapMinUsd: z.coerce.number().nonnegative().default(2_000_000),
  discoverySnapshotSanityMinLiqToMcapRatio: z.coerce.number().min(0).max(0.5).default(0.002),
  discoverySnapshotSanityMinLiqShareOfMintMax: z.coerce.number().min(0).max(1).default(0.1),
  discoverySnapshotSanityZeroLiqMaxMcapUsd: z.coerce.number().nonnegative().default(500_000),

  /**
   * Volume-leader Jupiter cross-check (1.11.276): tradable quote vs PG price/mcap перед eval.
   * Rollback: `PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_ENABLED=0`.
   */
  volumeLeaderJupiterCrossCheckEnabled: z.boolean().default(true),
  volumeLeaderJupiterCrossCheckMaxPerTick: z.coerce.number().int().min(1).max(50).default(20),
  volumeLeaderJupiterCrossCheckMaxDivergencePct: z.coerce.number().min(1).max(100).default(35),
  volumeLeaderJupiterCrossCheckMinDivergencePct: z.coerce.number().min(0).max(20).default(0.5),

  /**
   * Исключить mint из discovery до тяжёлой работы (dip/Jupiter и т.д.) и не открывать по ним позиции.
   * Файл: один mint на строку, `#` — комментарии. Env: `LIVE_MINT_BLACKLIST_ENABLED`, `LIVE_MINT_BLACKLIST_PATH`.
   */
  mintBlacklistEnabled: z.boolean().default(false),
  mintBlacklistPath: z.string().min(1).default('data/live/live-oscar-mint-blacklist.txt'),

  /** Live Oscar: A/B — B только после DCA и до закрытия; сплит двумя ногами остаётся A. Paper: false. */
  liveExitModeAbEnabled: z.boolean().default(false),
  liveExitModeBTrailDrop: z.coerce.number().min(0).max(1).optional(),
  liveExitModeBTrailTriggerX: z.coerce.number().positive().optional(),
  liveExitModeBTimeoutHours: z.coerce.number().positive().optional(),
  liveExitModeBTpGridStepPnl: z.coerce.number().nonnegative().optional(),
  liveExitModeBTpGridSellFraction: z.coerce.number().min(0).max(1).optional(),
  liveExitModeBTpGridFirstRungRetraceMinPnlPct: z.coerce.number().min(0).max(0.5).optional(),
  /** Ограничить число ступеней TP-grid в режиме B (остальное через финальный выход). */
  liveExitModeBTpGridMaxRungs: z.coerce.number().int().positive().optional(),
  liveExitModeBDcaKillstop: z.coerce.number().optional(),
  liveExitModeBPeakLogStepPct: z.coerce.number().nonnegative().optional(),
  /**
   * Min ms between partial TP sells on the same open mint (Jupiter 429 mitigation). **0** = off.
   * Env: `PAPER_LIVE_PARTIAL_TP_MIN_INTERVAL_MS` or `LIVE_PARTIAL_TP_MIN_INTERVAL_MS`.
   */
  livePartialTpMinIntervalMs: z.coerce.number().int().min(0).max(600_000).default(0),
  /**
   * Paper Oscar IDEALIZED (v2.1 / v2.2): доля PnL к avg для включения режима B и докупа 20%.
   * Отрицательная дробь (напр. −0.06 = −6%). Env: `PAPER_IDEALIZED_OSCAR_MODE_B_ARM_FRAC`.
   */
  idealizedOscarModeBArmFrac: z.coerce.number().min(-0.99).max(-0.0001).default(-0.04),

  dipRecoveryVetoEnabled: z.boolean().default(false),
  dipRecoveryVetoWindowsCsv: z.string().default(''),
  dipRecoveryVetoMaxBouncePct: z.coerce.number().min(0.1).max(500).default(12),
  /**
   * Blocks immediate signal entries when a long-window dip candidate has already
   * recovered back to a recent local high. This covers cases where bounce-from-low
   * recovery veto is small, but the current price is still an unsafe local high.
   */
  dipLocalHighVetoEnabled: z.boolean().default(false),
  dipLocalHighVetoWindowsCsv: z.string().default(''),
  dipLocalHighVetoMaxDistancePct: z.coerce.number().min(0).max(50).default(2),

  /**
   * Trend structure veto (1.11.249): блокирует вход в «протухшие раннеры» —
   * монеты без обновления high за N дней и/или в структурном даунтренде.
   */
  trendStructureVetoEnabled: z.boolean().default(false),
  trendVetoLookbackDays: z.coerce.number().int().min(7).max(30).default(14),
  trendVetoMinPgSamples: z.coerce.number().int().min(0).default(36),
  trendVetoNoHighBreakEnabled: z.boolean().default(true),
  /** Rule 1: last touch of lookback peak ≥ this many days ago → veto. */
  trendVetoMinDaysSinceHighBreak: z.coerce.number().min(1).max(30).default(7),
  trendVetoDeclineEnabled: z.boolean().default(true),
  /** Rule 2: price_now / high_lookback below this AND slope7d ≤ max → veto. */
  trendVetoMaxPxVsHigh14d: z.coerce.number().min(0.1).max(1).default(0.75),
  trendVetoMaxSlope7dPct: z.coerce.number().min(-99).max(99).default(0),
  /** Peak touch tolerance (%): bar within this % of lookback high counts as «touch». */
  trendVetoPeakTouchTolerancePct: z.coerce.number().min(0).max(10).default(1),

  /**
   * Policy A+ (1.11.167): «хирургические» правила пропуска кандидатов на вход.
   * Каждое правило независимо включается флагом `*_ENABLED`. Метрики берутся из
   * `*_pair_snapshots` PG (см. `discovery/policy-a-plus.ts`).
   *
   * Историческая выборка (119 closed live-oscar):
   *   baseline (no filter): n=119, win=56%, Σ=−$70
   *   + bounce + drop1h + vol1h: n=63, win=62%, Σ=+$421
   *   + drop30m: n=46, win=70%, Σ=+$658 (выбранная конфигурация)
   */
  policyAPlusEnabled: z.boolean().default(false),
  policyAPlusBounceFromMin30mEnabled: z.boolean().default(true),
  policyAPlusBounceFromMin30mMaxPct: z.coerce.number().min(0).max(50).default(2.5),
  policyAPlusPriceChange1hEnabled: z.boolean().default(true),
  policyAPlusPriceChange1hMinPct: z.coerce.number().default(-20),
  policyAPlusVol1hEnabled: z.boolean().default(true),
  policyAPlusVol1hMaxUsd: z.coerce.number().nonnegative().default(1_000_000),
  policyAPlusPriceChange30mEnabled: z.boolean().default(true),
  /** Lookback for short-window knife rule (was 30m; prod 15m via `PAPER_POLICY_A_PLUS_PRICE_CHANGE_WINDOW_MIN`). */
  policyAPlusPriceChangeWindowMin: z.coerce.number().int().min(5).max(120).default(15),
  policyAPlusPriceChange30mMinPct: z.coerce.number().default(-10),

  /**
   * Runner Mode (1.11.232) — параллельный к dip-windows путь discovery.
   *
   * Идея: поток retail-внимания мигрирует с одного раннера на другой, и наша
   * задача — успевать на тот, к которому сейчас приклеилось внимание (объём,
   * чистый buy-flow, ликвидность), а не на dip старого. Этот режим **не заменяет**
   * dip-фильтр: оба пути работают параллельно, при `pass` любого срабатывает вход.
   *
   * Никаких holder-проверок, никаких age-ограничений: монета 3-месячной давности
   * со вторым взлётом — точно такой же runner.
   *
   * Anti-stale: `runnerStaleVolRatioMax` режет TripleT-подобные случаи, где
   * vol_1h меньше, чем средний час за сутки × X (внимание утекает).
   */
  runnerModeEnabled: z.boolean().default(false),
  /** Min PG-строк за 24ч для надёжной оценки velocity. Меньше = coverage skip. */
  runnerMinPgSamples24h: z.coerce.number().int().min(0).default(36),
  /** Объём за 1ч (USD) — минимум, чтобы вообще считать «есть интерес сейчас». */
  runnerMinVol1hUsd: z.coerce.number().nonnegative().default(100_000),
  /** Объём за 12ч (USD). */
  runnerMinVol12hUsd: z.coerce.number().nonnegative().default(400_000),
  /** vol_1h / (vol_24h/24) — часовая velocity (1.5 = в 1.5× выше средней). */
  runnerVelocityMinX: z.coerce.number().nonnegative().default(1.5),
  /** Максимальный 5-мин объём за час должен быть ≥ X (USD), чтобы поймать bursty flow. */
  runnerMinVol5mPeak1hUsd: z.coerce.number().nonnegative().default(20_000),
  /** Buys/Sells за 1ч — нижний порог давления покупок. */
  runnerBs1hMin: z.coerce.number().nonnegative().default(0.95),
  /** Buys/Sells за 12ч — кумулятивный buy-side тренд. */
  runnerBs12hMin: z.coerce.number().nonnegative().default(1.0),
  /** liq_now должен быть ≥ X × liq_p25_24h (ликва не утекла). */
  runnerLiqVsP25Min: z.coerce.number().nonnegative().default(0.85),
  /** price_now / price_max_24h — не дальше Y от 24-часового пика (0.6 = -40% макс.). */
  runnerPriceHoldMin: z.coerce.number().nonnegative().default(0.6),
  /** mcap min/max — оставшийся upside и не пыль. */
  runnerMinMcapUsd: z.coerce.number().nonnegative().default(1_000_000),
  runnerMaxMcapUsd: z.coerce.number().nonnegative().default(30_000_000),
  /** Min liq на момент входа (USD). */
  runnerMinLiqUsd: z.coerce.number().nonnegative().default(80_000),
  /**
   * Anti-stale: если vol_1h < (vol_24h/24) × X, значит внимание утекает —
   * runner отказ даже при выполненных floor'ах. X<1.0 (default 0.5 — час сейчас
   * вдвое ниже среднего часа за сутки → не runner, а угасание).
   */
  runnerStaleVolRatioMax: z.coerce.number().nonnegative().default(0.5),

  /**
   * Volume Sybil guard (1.11.216): block dead→spike→dead wash volume pattern.
   * Compares recent max vol5m vs baseline p10 over lookback window in PG snapshots.
   */
  volumeSybilGuardEnabled: z.boolean().default(false),
  /** Hours of history for baseline quietness (3–12). */
  volumeSybilLookbackHours: z.coerce.number().int().min(3).max(12).default(6),
  /** Recent minutes excluded from baseline; spike measured here + current row. */
  volumeSybilRecentMinutes: z.coerce.number().int().min(15).max(180).default(45),
  /** Baseline p10 vol5m at or below this = "dead" market (USD). */
  volumeSybilBaselineP10MaxUsd: z.coerce.number().nonnegative().default(3_000),
  /** Min PG samples in baseline window before rule applies. */
  volumeSybilMinBaselineSamples: z.coerce.number().int().min(5).max(500).default(15),
  /** Recent effective vol5m must reach this to count as spike (USD). */
  volumeSybilMinRecentVol5mUsd: z.coerce.number().nonnegative().default(8_000),
  /** Block when effectiveRecent / max(baselineP10, 100) >= this ratio. */
  volumeSybilSpikeRatioMin: z.coerce.number().min(2).max(100).default(6),
  /** vol5m at or below this counts as "dead" minute in baseline dead-fraction metric. */
  volumeSybilDeadVol5mUsd: z.coerce.number().nonnegative().default(2_500),
  /** Baseline dead-fraction must reach this for "quiet/dead" classification (0–1). */
  volumeSybilMinDeadFraction: z.coerce.number().min(0).max(1).default(0.55),
  /** Skip sybil block when snapshot vol1h >= this (alive market, not wash dead→spike). */
  volumeSybilVol1hAliveExemptUsd: z.coerce.number().nonnegative().default(36_000),
  /**
   * Min vol5m/vol1h ratio to trust high vol1h (blocks wash: dead vol5m + inflated vol1h).
   * Shared by sybil + ephemeral guards for all mints.
   */
  volumeGuardNewMintMinVol5mToVol1hRatio: z.coerce.number().min(0.01).max(1).default(0.08),
  /** New mint wash check: apply ratio gate when snapshot vol1h >= this (USD). */
  volumeGuardNewMintVol1hWashMinUsd: z.coerce.number().nonnegative().default(36_000),

  /**
   * Volume Ephemeral guard (1.11.219): block when hourly vol5m is concentrated in a
   * narrow window (one-shot burst pattern — e.g. GOAT 3h / 24h).
   */
  volumeEphemeralGuardEnabled: z.boolean().default(false),
  /** Lookback for hourly concentration (12–48h). */
  volumeEphemeralLookbackHours: z.coerce.number().int().min(12).max(48).default(24),
  /** Hour counts as "active" when max vol5m in that hour >= this (USD). */
  volumeEphemeralMinActiveHourVol5mUsd: z.coerce.number().nonnegative().default(8_000),
  /** Block when active hours in lookback <= this. */
  volumeEphemeralMaxActiveHours: z.coerce.number().int().min(1).max(12).default(4),
  /** Require peak hourly vol5m >= this to treat as significant burst. */
  volumeEphemeralMinPeakVol5mUsd: z.coerce.number().nonnegative().default(20_000),
  /** Min distinct hours with PG data before rule applies. */
  volumeEphemeralMinHoursWithData: z.coerce.number().int().min(1).max(48).default(2),
  /** Extra hours slack: block when hoursWithData <= maxActiveHours + buffer. */
  volumeEphemeralSparseHoursBuffer: z.coerce.number().int().min(0).max(12).default(2),
  /** Also block tail when current vol5m is a small fraction of peak after narrow burst. */
  volumeEphemeralTailBlockEnabled: z.boolean().default(true),
  /** Tail block when current/peak <= this ratio (0–1). */
  volumeEphemeralTailMaxPeakRatio: z.coerce.number().min(0.01).max(1).default(0.3),
  /**
   * New mints (no bot trade in lookback): min active hours with vol5m before entry.
   * Blocks spike-only wash (e.g. MUSHU: 2h burst + inflated vol1h, 10h dead).
   */
  volumeEphemeralNewMintMinActiveHours: z.coerce.number().int().min(0).max(24).default(10),
  /**
   * When fresh Birdeye/DexScreener quote shows healthy vol5m/vol1h spread, skip PG-blind
   * ephemeral blocks (narrow hourly window / tail from stale PG peak). Env `PAPER_VOLUME_EPHEMERAL_BIRDEYE_FRESH_BYPASS`.
   */
  volumeEphemeralBirdeyeFreshBypass: z.boolean().default(true),

  /**
   * Ephemeral volume spike guard (48h): block dormant baseline → sudden vol1h explosion
   * regardless of token age (DADDY RCA 2026-07-05). Aligns with PAPER_POST_MIN_AGE_MIN=2880.
   */
  oldMintDormantVolSpikeGuardEnabled: z.boolean().default(false),
  /** Min token age (days) before rule applies; 0 = age-agnostic (default). */
  oldMintDormantVolSpikeMinTokenAgeDays: z.coerce.number().int().min(0).max(730).default(0),
  /** Mints below this age (days) skip — matches post entry floor (~48h / 2d). */
  oldMintDormantVolSpikeMaxYoungTokenAgeDays: z.coerce.number().int().min(0).max(30).default(2),
  /** Total PG lookback window (hours); default 48h aligned with post min age. */
  oldMintDormantVolSpikeLookbackHours: z.coerce.number().int().min(48).max(168).default(48),
  /** Baseline window start (hours ago); default 48h = [24h,48h) ago when paired with end. Max aligns with lookback. */
  oldMintDormantVolSpikeBaselineStartHoursAgo: z.coerce.number().int().min(24).max(168).default(48),
  /** Baseline window end (hours ago); default 24h. */
  oldMintDormantVolSpikeBaselineEndHoursAgo: z.coerce.number().int().min(6).max(120).default(24),
  /** @deprecated Use baselineStartHoursAgo; kept for env backward compat. */
  oldMintDormantVolSpikeDormantLookbackHours: z.coerce.number().int().min(24).max(168).default(48),
  /** Recent hours where spike is measured (excluded from baseline). */
  oldMintDormantVolSpikeRecentHours: z.coerce.number().int().min(3).max(24).default(6),
  /** Hour counts as dormant when max vol1h in hour <= this (USD). */
  oldMintDormantVolSpikeDormantVol1hMaxUsd: z.coerce.number().nonnegative().default(10_000),
  /** Hour counts as dormant when max vol5m in hour <= this (USD). */
  oldMintDormantVolSpikeDormantVol5mMaxUsd: z.coerce.number().nonnegative().default(5_000),
  /** Min share of baseline hours that were dormant (0–1). */
  oldMintDormantVolSpikeMinDormantHourFraction: z.coerce.number().min(0.5).max(1).default(0.75),
  /** Min baseline hours with PG data before rule applies (primary or fallback window). */
  oldMintDormantVolSpikeMinBaselineHours: z.coerce.number().int().min(12).max(120).default(18),
  /** Effective recent vol1h must reach this to count as spike (USD). */
  oldMintDormantVolSpikeMinSpikeVol1hUsd: z.coerce.number().nonnegative().default(25_000),
  /** Block when effectiveRecentVol1h / baselineP90Vol1h >= this ratio. */
  oldMintDormantVolSpikeVol1hRatioMin: z.coerce.number().min(2).max(100).default(5),

  /**
   * PG data coverage guard (1.11.222): measure minute-bar history gaps/thinness for volume
   * guards; optional buy block via `pgDataCoverageBlockBuy` (default off).
   */
  pgDataCoverageGuardEnabled: z.boolean().default(false),
  pgDataCoverageLookbackHours: z.coerce.number().int().min(6).max(48).default(24),
  /** Recent window (hours) for mint coverage / gap checks; sybil uses its own lookback. */
  pgDataCoverageRecentHours: z.coerce.number().int().min(3).max(24).default(6),
  /** Min distinct hours with PG minute bars in the recent window. */
  pgDataCoverageMinRecentHoursWithData: z.coerce.number().int().min(1).max(24).default(4),
  /** Min share of lookback hours with PG data for this mint (legacy; recent window preferred). */
  pgDataCoverageMinHourRatio: z.coerce.number().min(0.1).max(1).default(0.5),
  /** Stricter hour ratio while within strict-after-recovery window. */
  pgDataCoverageStrictMinHourRatio: z.coerce.number().min(0.1).max(1).default(0.75),
  /** Min share of full hours with ≥N minute bars across dex tables (full tier; 0 = off). */
  pgDataCoverageMinSystemHourRatio: z.coerce.number().min(0).max(1).default(0.3),
  /** Hour counts as covered when it has at least this many distinct minute bars. */
  pgDataCoverageMinMinutesPerHour: z.coerce.number().int().min(5).max(59).default(5),
  /** Block when largest gap between consecutive mint minute bars exceeds this. */
  pgDataCoverageMaxGapMinutes: z.coerce.number().int().min(5).max(720).default(30),
  /** Block all entries while any dex snapshot table is stale right now. */
  pgDataCoverageBlockOnPgStale: z.boolean().default(true),
  /**
   * When false (default): coverage guard still runs for metrics/audit but never blocks buys.
   * Env `PAPER_PG_DATA_COVERAGE_BLOCK_BUY`.
   */
  pgDataCoverageBlockBuy: z.boolean().default(false),
  /** After PG recovery, use strict min hour ratio for this many hours (full tier when auto-escalate). */
  pgDataCoverageStrictAfterRecoveryHours: z.coerce.number().int().min(0).max(72).default(24),
  /**
   * When true: after PG outage automatically use recent-window checks; restore full 24h
   * system ratio + strict recovery when metrics healthy (no manual env toggle).
   */
  pgDataCoverageAutoEscalate: z.boolean().default(true),
  /**
   * When true: mints the bot traded recently skip pg_gap blocks (still block pg_stale_now,
   * thin coverage, sybil). New mints keep full gap enforcement.
   */
  pgDataCoverageKnownMintGapBypass: z.boolean().default(false),
  /** Lookback for prior bot open/close (journal-derived maps) to qualify as known mint. */
  pgDataCoverageKnownMintLookbackDays: z.coerce.number().int().min(1).max(90).default(14),
  /**
   * When true: fresh Birdeye/DexScreener REST quote bypasses PG coverage buy blocks
   * (pg_stale, sybil samples, gaps). Env `PAPER_PG_COVERAGE_BIRDEYE_FRESH_BYPASS`.
   */
  pgCoverageBirdeyeFreshBypass: z.boolean().default(true),

  // ---- whale analysis ----
  whaleEnabled: z.boolean().default(false),
  whaleRequireTrigger: z.boolean().default(false),
  whaleLargeSellUsd: z.coerce.number().nonnegative().default(3_000),
  whaleRecentLookbackMin: z.coerce.number().nonnegative().default(10),
  whaleCapitulationPct: z.coerce.number().min(0).max(1).default(0.7),
  whaleGroupSellUsd: z.coerce.number().nonnegative().default(5_000),
  whaleGroupMinSellers: z.coerce.number().int().nonnegative().default(2),
  whaleGroupDumpPct: z.coerce.number().min(0).max(1).default(0.4),
  whaleBlockCreatorDump: z.boolean().default(true),
  whaleCreatorDumpLookbackMin: z.coerce.number().nonnegative().default(20),
  whaleCreatorDumpMinPct: z.coerce.number().min(0).max(1).default(0.05),
  whaleCreatorDumpMaxPct: z.coerce.number().min(0).max(1).default(0.6),
  whaleDcaPredMinSells24h: z.coerce.number().int().nonnegative().default(4),
  whaleDcaPredMinIntervalMin: z.coerce.number().nonnegative().default(30),
  whaleDcaPredMinChunkUsd: z.coerce.number().nonnegative().default(3_000),
  whaleDcaAggrMinSells24h: z.coerce.number().int().nonnegative().default(6),
  whaleDcaAggrMaxIntervalMin: z.coerce.number().nonnegative().default(15),
  whaleSilenceMinAfterLastSell: z.coerce.number().nonnegative().default(0),

  // ---- legacy launchpad filters ----
  filtMinUniqueBuyers: z.coerce.number().int().nonnegative().default(20),
  filtMinBuySol: z.coerce.number().nonnegative().default(5),
  filtMinBuySellRatio: z.coerce.number().nonnegative().default(1.5),
  filtMaxTopBuyerShare: z.coerce.number().min(0).max(1).default(0.35),
  filtMinBcProgress: z.coerce.number().min(0).max(1).default(0.25),
  filtMaxBcProgress: z.coerce.number().min(0).max(1).default(0.95),

  // ---- exits (W6.3c) ----
  tpX: z.coerce.number().positive().default(5.0),
  slX: z.coerce.number().nonnegative().default(0),
  trailDrop: z.coerce.number().min(0).max(1).default(0.5),
  trailTriggerX: z.coerce.number().positive().default(1.3),
  /**
   * peak — классический трейл от peakMcUsd после trailTriggerX.
   * ladder_retrace — если уже были продажи по TP-ladder и PnL откатился до предыдущей ступени ладдера (или ниже), закрыть весь остаток (reason TRAIL).
   */
  trailMode: z.enum(['peak', 'ladder_retrace', 'stepped_grid']).default('peak'),
  timeoutHours: z.coerce.number().positive().default(12),

  /**
   * Live Oscar: enable wave-B exit policy for **new** opens only (`liveExitPolicyId=wave_b_v1`).
   * Restored opens without policy id stay on `legacy_grid` with pinned prod grid overrides.
   * Mutually exclusive with Variant A (`PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A=1`).
   */
  liveOscarExitPolicyWaveBEnabled: z.boolean().default(false),
  /** Fraction of remainder per trail step under wave B (default 0.30). */
  liveOscarExitPolicyWaveBTrailSellFraction: z.coerce.number().min(0.01).max(1).default(0.3),
  /**
   * Wave B flat-take (1.11.475, owner-approved). When ON, NEW wave-B opens are stamped with a
   * flat/early take profile that REPLACES the escalating ladder (CF optimizer: escalating ladder is
   * the losing lever; early/flat take is the regime-robust win). In-flight opens are NOT re-stamped
   * (keep their escalating ladder) — safe transition. Default OFF → byte-identical to escalating.
   * Env `PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP`.
   */
  liveOscarWaveBFlatTpEnabled: z.boolean().default(false),
  /**
   * Flat-take shape (only when `liveOscarWaveBFlatTpEnabled`): `half8_runner` = sell 50% at each +8%
   * then ride/exit the runner on the defensive trail (matches "grab +8%, let the runner run");
   * `flat` = sell 100% at +15%, no trail. Env `PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP_MODE`.
   */
  liveOscarWaveBFlatTpMode: z.enum(['half8_runner', 'flat']).default('half8_runner'),
  /**
   * Wave B time-stop (hours). Wave B has NO time-stop in the legacy ladder; this adds one, applied
   * ONLY to opens stamped with a flat-take mode (so in-flight opens are never force-closed by it).
   * `0` disables. Env `PAPER_LIVE_OSCAR_WAVE_B_TIME_STOP_HOURS` (default 12).
   */
  liveOscarWaveBTimeStopHours: z.coerce.number().min(0).max(720).default(12),

  /**
   * Hard profit-agnostic time-stop (hours). Applies to ANY exit policy: once position age ≥ this,
   * force a real full exit (`TIME_STOP`, policy-allowed on-chain sell) regardless of PnL/progress —
   * frees capital tied up in stale «downhill runner» positions instead of sitting to −50% killstop.
   * Fires only after TP/kill/trail were evaluated, so genuine winners still exit on their own signal.
   * `0` disables. Env `PAPER_LIVE_OSCAR_HARD_TIME_STOP_HOURS` (default 24).
   */
  liveOscarHardTimeStopHours: z.coerce.number().min(0).max(720).default(24),

  /**
   * Live Oscar Variant A (v1): discrete TP ladder + moon +50% + peak retrace trail + smart48/salvage24.
   * Env: `PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A=1` (disables wave B for new opens).
   */
  liveOscarExitPolicyVariantAEnabled: z.boolean().default(false),
  liveOscarVariantAMoonTargetPct: z.coerce.number().min(0.05).max(5).default(0.5),
  liveOscarVariantATrailArmPct: z.coerce.number().min(0.05).max(5).default(0.35),
  liveOscarVariantATrailRetracePct: z.coerce.number().min(0.01).max(0.5).default(0.12),
  liveOscarVariantASalvage24Enabled: z.boolean().default(true),
  liveOscarVariantASalvage24MinPeakPct: z.coerce.number().min(0).max(50).default(5),
  liveOscarVariantASmart48Enabled: z.boolean().default(true),
  liveOscarVariantAMaxHorizonHours: z.coerce.number().positive().default(96),
  /** v3 scratch: gap-through-0 flush when PnL ≤ −this vs avg (default 3%). */
  liveOscarVariantAScratchGapTailPct: z.coerce.number().min(0.01).max(0.2).default(0.03),

  /**
   * Live Oscar only (`strategyId === live-oscar`): after at least one `TP_LADDER` partial,
   * if price returns to weighted avg (xAvg ≤ 1), sell this fraction of **remaining** once.
   * Env: `PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED`, `PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_FRACTION`.
   */
  liveOscarBreakevenTrimAfterFirstTpEnabled: z.boolean().default(false),
  liveOscarBreakevenTrimFraction: z.coerce.number().min(0.01).max(0.99).default(0.5),

  /**
   * Wave B (`wave_b_v1`): after first two TP rungs (+2.5% / +5%) taken, if PnL returns to ≤ threshold
   * (default 0% vs avg), sell `liveOscarWaveBBreakevenInsuranceFraction` of remainder once.
   * Env: `PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_*`.
   */
  liveOscarWaveBBreakevenInsuranceEnabled: z.boolean().default(false),
  liveOscarWaveBBreakevenInsuranceFraction: z.coerce.number().min(0.01).max(0.99).default(0.5),
  /** Max PnL fraction vs avg to fire insurance (0 = at/below breakeven). */
  liveOscarWaveBBreakevenInsurancePnlFrac: z.coerce.number().min(-0.05).max(0.05).default(0),

  /**
   * Wave B half8_runner: pre-arm (+7.5%) reached but +8% TP not taken — sell partial at +5% vs avg,
   * then full exit remaining on pullback to +2.5% vs avg (not breakeven-at-0%).
   * Env: `PAPER_LIVE_OSCAR_WAVE_B_PRE_ARM_NO_HALF8_*`.
   */
  liveOscarWaveBPreArmNoHalf8LadderEnabled: z.boolean().default(true),
  liveOscarWaveBPreArmNoHalf8PartialPnlFrac: z.coerce.number().min(0.01).max(0.2).default(0.05),
  liveOscarWaveBPreArmNoHalf8PullbackPnlFrac: z.coerce.number().min(0).max(0.1).default(0.025),
  liveOscarWaveBPreArmNoHalf8PartialFraction: z.coerce.number().min(0.01).max(0.99).default(0.5),

  /**
   * Wave B half8_runner: signal anchor hit −N% before +8% TP — sell partial at +5% vs avg once
   * (instead of waiting for half8 +8%). Env: `PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_*`.
   */
  liveOscarDip10FirstTp5Enabled: z.boolean().default(true),
  liveOscarDip10FirstTp5PartialPnlFrac: z.coerce.number().min(0.01).max(0.2).default(0.05),
  liveOscarDip10FirstTp5PartialFraction: z.coerce.number().min(0.01).max(0.99).default(0.5),
  /** Signal-anchor drop % that arms the dip10-first path (default 10 = −10% from signal). */
  liveOscarDip10FirstTp5SignalDropPct: z.coerce.number().min(1).max(50).default(10),

  /**
   * Wave B: after first `TP_LADDER` partial, if PnL vs avg falls to ≤ threshold (default −15%),
   * sell `liveOscarWaveBPostTp1DeriskFraction` of remainder once (before full kill).
   * Env: `PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_DERISK_*`.
   */
  liveOscarWaveBPostTp1DeriskEnabled: z.boolean().default(false),
  liveOscarWaveBPostTp1DeriskPnlFrac: z.coerce.number().min(-0.5).max(-0.01).default(-0.15),
  liveOscarWaveBPostTp1DeriskFraction: z.coerce.number().min(0.01).max(0.99).default(0.5),

  /**
   * Wave B: after first `TP_LADDER` partial, if price ≤ −N% from **signal anchor** → full exit;
   * when price ≤ −M% from same signal → re-open configured USD (Wave B + sig50 kill).
   * Env: `PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_*`.
   */
  liveOscarWaveBPostTp1ScratchReentryEnabled: z.boolean().default(false),
  liveOscarWaveBPostTp1ScratchDropPct: z.coerce.number().min(1).max(95).default(15),
  liveOscarWaveBPostTp1ScratchReentryDropPct: z.coerce.number().min(1).max(95).default(30),
  liveOscarWaveBPostTp1ScratchReentryUsd: z.coerce.number().positive().default(1500),

  /**
   * Variant A v2: after ≥1 TP, thin market (vol5m) + peak/current PnL gates → flush remainder.
   * Env: `PAPER_LIVE_OSCAR_THIN_VOL_EXIT_ENABLED`.
   */
  liveOscarThinVolExitEnabled: z.boolean().default(false),

  dcaLevelsSpec: z.string().default(''),
  dcaKillstop: z.coerce.number().default(0),

  tpLadderSpec: z.string().default(''),

  /**
   * Oscar-style TP grid: each multiple of this **PnL fraction vs avg** (e.g. 0.05 = +5%) fires once;
   * each hit sells `tpGridSellFraction` of **current** remaining position. Empty discrete `tpLadder` when >0.
   * Retrace (`ladder_retrace`) uses previous threshold like the discrete ladder.
   */
  tpGridStepPnl: z.coerce.number().nonnegative().default(0),
  tpGridSellFraction: z.coerce.number().min(0).max(1).default(0.2),
  /**
   * 1.11.167: восходящий профиль `sellFraction` по индексу ступени (1-based в коде, но
   * массив 0-based — `[step1, step2, ...]`). Когда массив непустой, `tpGridEffective`
   * возвращает значение по `min(stepIdx-1, profile.length-1)` — последнее значение
   * тиражируется на все следующие ступени, что обеспечивает «бесконечный» хвост
   * лестницы. Пустой массив → fallback на плоский `tpGridSellFraction`.
   */
  tpGridSellFractionByStep: z.array(z.number().min(0).max(1)).default([]),
  /**
   * После **первой** срабатывающей ступени TP-grid «предыдущий порог» для retrace был бы 0 (= безубыток к средней).
   * Здесь задаётся **минимальный PnL (доля, напр. 0.025 = +2.5%)**: закрываем остаток, когда нереализованный xAvg-1
   * опускается до этого уровня **или ниже** — раньше, чем дать цене уйти в ноль/минус между тиками трекера.
   * `0` = прежнее поведение (retrace к 0%).
   */
  tpGridFirstRungRetraceMinPnlPct: z.coerce.number().min(0).max(0.5).default(0),
  /** Лимит ступеней TP-grid (режим A или база); обычно не задаётся = без лимита. */
  tpGridMaxRungs: z.coerce.number().int().positive().optional(),

  /** Paper fork: метка режима по пути цены в PG `pair_snapshots` при открытии → fork TP-grid. */
  tpRegimeEnabled: z.boolean().default(false),
  tpRegimeLookbackMin: z.coerce.number().int().positive().default(720),
  tpRegimeMinSamples: z.coerce.number().int().min(1).default(3),
  tpRegimeDownNetPct: z.coerce.number().default(-5),
  tpRegimeUpNetPct: z.coerce.number().default(5),
  tpRegimeSidewaysAbsNetPct: z.coerce.number().nonnegative().default(3),
  tpRegimeSidewaysMinRangePct: z.coerce.number().nonnegative().default(15),
  /**
   * When regime at open is `down`, stamp `tpGridOverrides.dcaKillstop` (tighter scalp-style stop).
   * Omit env to leave global `PAPER_DCA_KILLSTOP` only.
   */
  tpRegimeDownDcaKillstop: z.number().min(-0.99).max(-0.001).optional(),

  followupOffsetsMinSpec: z.string().default('30,60,120'),

  contextSwapsEnabled: z.boolean().default(true),
  contextSwapsLimit: z.coerce.number().int().min(1).max(50).default(5),

  preEntryDynamicsEnabled: z.boolean().default(true),

  peakLogStepPct: z.coerce.number().nonnegative().default(1),

  statsIntervalMs: z.coerce.number().int().positive().default(5 * 60_000),

  /** W7.2 — QuickNode pre-entry safety (feature `safety`). */
  safetyCheckEnabled: z.boolean().default(false),
  safetyTopHolderMaxPct: z.coerce.number().min(0).max(100).default(40),
  safetyRequireMintAuthNull: z.boolean().default(true),
  safetyRequireFreezeAuthNull: z.boolean().default(true),
  safetyTimeoutMs: z.coerce.number().int().min(500).max(10_000).default(2500),

  /** W7.3 — live priority-fee monitor. */
  priorityFeeEnabled: z.boolean().default(false),
  priorityFeeTickerMs: z.coerce.number().int().min(15_000).max(600_000).default(60_000),
  priorityFeeMaxAgeMs: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  priorityFeeRpcTimeoutMs: z.coerce.number().int().min(500).max(10_000).default(2500),
  priorityFeePercentile: z.enum(['p50', 'p75', 'p90']).default('p75'),
  priorityFeeTargetCu: z.coerce.number().int().min(50_000).max(1_400_000).default(200_000),

  /** W7.4 — pre-entry Jupiter quote sanity check. */
  priceVerifyEnabled: z.boolean().default(false),
  priceVerifyBlockOnFail: z.boolean().default(false),
  priceVerifyUseJupiterPrice: z.boolean().default(false),
  priceVerifyMaxSlipPct: z.coerce.number().min(0.1).max(50).default(4.0),
  priceVerifyMaxSlipBps: z.coerce.number().int().min(10).max(5_000).default(400),
  priceVerifyMaxPriceImpactPct: z.coerce.number().min(0.1).max(80).default(8.0),
  priceVerifyTimeoutMs: z.coerce.number().int().min(500).max(8_000).default(2500),

  /** W7.4.2 — pre-exit Jupiter quote (token→SOL) vs snapshot before partial/full sells; thresholds reuse entry limits. */
  priceVerifyExitEnabled: z.boolean().default(false),
  priceVerifyExitBlockOnFail: z.boolean().default(false),
  /**
   * After this many consecutive pre-exit verify defers for the same mint:
   * - **partial sells**: next attempt skips `block_on_fail`.
   * - **full exit**: TIMEOUT bypasses verify on first attempt; TRAIL/KILLSTOP/… escalate after this many defers.
   * Telemetry: `live_exit_verify_defer` phase `escalate_proceed`.
   * **0** = disable escalation for partial + non-TIMEOUT closes (legacy wedge).
   */
  priceVerifyExitMaxDefersEscalation: z.coerce.number().int().min(0).max(50_000).default(60),

  /** W7.4.1 — Jupiter quote retries + circuit breaker (shared: entry, exit, impulse, sim-audit quote fetch). */
  priceVerifyQuoteRetriesEnabled: z.boolean().default(true),
  priceVerifyQuoteMaxAttempts: z.coerce.number().int().min(1).max(5).default(3),
  priceVerifyQuoteRetryBackoffMs: z.coerce.number().int().min(0).max(10_000).default(300),
  priceVerifyCircuitEnabled: z.boolean().default(true),
  priceVerifyCircuitWindowMs: z.coerce.number().int().min(60_000).max(3_600_000).default(1_800_000),
  priceVerifyCircuitSkipRatePct: z.coerce.number().min(1).max(99).default(10),
  priceVerifyCircuitMinAttempts: z.coerce.number().int().min(3).max(500).default(12),
  priceVerifyCircuitCooldownMs: z.coerce.number().int().min(5_000).max(600_000).default(90_000),

  /** W7.5 — liquidity drain watch (pool liq vs entry baseline). */
  liqWatchEnabled: z.boolean().default(false),
  liqWatchForceClose: z.boolean().default(false),
  liqWatchDrainPct: z.coerce.number().min(5).max(95).default(35),
  liqWatchMinAgeMin: z.coerce.number().min(0).max(120).default(1),
  liqWatchConsecutiveFailures: z.coerce.number().int().min(1).max(10).default(2),
  liqWatchSnapshotMaxAgeMs: z.coerce.number().int().min(15_000).max(15 * 60 * 1000).default(120_000),
  liqWatchRpcFallback: z.boolean().default(false),
  liqWatchStampOnAllClose: z.boolean().default(true),
  liqWatchStampOnTrack: z.boolean().default(false),
  /** PG pair snapshot vs Birdeye/DexScreener — block LIQ_DRAIN when sources disagree beyond this %. */
  liqWatchDisagreementPct: z.coerce.number().min(5).max(90).default(25),
  /** Resolve Birdeye → DexScreener → PG for liq-watch (not raw PG-only). */
  liqWatchDiscoveryQuote: z.boolean().default(true),

  /**
   * VOL_COLLAPSE — rolling-volume drain kill-stop (1h volume vs high-water baseline). Mirrors liq-watch.
   * Backtest (60d, 2819 dip-buy entries): sustained collapse predicts ~-10..-12% forward decline and
   * ~2x capital efficiency. Shipped OFF/shadow by default — enable only after owner signs off thresholds.
   * Env: `PAPER_VOL_WATCH_*`.
   */
  volWatchEnabled: z.boolean().default(false),
  /** `false` = shadow (journal-only, never sells); `true` = enforce real full exit. */
  volWatchForceClose: z.boolean().default(false),
  /** Collapse when current 1h vol dropped >= this % vs baseline (90 = current ≤ 10% of baseline). */
  volWatchCollapsePct: z.coerce.number().min(50).max(99).default(90),
  /** Collapse must persist >= this many hours before force-close (debounce vs noisy dips). */
  volWatchSustainHours: z.coerce.number().min(0.5).max(48).default(3),
  /** Ignore positions whose baseline 1h volume is below this (noise-level, no signal). */
  volWatchMinBaselineUsd: z.coerce.number().min(0).max(1_000_000).default(2_000),
  /** Don't evaluate before position is this old (need volume history to establish baseline). */
  volWatchMinAgeMin: z.coerce.number().min(0).max(240).default(30),
  /** Max age of PG pair snapshot to treat rolling volume as fresh. */
  volWatchSnapshotMaxAgeMs: z.coerce.number().int().min(15_000).max(15 * 60 * 1000).default(120_000),
  /** Journal a `vol_watch_tick` verdict on every evaluated tick (telemetry/backtest calibration). */
  volWatchStampOnTrack: z.boolean().default(false),

  /**
   * Flash crash kill — velocity / post-fill drawdown (live-oscar). Fractions are negative (e.g. -0.06 = −6%).
   * Env: `PAPER_FLASH_CRASH_KILL_*`.
   */
  flashCrashKillEnabled: z.boolean().default(false),
  flashCrashKillDrop30sPct: z.coerce.number().max(0).min(-0.99).default(-0.06),
  flashCrashKillDrop60sPct: z.coerce.number().max(0).min(-0.99).default(-0.08),
  flashCrashKillDrop180sPct: z.coerce.number().max(0).min(-0.99).default(-0.12),
  flashCrashKillPostDcaWarnPct: z.coerce.number().max(0).min(-0.99).default(-0.05),
  flashCrashKillPostDcaFullPct: z.coerce.number().max(0).min(-0.99).default(-0.07),
  flashCrashKillPostDcaWarnWindowMs: z.coerce.number().int().min(30_000).max(600_000).default(120_000),
  flashCrashKillPostDcaFullWindowMs: z.coerce.number().int().min(60_000).max(900_000).default(180_000),
  flashCrashKillQuoteMaxDiscountPct: z.coerce.number().min(0).max(0.5).default(0.08),
  flashCrashKillQuoteDrop60sPct: z.coerce.number().max(0).min(-0.99).default(-0.05),
  flashCrashKillPartialSellFraction: z.coerce.number().min(0.1).max(1).default(0.75),
  flashCrashKillDcaBlockMs: z.coerce.number().int().min(0).max(900_000).default(300_000),

  /** Live SPL holder-count resolver via QuickNode. */
  holdersLiveEnabled: z.boolean().default(false),
  holdersUseQnAddon: z.boolean().default(false),
  holdersTtlMs: z.coerce.number().int().min(5_000).max(15 * 60_000).default(90_000),
  holdersNegTtlMs: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** 1.11.232: разрешили 0 — когда `PAPER_HOLDERS_LIVE_ENABLED=0` нет смысла требовать ≥1. */
  holdersMaxPerTick: z.coerce.number().int().min(0).max(200).default(10),
  holdersTimeoutMs: z.coerce.number().int().min(1_000).max(15_000).default(4000),
  holdersIncludeToken2022: z.boolean().default(true),
  holdersExcludeOwners: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  holdersOnFail: z.enum(['block', 'warn', 'db_fallback']).default('db_fallback'),
  holdersDbWriteback: z.boolean().default(false),
  /** Before evaluating candidates, resolve holder counts for up to N mints with `holder_count=0` in snapshot SQL (RPC + optional DB writeback). Reduces false «0 holders» in PG and in-row fallback. */
  holdersSnapshotWarmupMax: z.coerce.number().int().min(0).max(200).default(0),
  holdersGpaCreditsPerCall: z.coerce.number().int().min(10).max(2_000).default(100),

  /** W7.6 — impulse confirm (PG delta → QN Orca spot → Jupiter corridor). */
  impulseConfirmEnabled: z.boolean().default(false),
  /** Positive magnitude; trigger when Δ_pg ≤ −this (unless impulsePgAbsMode). */
  impulsePgMinDropPct: z.coerce.number().nonnegative().default(5),
  /** When true, trigger on abs(Δ_pg) ≥ impulsePgMinAbsPct. */
  impulsePgAbsMode: z.boolean().default(false),
  impulsePgMinAbsPct: z.coerce.number().nonnegative().default(5),
  impulsePgMaxAgeSecMin: z.coerce.number().nonnegative().default(10),
  impulsePgMaxAgeSecMax: z.coerce.number().nonnegative().default(120),
  impulseRpcMaxPerMin: z.coerce.number().int().positive().default(30),
  impulseSingleFlightMs: z.coerce.number().int().positive().default(15_000),
  impulseMintCooldownSec: z.coerce.number().nonnegative().default(0),
  impulseRpcTimeoutMs: z.coerce.number().int().min(500).max(15_000).default(3500),
  impulseRpcRetryCount: z.coerce.number().int().min(0).max(3).default(1),
  impulseRpcRetryBackoffMs: z.coerce.number().int().min(0).default(400),
  impulseMaxUpPctFromAnchor: z.coerce.number().nonnegative().default(30),
  /** Live spot vs якорь (новый PG snap): отклонение не глубже этого % (например 50 ⇒ цена не ниже −50% от якоря). */
  impulseMaxDownPctFromAnchor: z.coerce.number().nonnegative().default(70),
  /** Если >0: live spot должен быть **не выше** якоря минимум на столько % (якорь − spot ≥ min). 0 = выкл. */
  impulseMinDownPctFromAnchor: z.coerce.number().nonnegative().default(0),
  impulseMaxDisagreePct: z.coerce.number().nonnegative().default(8),
  impulseRequireJupiter: z.boolean().default(true),
  impulseAllowOnchainOnly: z.boolean().default(false),
  /** When pool layout has no QN decoder (non-Orca), allow Jupiter-only impulse path. */
  impulseAllowJupiterOnlyUnsupported: z.boolean().default(true),
  impulseDipPolicy: z.enum(['shadow', 'parallel_and', 'parallel_or', 'boost']).default('parallel_and'),
  impulseQnCreditsPerCall: z.coerce.number().int().min(10).max(500).default(30),
  impulseJupiterTimeoutMs: z.coerce.number().int().min(500).max(10_000).default(2500),
  /**
   * Если dip-windows не прошли, но PG-импульс по паре сработал — считать dip-гейт пройденным для остальных фильтров.
   * Полный impulse (QN/Jupiter) по-прежнему в executor; Orca — только один из путей ончейн-спота.
   */
  entryImpulsePgBypassesDip: z.boolean().default(false),

  /** W7.8 — JSONL `simAudit` on sampled opens (Jupiter build + `simulateTransaction` via `qnCall` feature `sim`). */
  simAuditEnabled: z.boolean().default(false),
  simSamplePct: z.coerce.number().int().min(0).max(100).default(0),
  simMaxWallMs: z.coerce.number().int().min(2000).max(60_000).default(8000),
  simBuildTimeoutMs: z.coerce.number().int().min(1000).max(30_000).default(5000),
  simUseJupiterBuild: z.boolean().default(true),
  simCredsPerCall: z.coerce.number().int().min(10).max(200).default(30),
  simStrictBudget: z.boolean().default(true),

  // ---- smart_lottery paper (young pools + early-buyer intel gate) ----
  smlotEnableMigrationLane: z.boolean().default(true),
  smlotEnablePostLane: z.boolean().default(false),
  smlotMigMinAgeMin: z.coerce.number().nonnegative().default(2),
  smlotMigMaxAgeMin: z.coerce.number().nonnegative().default(45),
  smlotMigMinLiqUsd: z.coerce.number().nonnegative().default(12_000),
  smlotMigMaxLiqUsd: z.coerce.number().nonnegative().default(0),
  smlotMigMinVol5mUsd: z.coerce.number().nonnegative().default(1_800),
  smlotMigMinBuys5m: z.coerce.number().int().nonnegative().default(16),
  smlotMigMinSells5m: z.coerce.number().int().nonnegative().default(8),
  smlotPostMinAgeMin: z.coerce.number().nonnegative().default(25),
  smlotPostMaxAgeMin: z.coerce.number().nonnegative().default(180),
  smlotPostMinLiqUsd: z.coerce.number().nonnegative().default(15_000),
  smlotPostMaxLiqUsd: z.coerce.number().nonnegative().default(0),
  smlotPostMinVol5mUsd: z.coerce.number().nonnegative().default(2_500),
  smlotPostMinBuys5m: z.coerce.number().int().nonnegative().default(16),
  smlotPostMinSells5m: z.coerce.number().int().nonnegative().default(10),
  /** 0 = reuse `snapshotCandidateLimit`. */
  smlotSnapshotCandidateLimit: z.coerce.number().int().min(0).max(5000).default(0),
  smlotIntelGateEnabled: z.boolean().default(true),
  smlotEarlyBuyWindowSec: z.coerce.number().int().min(30).max(7200).default(180),
  smlotEarlyBuyWalletCap: z.coerce.number().int().min(5).max(300).default(60),
  smlotRequireEarlySwapCoverage: z.boolean().default(false),
  smlotBlockIntelBlockTrade: z.boolean().default(true),
  smlotBlockBadTags: z.boolean().default(true),
  smlotBlockClusteredWallets: z.boolean().default(true),
  smlotBlockScamFarmMeta: z.boolean().default(true),
}).transform((data) => {
  const { dipLookbackWindowsCsv, dipRecoveryVetoWindowsCsv, dipLocalHighVetoWindowsCsv, ...rest } = data;
  const dipLookbackWindowsMin = resolveDipLookbackWindows(rest.dipLookbackMin, dipLookbackWindowsCsv);
  const dipRecoveryVetoWindowsMin = resolveRecoveryVetoWindows(dipRecoveryVetoWindowsCsv);
  const dipLocalHighVetoWindowsMin = resolveRecoveryVetoWindows(dipLocalHighVetoWindowsCsv);
  const fastDipScalpWindows =
    rest.liveOscarFastDipScalpLaneEnabled && rest.liveOscarFastDipScalpDipWindowMin > 0
      ? [rest.liveOscarFastDipScalpDipWindowMin]
      : [];
  const dipAggregationWindowsMin =
    (rest.dipRecoveryVetoEnabled && dipRecoveryVetoWindowsMin.length > 0) ||
    (rest.dipLocalHighVetoEnabled && dipLocalHighVetoWindowsMin.length > 0) ||
    fastDipScalpWindows.length > 0
      ? [
          ...new Set([
            ...dipLookbackWindowsMin,
            ...dipRecoveryVetoWindowsMin,
            ...dipLocalHighVetoWindowsMin,
            ...fastDipScalpWindows,
          ]),
        ].sort((a, b) => a - b)
      : dipLookbackWindowsMin;
  return {
    ...rest,
    dipLookbackWindowsMin,
    dipRecoveryVetoWindowsMin,
    dipLocalHighVetoWindowsMin,
    dipAggregationWindowsMin,
  };
});

export type PaperTraderConfig = z.infer<typeof ConfigSchema> & {
  discoveryDeepAuditWhitelistMintSet?: ReadonlySet<string>;
  /** Tier «Первый выстрел» — typed env slice (see LIVE_OSCAR_PERVYY_VYSTREL_SPEC). */
  pervyyVystrel: PervyyVystrelConfig;
};

function loadMintWhitelistPathToSet(absPath: string): ReadonlySet<string> {
  const s = new Set<string>();
  try {
    if (!fs.existsSync(absPath)) return s;
    const body = fs.readFileSync(absPath, 'utf-8');
    for (const line of body.split(/\r?\n/)) {
      const cut = line.split('#')[0]?.trim();
      if (cut) s.add(cut);
    }
  } catch {
    /* ignore */
  }
  return s;
}

export function loadPaperTraderConfig(): PaperTraderConfig {
  const shyftShadowEnabled = resolveShyftShadowEnabledFromEnv();
  const parsed = ConfigSchema.safeParse({
    strategyId: process.env.PAPER_STRATEGY_ID,
    strategyKind: process.env.PAPER_STRATEGY_KIND,
    storePath: process.env.PAPER_TRADES_PATH,
    discoveryIntervalMs: process.env.PAPER_DISCOVERY_INTERVAL_MS,
    discoveryTickTimeoutMs: process.env.PAPER_DISCOVERY_TICK_TIMEOUT_MS,
    trackIntervalMs: process.env.PAPER_TRACK_INTERVAL_MS,
    followupTickMs: process.env.PAPER_FOLLOWUP_TICK_MS,
    heartbeatIntervalMs: process.env.PAPER_HEARTBEAT_INTERVAL_MS,
    solPriceRefreshMs: process.env.PAPER_SOL_PRICE_REFRESH_MS,
    btcContextRefreshMs: process.env.PAPER_BTC_CONTEXT_REFRESH_MS,
    positionUsd: process.env.PAPER_POSITION_USD,
    entryFirstLegFraction: process.env.PAPER_ENTRY_FIRST_LEG_FRACTION,
    liveStagedEntryEnabled: envBool(process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED, false),
    liveStagedEntryFirstDropPct: process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT,
    liveStagedEntrySecondDropPct: process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT,
    liveStagedEntryThirdDropPct: process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT,
    liveStagedEntryKillDropPct: process.env.PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT,
    liveStagedEntryFirstLegUsd: process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD,
    liveStagedEntrySecondLegUsd: process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD,
    liveStagedEntryThirdLegUsd: process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD,
    liveStagedEntrySignalTtlMs: process.env.PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS,
    liveStagedEntryWaitHours: process.env.PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS,
    liveStagedEntryEntrySplitLegUsd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD,
    liveStagedEntryEntrySplitLeg2Usd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD,
    liveStagedEntryEntrySplitLeg3Usd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD,
    liveStagedEntryEntrySplitLeg4Usd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG4_USD,
    liveStagedEntryEntrySplitLeg5Usd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG5_USD,
    liveStagedEntryEntrySplitLeg6Usd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG6_USD,
    liveStagedEntryEntrySplitLeg7Usd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG7_USD,
    liveStagedEntryEntrySplitLeg8Usd: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG8_USD,
    liveStagedEntryEntrySplitDelayMs: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS,
    liveStagedEntryEntrySplitMaxUpPct: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_UP_PCT,
    liveStagedEntryEntrySplitMaxDownPct: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_DOWN_PCT,
    liveStagedEntryEntrySplitTargetDropPct: process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_TARGET_DROP_PCT,
    liveOscarStalePriceWarnMs: process.env.PAPER_LIVE_OSCAR_STALE_PRICE_WARN_MS,
    liveOscarShyftShadowEnabled: shyftShadowEnabled,
    shyftStreamEnabled: resolveShyftStreamEnabledFromEnv(shyftShadowEnabled),
    liveOscarShyftShadowMaxAgeMs: process.env.PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_AGE_MS,
    liveOscarShyftShadowMaxMints: process.env.PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_MINTS,
    liveOscarShyftShadowConnectGraceMs: process.env.SHYFT_SHADOW_CONNECT_GRACE_MS,
    liveOscarShyftShadowOpenMintsOnly: envBool(process.env.SHYFT_SHADOW_OPEN_MINTS_ONLY, true),
    shyftPricePrimaryEnabled: envBool(process.env.SHYFT_PRICE_PRIMARY_ENABLED, false),
    shyftPricePrimaryMtmEnabled: envBool(process.env.SHYFT_PRICE_PRIMARY_MTM_ENABLED, true),
    shyftPricePrimaryDiscoveryEnabled: envBool(process.env.SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED, false),
    shyftMaxStaleMs: process.env.SHYFT_MAX_STALE_MS,
    shyftDefiMcapEnabled: envBool(process.env.SHYFT_DEFI_MCAP_ENABLED, false),
    shyftDefiMcapTtlMs: process.env.SHYFT_DEFI_MCAP_TTL_MS,
    shyftHoldersEnabled: envBool(process.env.SHYFT_HOLDERS_ENABLED, true),
    shyftHoldersTtlMs: process.env.SHYFT_HOLDERS_TTL_MS,
    shyftHoldersTimeoutMs: process.env.SHYFT_HOLDERS_TIMEOUT_MS,
    birdeyePrimaryEnabled: envBool(process.env.BIRDEYE_PRIMARY_ENABLED, false),
    birdeyeMarketTtlMs: process.env.BIRDEYE_MARKET_TTL_MS,
    birdeyeMaxStaleMs: process.env.BIRDEYE_MAX_STALE_MS,
    birdeyeCoverageGapMinMs: process.env.BIRDEYE_COVERAGE_GAP_MIN_MS,
    birdeyeBatchEnabled: envBool(process.env.BIRDEYE_USE_BATCH ?? process.env.BIRDEYE_BATCH_ENABLED, false),
    liveStagedEntryAvgCooldownMs: process.env.PAPER_LIVE_STAGED_ENTRY_AVG_COOLDOWN_MS,
    liveStagedEntryAvgSecondCooldownMs: process.env.PAPER_LIVE_STAGED_ENTRY_AVG_SECOND_COOLDOWN_MS,
    liveStagedAvgMaxAgeMs: process.env.PAPER_LIVE_STAGED_AVG_MAX_AGE_MS,
    liveStagedAvgMaxDepthPct: process.env.PAPER_LIVE_STAGED_AVG_MAX_DEPTH_PCT,
    dynamicKillstopShadowEnabled: envBool(process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_ENABLED, false),
    dynamicKillstopShadowWindowDays: process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_WINDOW_DAYS,
    dynamicKillstopShadowBufferPct: process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_BUFFER_PCT,
    dynamicKillstopShadowMinKillDropPct: process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_MIN_KILL_DROP_PCT,
    dynamicKillstopShadowMaxKillDropPct: process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_MAX_KILL_DROP_PCT,
    dynamicKillstopShadowSupportClusterPct: process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_SUPPORT_CLUSTER_PCT,
    dynamicKillstopShadowMinTouches: process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_MIN_TOUCHES,
    dynamicKillstopShadowMinHourlySamples: process.env.PAPER_DYNAMIC_KILLSTOP_SHADOW_MIN_HOURLY_SAMPLES,
    btcMints: process.env.PAPER_BTC_MINTS,
    feeBpsPumpfun: process.env.PAPER_FEE_BPS_PUMPFUN,
    feeBpsPumpswap: process.env.PAPER_FEE_BPS_PUMPSWAP,
    feeBpsRaydium: process.env.PAPER_FEE_BPS_RAYDIUM,
    feeBpsOrca: process.env.PAPER_FEE_BPS_ORCA,
    feeBpsMeteora: process.env.PAPER_FEE_BPS_METEORA,
    feeBpsMoonshot: process.env.PAPER_FEE_BPS_MOONSHOT,
    slipBaseBpsPumpfun: process.env.PAPER_SLIP_BASE_BPS_PUMPFUN,
    slipBaseBpsPumpswap: process.env.PAPER_SLIP_BASE_BPS_PUMPSWAP,
    slipBaseBpsRaydium: process.env.PAPER_SLIP_BASE_BPS_RAYDIUM,
    slipBaseBpsOrca: process.env.PAPER_SLIP_BASE_BPS_ORCA,
    slipBaseBpsMeteora: process.env.PAPER_SLIP_BASE_BPS_METEORA,
    slipBaseBpsMoonshot: process.env.PAPER_SLIP_BASE_BPS_MOONSHOT,
    slipLiquidityCoef: process.env.PAPER_SLIP_LIQUIDITY_COEF,
    networkFeeUsd: process.env.PAPER_NETWORK_FEE_USD,
    fillRatePct: process.env.PAPER_FILL_RATE_PCT,
    feeBpsPerSide: process.env.PAPER_FEE_BPS_PER_SIDE,
    slippageBpsPerSide: process.env.PAPER_SLIPPAGE_BPS_PER_SIDE,
    dryRun: envBool(process.env.PAPER_DRY_RUN, false),
    enableLaunchpadLane: envBool(process.env.PAPER_ENABLE_LAUNCHPAD_LANE, false),
    enableMigrationLane: envBool(process.env.PAPER_ENABLE_MIGRATION_LANE, true),
    enablePostLane: envBool(process.env.PAPER_ENABLE_POST_LANE, true),
    decisionAgeMin: process.env.PAPER_DECISION_AGE_MIN,
    decisionAgeMaxMin: process.env.PAPER_DECISION_AGE_MAX_MIN,
    windowStartMin: process.env.PAPER_WINDOW_START_MIN,
    bcGraduationSol: process.env.PAPER_BC_GRADUATION_SOL,
    globalMinTokenAgeMin: process.env.PAPER_MIN_TOKEN_AGE_MIN,
    globalMinHolderCount: process.env.PAPER_MIN_HOLDER_COUNT,
    globalMaxHolderCount: process.env.PAPER_GLOBAL_MAX_HOLDER_COUNT,
    laneMigMinLiqUsd: process.env.PAPER_MIG_MIN_LIQ_USD,
    laneMigMinVol5mUsd: process.env.PAPER_MIG_MIN_VOL_5M_USD,
    laneMigMinBuys5m: process.env.PAPER_MIG_MIN_BUYS_5M,
    laneMigMinSells5m: process.env.PAPER_MIG_MIN_SELLS_5M,
    laneMigMinAgeMin: process.env.PAPER_MIG_MIN_AGE_MIN,
    laneMigMaxAgeMin: process.env.PAPER_MIG_MAX_AGE_MIN,
    laneMigMaxLiqUsd: process.env.PAPER_MIG_MAX_LIQ_USD,
    lanePostMinLiqUsd: process.env.PAPER_POST_MIN_LIQ_USD,
    lanePostMinVol5mUsd: process.env.PAPER_POST_MIN_VOL_5M_USD,
    lanePostMaxVol5mUsd: process.env.PAPER_POST_MAX_VOL_5M_USD,
    lanePostMinBuys5m: process.env.PAPER_POST_MIN_BUYS_5M,
    lanePostMinSells5m: process.env.PAPER_POST_MIN_SELLS_5M,
    lanePostMinAgeMin: process.env.PAPER_POST_MIN_AGE_MIN,
    lanePostMaxAgeMin: process.env.PAPER_POST_MAX_AGE_MIN,
    lanePostMaxLiqUsd: process.env.PAPER_POST_MAX_LIQ_USD,
    discoveryMinMarketCapUsd: process.env.PAPER_DISCOVERY_MIN_MARKET_CAP_USD,
    discoveryMaxMarketCapUsd: process.env.PAPER_DISCOVERY_MAX_MARKET_CAP_USD,
    liveOscarMicroMcapLaneEnabled: envBool(process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED, false),
    liveOscarMicroMcapMinUsd: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD,
    liveOscarMicroMcapMaxUsd: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD,
    liveOscarMicroMcapDipMinDropPct: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_DIP_MIN_DROP_PCT,
    liveOscarMicroMcapVol1hMinUsd: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD,
    liveOscarMicroMcapEntrySplitLegUsd: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD,
    liveOscarMicroMcapEntrySplitLeg2Usd: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD,
    liveOscarMicroMcapPositionUsd: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD,
    liveOscarMicroMcapStagedAvgLegUsd: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD,
    liveOscarMicroMcapStagedAvgDropPct: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_DROP_PCT,
    liveOscarMicroMcapDcaLevelsSpec: process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_DCA_LEVELS,
    liveOscarLowMcapLaneEnabled: envBool(process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED, false),
    liveOscarLowMcapMinUsd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD,
    liveOscarLowMcapMaxUsd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD,
    liveOscarLowMcapDipMinDropPct: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT,
    liveOscarLowMcapVol1hMinUsd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD,
    liveOscarLowMcapEntrySplitLegUsd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD,
    liveOscarLowMcapEntrySplitLeg2Usd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD,
    liveOscarLowMcapEntrySplitLeg3Usd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG3_USD,
    liveOscarLowMcapEntrySplitLeg4Usd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG4_USD,
    liveOscarLowMcapEntrySplitLeg5Usd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG5_USD,
    liveOscarLowMcapPositionUsd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD,
    liveOscarLowMcapStagedAvgDropPct: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT,
    liveOscarLowMcapStagedAvgLegUsd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD,
    liveOscarLowMcapStagedAvgSecondDropPct: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_DROP_PCT,
    liveOscarLowMcapStagedAvgSecondLegUsd: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_LEG_USD,
    liveOscarLowMcapDcaLevelsSpec: process.env.PAPER_LIVE_OSCAR_LOW_MCAP_DCA_LEVELS,
    liveOscarScalpWaveLaneEnabled: envBool(process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED, false),
    liveOscarScalpWaveMinAgeMin: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_AGE_MIN,
    liveOscarScalpWaveMaxAgeMin: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_AGE_MIN,
    liveOscarScalpWaveMinMcapUsd: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_MCAP_USD,
    liveOscarScalpWaveMaxMcapUsd: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD,
    liveOscarScalpWaveDipMinDropPct: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MIN_DROP_PCT,
    liveOscarScalpWaveDipMaxDropPct: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MAX_DROP_PCT,
    liveOscarScalpWaveMinImpulsePct: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MIN_IMPULSE_PCT,
    liveOscarScalpWaveVol1hMinUsd: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_VOL_1H_MIN_USD,
    liveOscarScalpWavePositionUsd: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_POSITION_USD,
    liveOscarScalpWaveMaxConcurrent: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_CONCURRENT,
    liveOscarScalpWaveTpPct: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_TP_PCT,
    liveOscarScalpWaveKillPct: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_KILL_PCT,
    liveOscarScalpWaveTimeStopHours: process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_TIME_STOP_HOURS,
    liveOscarFastDipScalpLaneEnabled: envBool(process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_LANE_ENABLED, false),
    liveOscarFastDipScalpDipWindowMin: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_WINDOW_MIN,
    liveOscarFastDipScalpDipMinDropPct: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_MIN_DROP_PCT,
    liveOscarFastDipScalpDipMaxDropPct: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_DIP_MAX_DROP_PCT,
    liveOscarFastDipScalpMinImpulsePct: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_IMPULSE_PCT,
    liveOscarFastDipScalpMinMcapUsd: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_MCAP_USD,
    liveOscarFastDipScalpMaxMcapUsd: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MAX_MCAP_USD,
    liveOscarFastDipScalpVol1hMinUsd: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_VOL_1H_MIN_USD,
    liveOscarFastDipScalpMinAgeMin: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MIN_AGE_MIN,
    liveOscarFastDipScalpPositionUsd: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_POSITION_USD,
    liveOscarFastDipScalpMaxConcurrent: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_MAX_CONCURRENT,
    liveOscarFastDipScalpKillPct: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_KILL_PCT,
    liveOscarFastDipScalpTimeStopMin: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TIME_STOP_MIN,
    liveOscarFastDipScalpTpRungsPct: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_RUNGS_PCT,
    liveOscarFastDipScalpTpSellFracs: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TP_SELL_FRACS,
    liveOscarFastDipScalpTrailArmPct: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TRAIL_ARM_PCT,
    liveOscarFastDipScalpTrailStepPct: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_TRAIL_STEP_PCT,
    liveOscarFastDipScalpCooldownMin: process.env.PAPER_LIVE_OSCAR_FAST_DIP_SCALP_COOLDOWN_MIN,
    runnerProbeEnabled: envBool(process.env.PAPER_RUNNER_PROBE_ENABLED, false),
    runnerProbeMinAgeMin: process.env.PAPER_RUNNER_PROBE_MIN_AGE_MIN,
    runnerProbeMaxAgeMin: process.env.PAPER_RUNNER_PROBE_MAX_AGE_MIN,
    runnerProbe12hIntelRequired: envBool(process.env.PAPER_RUNNER_PROBE_12H_INTEL_REQUIRED, true),
    runnerProbeMinMcapUsd: process.env.PAPER_RUNNER_PROBE_MIN_MCAP_USD,
    runnerProbeMaxMcapUsd: process.env.PAPER_RUNNER_PROBE_MAX_MCAP_USD,
    runnerProbePositionUsd: process.env.PAPER_RUNNER_PROBE_POSITION_USD,
    runnerProbeMaxConcurrent: process.env.PAPER_RUNNER_PROBE_MAX_CONCURRENT,
    runnerProbeMaxExposureUsd: process.env.PAPER_RUNNER_PROBE_MAX_EXPOSURE_USD,
    runnerProbeDipMinDropPct: process.env.PAPER_RUNNER_PROBE_DIP_MIN_DROP_PCT,
    runnerProbeDipMaxDropPct: process.env.PAPER_RUNNER_PROBE_DIP_MAX_DROP_PCT,
    runnerProbeMinImpulsePct: process.env.PAPER_RUNNER_PROBE_MIN_IMPULSE_PCT,
    runnerProbeVol1hMinUsd: process.env.PAPER_RUNNER_PROBE_VOL_1H_MIN_USD,
    runnerProbeMinVol1hUsd: process.env.PAPER_RUNNER_PROBE_MIN_VOL_1H_USD,
    runnerProbeMinVol12hUsd: process.env.PAPER_RUNNER_PROBE_MIN_VOL_12H_USD,
    runnerProbeVelocityMinX: process.env.PAPER_RUNNER_PROBE_VELOCITY_MIN_X,
    runnerProbeMinVol5mPeak1hUsd: process.env.PAPER_RUNNER_PROBE_MIN_VOL_5M_PEAK_1H_USD,
    runnerProbeBs1hMin: process.env.PAPER_RUNNER_PROBE_BS_1H_MIN,
    runnerProbeBs12hMin: process.env.PAPER_RUNNER_PROBE_BS_12H_MIN,
    runnerProbeLiqVsP25Min: process.env.PAPER_RUNNER_PROBE_LIQ_VS_P25_MIN,
    runnerProbePriceHoldMin: process.env.PAPER_RUNNER_PROBE_PRICE_HOLD_MIN,
    runnerProbeMinLiqUsd: process.env.PAPER_RUNNER_PROBE_MIN_LIQ_USD,
    runnerProbeStaleVolRatioMax: process.env.PAPER_RUNNER_PROBE_STALE_VOL_RATIO_MAX,
    runnerProbeMinPgSamples24h: process.env.PAPER_RUNNER_PROBE_MIN_PG_SAMPLES_24H,
    runnerProbeTpPct: process.env.PAPER_RUNNER_PROBE_TP_PCT,
    runnerProbeKillPct: process.env.PAPER_RUNNER_PROBE_KILL_PCT,
    runnerProbeTimeStopHours: process.env.PAPER_RUNNER_PROBE_TIME_STOP_HOURS,
    runnerProbeDcaLevelsSpec: process.env.PAPER_RUNNER_PROBE_DCA_LEVELS,
    runnerLiteEnabled: envBool(process.env.PAPER_RUNNER_LITE_ENABLED, false),
    runnerLiteMinAgeMin: process.env.PAPER_RUNNER_LITE_MIN_AGE_MIN,
    runnerLiteMaxAgeMin: process.env.PAPER_RUNNER_LITE_MAX_AGE_MIN,
    runnerLite12hIntelRequired: envBool(process.env.PAPER_RUNNER_LITE_12H_INTEL_REQUIRED, false),
    runnerLiteMinMcapUsd: process.env.PAPER_RUNNER_LITE_MIN_MCAP_USD,
    runnerLiteMaxMcapUsd: process.env.PAPER_RUNNER_LITE_MAX_MCAP_USD,
    runnerLitePositionUsd: process.env.PAPER_RUNNER_LITE_POSITION_USD,
    runnerLiteLegUsd: process.env.PAPER_RUNNER_LITE_LEG_USD,
    runnerLiteDcaLevelsSpec: process.env.PAPER_RUNNER_LITE_DCA_LEVELS,
    runnerLiteMaxConcurrent: process.env.PAPER_RUNNER_LITE_MAX_CONCURRENT,
    runnerLiteMaxExposureUsd: process.env.PAPER_RUNNER_LITE_MAX_EXPOSURE_USD,
    runnerLiteDipMinDropPct: process.env.PAPER_RUNNER_LITE_DIP_MIN_DROP_PCT,
    runnerLiteDipMaxDropPct: process.env.PAPER_RUNNER_LITE_DIP_MAX_DROP_PCT,
    runnerLiteMinImpulsePct: process.env.PAPER_RUNNER_LITE_MIN_IMPULSE_PCT,
    runnerLiteVol1hMinUsd: process.env.PAPER_RUNNER_LITE_VOL_1H_MIN_USD,
    runnerLiteMinVol1hUsd: process.env.PAPER_RUNNER_LITE_MIN_VOL_1H_USD,
    runnerLiteMinVol12hUsd: process.env.PAPER_RUNNER_LITE_MIN_VOL_12H_USD,
    runnerLiteVelocityMinX: process.env.PAPER_RUNNER_LITE_VELOCITY_MIN_X,
    runnerLiteMinVol5mPeak1hUsd: process.env.PAPER_RUNNER_LITE_MIN_VOL_5M_PEAK_1H_USD,
    runnerLiteBs1hMin: process.env.PAPER_RUNNER_LITE_BS_1H_MIN,
    runnerLiteBs12hMin: process.env.PAPER_RUNNER_LITE_BS_12H_MIN,
    runnerLiteLiqVsP25Min: process.env.PAPER_RUNNER_LITE_LIQ_VS_P25_MIN,
    runnerLitePriceHoldMin: process.env.PAPER_RUNNER_LITE_PRICE_HOLD_MIN,
    runnerLiteMinLiqUsd: process.env.PAPER_RUNNER_LITE_MIN_LIQ_USD,
    runnerLiteStaleVolRatioMax: process.env.PAPER_RUNNER_LITE_STALE_VOL_RATIO_MAX,
    runnerLiteMinPgSamples24h: process.env.PAPER_RUNNER_LITE_MIN_PG_SAMPLES_24H,
    liveOscarIntelEnabled: envBool(process.env.LIVE_OSCAR_INTEL_ENABLED, false),
    liveOscarIntelMode: process.env.LIVE_OSCAR_INTEL_MODE,
    liveOscarIntelModeRunnerProbe: process.env.LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE,
    liveOscarIntelModeRunnerLite: process.env.LIVE_OSCAR_INTEL_MODE_RUNNER_LITE,
    liveOscarIntelModePervyyVystrel: process.env.LIVE_OSCAR_INTEL_MODE_PERVYY_VYSTREL,
    liveOscarIntelWalletGateEnabled: envBool(process.env.LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED, false),
    liveOscarIntelFailClosed: envBool(process.env.LIVE_OSCAR_INTEL_FAIL_CLOSED, false),
    liveOscarIntelRequireSwapCoverage: envBool(
      process.env.LIVE_OSCAR_INTEL_REQUIRE_SWAP_COVERAGE,
      false,
    ),
    liveOscarIntelEarlyBuyWindowSec: process.env.LIVE_OSCAR_INTEL_EARLY_BUY_WINDOW_SEC,
    liveOscarIntelEarlyBuyWalletCap: process.env.LIVE_OSCAR_INTEL_EARLY_BUY_WALLET_CAP,
    liveOscarIntelBlockIntelBlockTrade: envBool(
      process.env.LIVE_OSCAR_INTEL_BLOCK_INTEL_BLOCK_TRADE,
      true,
    ),
    liveOscarIntelBlockBadTags: envBool(process.env.LIVE_OSCAR_INTEL_BLOCK_BAD_TAGS, true),
    liveOscarIntelBlockClusteredWallets: envBool(
      process.env.LIVE_OSCAR_INTEL_BLOCK_CLUSTERED_WALLETS,
      true,
    ),
    liveOscarIntelBlockScamFarmMeta: envBool(
      process.env.LIVE_OSCAR_INTEL_BLOCK_SCAM_FARM_META,
      true,
    ),
    leraEntryOnchainOverlayEnabled: envBool(process.env.LERA_ENTRY_ONCHAIN_OVERLAY_ENABLED, false),
    leraEntryOnchainOverlayLookbackSec: process.env.LERA_ENTRY_ONCHAIN_OVERLAY_LOOKBACK_SEC,
    leraEntryOnchainOverlayMinSellUsd: process.env.LERA_ENTRY_ONCHAIN_OVERLAY_MIN_SELL_USD,
    leraEntryOnchainOverlayLargeSellUsd: process.env.LERA_ENTRY_ONCHAIN_OVERLAY_LARGE_SELL_USD,
    leraEntryOnchainOverlayWhaleDumpMaxAgeSec: process.env.LERA_ENTRY_ONCHAIN_OVERLAY_WHALE_DUMP_MAX_AGE_SEC,
    leraEntryOnchainOverlayCoordSellWalletMin: process.env.LERA_ENTRY_ONCHAIN_OVERLAY_COORD_SELL_WALLET_MIN,
    leraEntryOnchainOverlayQueryTimeoutMs: process.env.LERA_ENTRY_ONCHAIN_OVERLAY_QUERY_TIMEOUT_MS,
    leraEntryOnchainOverlayBlockIntelBlockTrade: envBool(
      process.env.LERA_ENTRY_ONCHAIN_OVERLAY_BLOCK_INTEL_BLOCK_TRADE,
      true,
    ),
    leraEntryOnchainOverlayBlockBadTags: envBool(
      process.env.LERA_ENTRY_ONCHAIN_OVERLAY_BLOCK_BAD_TAGS,
      true,
    ),
    leraEntryOnchainOverlayBlockClusteredWallets: envBool(
      process.env.LERA_ENTRY_ONCHAIN_OVERLAY_BLOCK_CLUSTERED_WALLETS,
      true,
    ),
    leraEntryOnchainOverlayBlockScamFarmMeta: envBool(
      process.env.LERA_ENTRY_ONCHAIN_OVERLAY_BLOCK_SCAM_FARM_META,
      true,
    ),
    leraOnchainOverlayShyftWatchEnabled: envBool(process.env.LERA_ONCHAIN_OVERLAY_SHYFT_WATCH_ENABLED, false),
    leraEntryOnchainOverlayTelegramEnabled: envBool(
      process.env.LERA_ENTRY_ONCHAIN_OVERLAY_TELEGRAM_ENABLED,
      true,
    ),
    liveOscarProdMcapDipMinDropPct: process.env.PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT,
    liveOscarProdMcapVol1hMinUsd: process.env.PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD,
    liveOscarProdMcapBand12MUsd: process.env.PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD,
    liveOscarProdMcapMaxUsd3_12: process.env.PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD,
    liveOscarProdMcapMaxUsd12Plus: process.env.PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD,
    liveOscarHardPositionMaxUsd: process.env.PAPER_LIVE_OSCAR_HARD_POSITION_MAX_USD,
    snapshotCandidateLimit: process.env.PAPER_SNAPSHOT_CANDIDATE_LIMIT,
    discoveryReevalSec: process.env.PAPER_DISCOVERY_REEVAL_SEC,
    entryRecheckDelayMs: process.env.PAPER_ENTRY_RECHECK_DELAY_MS,
    entryRecheckMinChangePct: process.env.PAPER_ENTRY_RECHECK_MIN_CHANGE_PCT,
    entryRecheckMaxChangePct: process.env.PAPER_ENTRY_RECHECK_MAX_CHANGE_PCT,
    snapshotMinBs: process.env.PAPER_POST_MIN_BS,
    vol5m1hGuardEnabled: envBool(process.env.PAPER_VOL_5M_1H_GUARD_ENABLED, false),
    vol1hMinUsd: process.env.PAPER_VOL_1H_MIN_USD,
    vol1hMaxUsd: process.env.PAPER_VOL_1H_MAX_USD,
    vol5mSpikeMaxMult: process.env.PAPER_VOL_5M_SPIKE_MAX_MULT,
    dipLookbackMin: process.env.PAPER_DIP_LOOKBACK_MIN,
    dipLookbackWindowsCsv: process.env.PAPER_DIP_LOOKBACK_WINDOWS_MIN ?? '',
    dipMinDropPct: process.env.PAPER_DIP_MIN_DROP_PCT,
    dipMaxDropPct: process.env.PAPER_DIP_MAX_DROP_PCT,
    dipMinImpulsePct: process.env.PAPER_DIP_MIN_IMPULSE_PCT,
    dipMinAgeMin: process.env.PAPER_DIP_MIN_AGE_MIN,
    postCrashFastPathEnabled: envBool(process.env.PAPER_POST_CRASH_FAST_PATH_ENABLED, false),
    postCrashFastPathLookbackMin: process.env.PAPER_POST_CRASH_FAST_PATH_LOOKBACK_MIN,
    postCrashFastPathMinPgSamples: process.env.PAPER_POST_CRASH_FAST_PATH_MIN_PG_SAMPLES,
    postCrashFastPathMinDropPct: process.env.PAPER_POST_CRASH_FAST_PATH_MIN_DROP_PCT,
    postCrashFastPathMaxDropPct: process.env.PAPER_POST_CRASH_FAST_PATH_MAX_DROP_PCT,
    postCrashFastPathMinVolSpikeMult: process.env.PAPER_POST_CRASH_FAST_PATH_MIN_VOL_SPIKE_MULT,
    postCrashFastPathStabilizeMin: process.env.PAPER_POST_CRASH_FAST_PATH_STABILIZE_MIN,
    postCrashFastPathMaxAgeMin: process.env.PAPER_POST_CRASH_FAST_PATH_MAX_AGE_MIN,
    postCrashFastPathMaxKnife15mPct: process.env.PAPER_POST_CRASH_FAST_PATH_MAX_KNIFE_15M_PCT,
    postCrashFastPathBypassLocalHighVeto: envBool(
      process.env.PAPER_POST_CRASH_FAST_PATH_BYPASS_LOCAL_HIGH_VETO,
      true,
    ),
    dipCooldownMinDefault: process.env.PAPER_DIP_COOLDOWN_MIN,
    dipCooldownMinScalp: process.env.PAPER_DIP_COOLDOWN_MIN_SCALP,
    dipLossExitCooldownHours: process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS,
    dipLossExitCooldownMinutes: process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES,
    dipLossExitCooldownEnabled: envBool(process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED, true),
    liveReentryMinDropFromLastExitPct:
      process.env.LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT ??
      process.env.PAPER_REENTRY_DIP_BELOW_EXIT_PCT ??
      process.env.PAPER_REENTRY_MIN_DIP_BELOW_EXIT_PCT,
    liveReentryBreakoutAboveExitPct:
      process.env.LIVE_REENTRY_BREAKOUT_ABOVE_EXIT_PCT ??
      process.env.PAPER_REENTRY_ABORT_DIP_WAIT_ABOVE_EXIT_PCT ??
      process.env.PAPER_REENTRY_BREAKOUT_ABOVE_EXIT_PCT,
    liveReentryMaxWaitMinutes: process.env.LIVE_REENTRY_MAX_WAIT_MINUTES,
    liveReentryLossMinDropFromLastExitPct: process.env.LIVE_REENTRY_LOSS_MIN_DROP_FROM_LAST_EXIT_PCT,
    liveReentryHybridDisableTimerAfterLoss: envBool(
      process.env.LIVE_REENTRY_HYBRID_DISABLE_TIMER_AFTER_LOSS,
      true,
    ),
    liveReentryGateMaxAgeHours: (() => {
      const s = process.env.LIVE_REENTRY_GATE_MAX_AGE_HOURS?.trim();
      if (!s) return 4;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 168) : 4;
    })(),
    liveStressReentryEnabled: envBool(process.env.LIVE_STRESS_REENTRY_ENABLED, true),
    liveStressReentryMinDropFromLastExitPct: process.env.LIVE_STRESS_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT,
    liveStressReentryRecoveryVetoMaxBouncePct:
      process.env.LIVE_STRESS_REENTRY_RECOVERY_VETO_MAX_BOUNCE_PCT,
    liveStressReentryRecoveryVetoMaxWindowMin:
      process.env.LIVE_STRESS_REENTRY_RECOVERY_VETO_MAX_WINDOW_MIN,
    liveStressReentryDipMaxDropPct: process.env.LIVE_STRESS_REENTRY_DIP_MAX_DROP_PCT,
    discoveryDeepAuditJsonl: envBool(process.env.LIVE_DISCOVERY_DEEP_AUDIT_JSONL, false),
    discoveryDeepAuditWhitelistPath: process.env.LIVE_DISCOVERY_DEEP_AUDIT_WHITELIST_PATH?.trim() || undefined,
    discoveryDeepAuditUniverseMissMinMs: (() => {
      const s = process.env.LIVE_DISCOVERY_DEEP_AUDIT_UNIVERSE_MISS_MIN_MS?.trim();
      if (!s) return 60_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 5_000 ? Math.min(n, 3_600_000) : 60_000;
    })(),
    whitelistSnapshotLookbackMin: process.env.PAPER_WHITELIST_SNAPSHOT_LOOKBACK_MIN,
    priorityDiscoveryEnabled: envBool(process.env.PAPER_PRIORITY_DISCOVERY_ENABLED, true),
    priorityDiscoveryReevalSec: process.env.PAPER_PRIORITY_DISCOVERY_REEVAL_SEC,
    priorityDiscoveryLookbackMin: process.env.PAPER_PRIORITY_DISCOVERY_LOOKBACK_MIN,
    priorityDiscoveryRecentEvalMin: process.env.PAPER_PRIORITY_DISCOVERY_RECENT_EVAL_MIN,
    priorityDiscoveryMaxMints: process.env.PAPER_PRIORITY_DISCOVERY_MAX_MINTS,
    priorityDiscoveryJupiterRefreshEnabled: envBool(
      process.env.PAPER_PRIORITY_DISCOVERY_JUPITER_REFRESH,
      true,
    ),
    priorityDiscoveryJupiterRefreshMaxPerTick:
      process.env.PAPER_PRIORITY_DISCOVERY_JUPITER_MAX_PER_TICK,
    priorityDiscoveryNearMissJupiterRefreshEnabled: envBool(
      process.env.PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_REFRESH,
      true,
    ),
    priorityDiscoveryNearMissJupiterGapPct:
      process.env.PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_GAP_PCT,
    priorityDiscoveryNearMissJupiterRefreshMaxPerTick:
      process.env.PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_MAX_PER_TICK,
    priorityDiscoveryMinBs: process.env.PAPER_PRIORITY_DISCOVERY_MIN_BS,
    volumeLeaderEnabled: envBool(process.env.PAPER_VOLUME_LEADER_ENABLED, false),
    volumeLeaderTopN: process.env.PAPER_VOLUME_LEADER_TOP_N,
    volumeLeaderReevalSec: process.env.PAPER_VOLUME_LEADER_REEVAL_SEC,
    volumeLeaderLookbackHours: process.env.PAPER_VOLUME_LEADER_LOOKBACK_HOURS,
    volumeLeaderQueryCacheSec: process.env.PAPER_VOLUME_LEADER_QUERY_CACHE_SEC,
    volumeLeaderSnapshotLookbackMin: process.env.PAPER_VOLUME_LEADER_SNAPSHOT_LOOKBACK_MIN,
    volumeLeaderMinTokenAgeMin: process.env.PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN,
    discoverySnapshotSanityEnabled: envBool(process.env.PAPER_DISCOVERY_SNAPSHOT_SANITY_ENABLED, true),
    discoverySnapshotSanityRefMcapMinUsd: process.env.PAPER_DISCOVERY_SNAPSHOT_SANITY_REF_MCAP_MIN_USD,
    discoverySnapshotSanityMinLiqToMcapRatio:
      process.env.PAPER_DISCOVERY_SNAPSHOT_SANITY_MIN_LIQ_TO_MCAP_RATIO,
    discoverySnapshotSanityMinLiqShareOfMintMax:
      process.env.PAPER_DISCOVERY_SNAPSHOT_SANITY_MIN_LIQ_SHARE_OF_MINT_MAX,
    discoverySnapshotSanityZeroLiqMaxMcapUsd:
      process.env.PAPER_DISCOVERY_SNAPSHOT_SANITY_ZERO_LIQ_MAX_MCAP_USD,
    volumeLeaderJupiterCrossCheckEnabled: envBool(
      process.env.PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_ENABLED,
      true,
    ),
    volumeLeaderJupiterCrossCheckMaxPerTick:
      process.env.PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MAX_PER_TICK,
    volumeLeaderJupiterCrossCheckMaxDivergencePct:
      process.env.PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MAX_DIVERGENCE_PCT,
    volumeLeaderJupiterCrossCheckMinDivergencePct:
      process.env.PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MIN_DIVERGENCE_PCT,
    mintBlacklistEnabled: envBool(process.env.LIVE_MINT_BLACKLIST_ENABLED, false),
    mintBlacklistPath: process.env.LIVE_MINT_BLACKLIST_PATH?.trim() || 'data/live/live-oscar-mint-blacklist.txt',
    liveExitModeAbEnabled: envBool(process.env.PAPER_LIVE_EXIT_MODE_AB, false),
    liveExitModeBTrailDrop: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP),
    liveExitModeBTrailTriggerX: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X),
    liveExitModeBTimeoutHours: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TIMEOUT_HOURS),
    liveExitModeBTpGridStepPnl: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL),
    liveExitModeBTpGridSellFraction: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION),
    liveExitModeBTpGridFirstRungRetraceMinPnlPct: envOptNum(
      process.env.PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL,
    ),
    liveExitModeBTpGridMaxRungs: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS),
    liveExitModeBDcaKillstop: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP),
    liveExitModeBPeakLogStepPct: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_PEAK_LOG_STEP_PCT),
    livePartialTpMinIntervalMs: (() => {
      const raw =
        process.env.PAPER_LIVE_PARTIAL_TP_MIN_INTERVAL_MS ??
        process.env.LIVE_PARTIAL_TP_MIN_INTERVAL_MS;
      if (raw === undefined || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined;
    })(),
    idealizedOscarModeBArmFrac:
      envOptNum(process.env.PAPER_IDEALIZED_OSCAR_MODE_B_ARM_FRAC) ?? -0.04,
    dipRecoveryVetoEnabled: envBool(process.env.PAPER_DIP_RECOVERY_VETO_ENABLED, false),
    dipRecoveryVetoWindowsCsv: process.env.PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN ?? '',
    dipRecoveryVetoMaxBouncePct: process.env.PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT,
    dipLocalHighVetoEnabled: envBool(process.env.PAPER_DIP_LOCAL_HIGH_VETO_ENABLED, false),
    dipLocalHighVetoWindowsCsv: process.env.PAPER_DIP_LOCAL_HIGH_VETO_WINDOWS_MIN ?? '',
    dipLocalHighVetoMaxDistancePct: process.env.PAPER_DIP_LOCAL_HIGH_VETO_MAX_DISTANCE_PCT,
    trendStructureVetoEnabled: envBool(process.env.PAPER_TREND_STRUCTURE_VETO_ENABLED, false),
    trendVetoLookbackDays: process.env.PAPER_TREND_VETO_LOOKBACK_DAYS,
    trendVetoMinPgSamples: process.env.PAPER_TREND_VETO_MIN_PG_SAMPLES,
    trendVetoNoHighBreakEnabled: envBool(process.env.PAPER_TREND_VETO_NO_HIGH_BREAK_ENABLED, true),
    trendVetoMinDaysSinceHighBreak: process.env.PAPER_TREND_VETO_MIN_DAYS_SINCE_HIGH_BREAK,
    trendVetoDeclineEnabled: envBool(process.env.PAPER_TREND_VETO_DECLINE_ENABLED, true),
    trendVetoMaxPxVsHigh14d: process.env.PAPER_TREND_VETO_MAX_PX_VS_HIGH_14D,
    trendVetoMaxSlope7dPct: process.env.PAPER_TREND_VETO_MAX_SLOPE_7D_PCT,
    trendVetoPeakTouchTolerancePct: process.env.PAPER_TREND_VETO_PEAK_TOUCH_TOLERANCE_PCT,
    policyAPlusEnabled: envBool(process.env.PAPER_POLICY_A_PLUS_ENABLED, false),
    policyAPlusBounceFromMin30mEnabled: envBool(
      process.env.PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_ENABLED,
      true,
    ),
    policyAPlusBounceFromMin30mMaxPct:
      process.env.PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT,
    policyAPlusPriceChange1hEnabled: envBool(
      process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_ENABLED,
      true,
    ),
    policyAPlusPriceChange1hMinPct: process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_MIN_PCT,
    policyAPlusVol1hEnabled: envBool(process.env.PAPER_POLICY_A_PLUS_VOL_1H_ENABLED, true),
    policyAPlusVol1hMaxUsd: process.env.PAPER_POLICY_A_PLUS_VOL_1H_MAX_USD,
    policyAPlusPriceChange30mEnabled: envBool(
      process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_ENABLED,
      true,
    ),
    policyAPlusPriceChangeWindowMin: process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_WINDOW_MIN,
    policyAPlusPriceChange30mMinPct: process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT,
    runnerModeEnabled: envBool(process.env.PAPER_RUNNER_MODE_ENABLED, false),
    runnerMinPgSamples24h: process.env.PAPER_RUNNER_MIN_PG_SAMPLES_24H,
    runnerMinVol1hUsd: process.env.PAPER_RUNNER_MIN_VOL_1H_USD,
    runnerMinVol12hUsd: process.env.PAPER_RUNNER_MIN_VOL_12H_USD,
    runnerVelocityMinX: process.env.PAPER_RUNNER_VELOCITY_MIN_X,
    runnerMinVol5mPeak1hUsd: process.env.PAPER_RUNNER_MIN_VOL_5M_PEAK_1H_USD,
    runnerBs1hMin: process.env.PAPER_RUNNER_BS_1H_MIN,
    runnerBs12hMin: process.env.PAPER_RUNNER_BS_12H_MIN,
    runnerLiqVsP25Min: process.env.PAPER_RUNNER_LIQ_VS_P25_MIN,
    runnerPriceHoldMin: process.env.PAPER_RUNNER_PRICE_HOLD_MIN,
    runnerMinMcapUsd: process.env.PAPER_RUNNER_MIN_MCAP_USD,
    runnerMaxMcapUsd: process.env.PAPER_RUNNER_MAX_MCAP_USD,
    runnerMinLiqUsd: process.env.PAPER_RUNNER_MIN_LIQ_USD,
    runnerStaleVolRatioMax: process.env.PAPER_RUNNER_STALE_VOL_RATIO_MAX,
    volumeSybilGuardEnabled: envBool(process.env.PAPER_VOLUME_SYBIL_GUARD_ENABLED, false),
    volumeSybilLookbackHours: process.env.PAPER_VOLUME_SYBIL_LOOKBACK_HOURS,
    volumeSybilRecentMinutes: process.env.PAPER_VOLUME_SYBIL_RECENT_MINUTES,
    volumeSybilBaselineP10MaxUsd: process.env.PAPER_VOLUME_SYBIL_BASELINE_P10_MAX_USD,
    volumeSybilMinBaselineSamples: process.env.PAPER_VOLUME_SYBIL_MIN_BASELINE_SAMPLES,
    volumeSybilMinRecentVol5mUsd: process.env.PAPER_VOLUME_SYBIL_MIN_RECENT_VOL5M_USD,
    volumeSybilSpikeRatioMin: process.env.PAPER_VOLUME_SYBIL_SPIKE_RATIO_MIN,
    volumeSybilDeadVol5mUsd: process.env.PAPER_VOLUME_SYBIL_DEAD_VOL5M_USD,
    volumeSybilMinDeadFraction: process.env.PAPER_VOLUME_SYBIL_MIN_DEAD_FRACTION,
    volumeSybilVol1hAliveExemptUsd: process.env.PAPER_VOLUME_SYBIL_VOL1H_ALIVE_EXEMPT_USD,
    volumeGuardNewMintMinVol5mToVol1hRatio: process.env.PAPER_VOLUME_GUARD_NEW_MINT_MIN_VOL5M_TO_VOL1H_RATIO,
    volumeGuardNewMintVol1hWashMinUsd: process.env.PAPER_VOLUME_GUARD_NEW_MINT_VOL1H_WASH_MIN_USD,
    volumeEphemeralGuardEnabled: envBool(process.env.PAPER_VOLUME_EPHEMERAL_GUARD_ENABLED, false),
    volumeEphemeralLookbackHours: process.env.PAPER_VOLUME_EPHEMERAL_LOOKBACK_HOURS,
    volumeEphemeralMinActiveHourVol5mUsd: process.env.PAPER_VOLUME_EPHEMERAL_MIN_ACTIVE_HOUR_VOL5M_USD,
    volumeEphemeralMaxActiveHours: process.env.PAPER_VOLUME_EPHEMERAL_MAX_ACTIVE_HOURS,
    volumeEphemeralMinPeakVol5mUsd: process.env.PAPER_VOLUME_EPHEMERAL_MIN_PEAK_VOL5M_USD,
    volumeEphemeralMinHoursWithData: process.env.PAPER_VOLUME_EPHEMERAL_MIN_HOURS_WITH_DATA,
    volumeEphemeralSparseHoursBuffer: process.env.PAPER_VOLUME_EPHEMERAL_SPARSE_HOURS_BUFFER,
    volumeEphemeralTailBlockEnabled: envBool(process.env.PAPER_VOLUME_EPHEMERAL_TAIL_BLOCK_ENABLED, true),
    volumeEphemeralTailMaxPeakRatio: process.env.PAPER_VOLUME_EPHEMERAL_TAIL_MAX_PEAK_RATIO,
    volumeEphemeralNewMintMinActiveHours: process.env.PAPER_VOLUME_EPHEMERAL_NEW_MINT_MIN_ACTIVE_HOURS,
    volumeEphemeralBirdeyeFreshBypass: envBool(
      process.env.PAPER_VOLUME_EPHEMERAL_BIRDEYE_FRESH_BYPASS,
      true,
    ),
    oldMintDormantVolSpikeGuardEnabled: envBool(
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_GUARD_ENABLED,
      false,
    ),
    oldMintDormantVolSpikeMinTokenAgeDays: process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_TOKEN_AGE_DAYS,
    oldMintDormantVolSpikeMaxYoungTokenAgeDays:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MAX_YOUNG_TOKEN_AGE_DAYS,
    oldMintDormantVolSpikeLookbackHours: process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_LOOKBACK_HOURS,
    oldMintDormantVolSpikeBaselineStartHoursAgo:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_BASELINE_START_HOURS ??
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_DORMANT_LOOKBACK_HOURS,
    oldMintDormantVolSpikeBaselineEndHoursAgo:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_BASELINE_END_HOURS,
    oldMintDormantVolSpikeDormantLookbackHours:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_DORMANT_LOOKBACK_HOURS,
    oldMintDormantVolSpikeRecentHours: process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_RECENT_HOURS,
    oldMintDormantVolSpikeDormantVol1hMaxUsd:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_DORMANT_VOL1H_MAX_USD,
    oldMintDormantVolSpikeDormantVol5mMaxUsd:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_DORMANT_VOL5M_MAX_USD,
    oldMintDormantVolSpikeMinDormantHourFraction:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_DORMANT_HOUR_FRACTION,
    oldMintDormantVolSpikeMinBaselineHours:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_BASELINE_HOURS,
    oldMintDormantVolSpikeMinSpikeVol1hUsd:
      process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_MIN_SPIKE_VOL1H_USD,
    oldMintDormantVolSpikeVol1hRatioMin: process.env.PAPER_OLD_MINT_DORMANT_VOL_SPIKE_VOL1H_RATIO_MIN,
    pgDataCoverageGuardEnabled: envBool(process.env.PAPER_PG_DATA_COVERAGE_GUARD_ENABLED, false),
    pgDataCoverageLookbackHours: process.env.PAPER_PG_DATA_COVERAGE_LOOKBACK_HOURS,
    pgDataCoverageRecentHours: process.env.PAPER_PG_DATA_COVERAGE_RECENT_HOURS,
    pgDataCoverageMinRecentHoursWithData: process.env.PAPER_PG_DATA_COVERAGE_MIN_RECENT_HOURS_WITH_DATA,
    pgDataCoverageMinHourRatio: process.env.PAPER_PG_DATA_COVERAGE_MIN_HOUR_RATIO,
    pgDataCoverageStrictMinHourRatio: process.env.PAPER_PG_DATA_COVERAGE_STRICT_MIN_HOUR_RATIO,
    pgDataCoverageMinSystemHourRatio: process.env.PAPER_PG_DATA_COVERAGE_MIN_SYSTEM_HOUR_RATIO,
    pgDataCoverageMinMinutesPerHour: process.env.PAPER_PG_DATA_COVERAGE_MIN_MINUTES_PER_HOUR,
    pgDataCoverageMaxGapMinutes: process.env.PAPER_PG_DATA_COVERAGE_MAX_GAP_MINUTES,
    pgDataCoverageBlockOnPgStale: envBool(process.env.PAPER_PG_DATA_COVERAGE_BLOCK_ON_PG_STALE, true),
    pgDataCoverageBlockBuy: envBool(process.env.PAPER_PG_DATA_COVERAGE_BLOCK_BUY, false),
    pgDataCoverageStrictAfterRecoveryHours: process.env.PAPER_PG_DATA_COVERAGE_STRICT_AFTER_RECOVERY_HOURS,
    pgDataCoverageAutoEscalate: envBool(process.env.PAPER_PG_DATA_COVERAGE_AUTO_ESCALATE, true),
    pgDataCoverageKnownMintGapBypass: envBool(
      process.env.PAPER_PG_DATA_COVERAGE_KNOWN_MINT_GAP_BYPASS,
      false,
    ),
    pgDataCoverageKnownMintLookbackDays: process.env.PAPER_PG_DATA_COVERAGE_KNOWN_MINT_LOOKBACK_DAYS,
    pgCoverageBirdeyeFreshBypass: envBool(process.env.PAPER_PG_COVERAGE_BIRDEYE_FRESH_BYPASS, true),
    whaleEnabled: envBool(process.env.PAPER_DIP_WHALE_ANALYSIS_ENABLED, false),
    whaleRequireTrigger: envBool(process.env.PAPER_DIP_REQUIRE_WHALE_TRIGGER, false),
    whaleLargeSellUsd: process.env.PAPER_DIP_LARGE_SELL_USD,
    whaleRecentLookbackMin: process.env.PAPER_DIP_RECENT_LOOKBACK_MIN,
    whaleCapitulationPct: process.env.PAPER_DIP_CAPITULATION_PCT,
    whaleGroupSellUsd: process.env.PAPER_DIP_GROUP_SELL_USD,
    whaleGroupMinSellers: process.env.PAPER_DIP_GROUP_MIN_SELLERS,
    whaleGroupDumpPct: process.env.PAPER_DIP_GROUP_DUMP_PCT,
    whaleBlockCreatorDump: envBool(process.env.PAPER_DIP_BLOCK_CREATOR_DUMP, true),
    whaleCreatorDumpLookbackMin: process.env.PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN,
    whaleCreatorDumpMinPct: process.env.PAPER_DIP_CREATOR_DUMP_MIN_PCT,
    whaleCreatorDumpMaxPct: process.env.PAPER_DIP_CREATOR_DUMP_MAX_PCT,
    whaleDcaPredMinSells24h: process.env.PAPER_DIP_DCA_PRED_MIN_SELLS_24H,
    whaleDcaPredMinIntervalMin: process.env.PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN,
    whaleDcaPredMinChunkUsd: process.env.PAPER_DIP_DCA_PRED_MIN_CHUNK_USD,
    whaleDcaAggrMinSells24h: process.env.PAPER_DIP_DCA_AGGR_MIN_SELLS_24H,
    whaleDcaAggrMaxIntervalMin: process.env.PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN,
    whaleSilenceMinAfterLastSell: process.env.PAPER_DIP_WHALE_SILENCE_MIN,
    filtMinUniqueBuyers: process.env.PAPER_MIN_UNIQUE_BUYERS,
    filtMinBuySol: process.env.PAPER_MIN_BUY_SOL,
    filtMinBuySellRatio: process.env.PAPER_MIN_BUY_SELL_RATIO,
    filtMaxTopBuyerShare: process.env.PAPER_MAX_TOP_BUYER_SHARE,
    filtMinBcProgress: process.env.PAPER_MIN_BC_PROGRESS,
    filtMaxBcProgress: process.env.PAPER_MAX_BC_PROGRESS,
    tpX: process.env.PAPER_TP_X,
    slX: process.env.PAPER_SL_X,
    trailDrop: process.env.PAPER_TRAIL_DROP,
    trailTriggerX: process.env.PAPER_TRAIL_TRIGGER_X,
    trailMode: (() => {
      const m = process.env.PAPER_TRAIL_MODE;
      if (m === 'ladder_retrace') return 'ladder_retrace' as const;
      if (m === 'stepped_grid') return 'stepped_grid' as const;
      return 'peak' as const;
    })(),
    liveOscarExitPolicyWaveBEnabled: (() => {
      const waveOscar = envBool(process.env.PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B, false);
      const waveLera = envBool(process.env.PAPER_LIVE_LERA_EXIT_POLICY_WAVE_B, false);
      const sid = (process.env.PAPER_STRATEGY_ID ?? '').trim();
      if (isLiveLeraTradingStrategyId(sid)) return waveLera || waveOscar;
      return waveOscar;
    })(),
    liveOscarExitPolicyWaveBTrailSellFraction:
      process.env.PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION,
    liveOscarWaveBFlatTpEnabled: envBool(process.env.PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP, false),
    liveOscarWaveBFlatTpMode:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP_MODE === 'flat' ? 'flat' : 'half8_runner',
    liveOscarWaveBTimeStopHours: process.env.PAPER_LIVE_OSCAR_WAVE_B_TIME_STOP_HOURS,
    liveOscarHardTimeStopHours: process.env.PAPER_LIVE_OSCAR_HARD_TIME_STOP_HOURS,
    liveOscarExitPolicyVariantAEnabled: envBool(process.env.PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A, false),
    liveOscarVariantAMoonTargetPct: process.env.PAPER_LIVE_OSCAR_VARIANT_A_MOON_TARGET_PCT,
    liveOscarVariantATrailArmPct: process.env.PAPER_LIVE_OSCAR_VARIANT_A_TRAIL_ARM_PCT,
    liveOscarVariantATrailRetracePct: process.env.PAPER_LIVE_OSCAR_VARIANT_A_TRAIL_RETRACE_PCT,
    liveOscarVariantASalvage24Enabled: envBool(process.env.PAPER_LIVE_OSCAR_VARIANT_A_SALVAGE24_ENABLED, true),
    liveOscarVariantASalvage24MinPeakPct: process.env.PAPER_LIVE_OSCAR_VARIANT_A_SALVAGE24_MIN_PEAK_PCT,
    liveOscarVariantASmart48Enabled: envBool(process.env.PAPER_LIVE_OSCAR_VARIANT_A_SMART48_ENABLED, true),
    liveOscarVariantAMaxHorizonHours: process.env.PAPER_LIVE_OSCAR_VARIANT_A_MAX_HORIZON_HOURS,
    liveOscarVariantAScratchGapTailPct: process.env.PAPER_LIVE_OSCAR_VARIANT_A_SCRATCH_GAP_TAIL_PCT,
    timeoutHours: process.env.PAPER_TIMEOUT_HOURS,
    liveOscarBreakevenTrimAfterFirstTpEnabled: envBool(
      process.env.PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED,
      false,
    ),
    liveOscarBreakevenTrimFraction: process.env.PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_FRACTION,
    liveOscarWaveBBreakevenInsuranceEnabled: envBool(
      process.env.PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_ENABLED,
      false,
    ),
    liveOscarWaveBBreakevenInsuranceFraction:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_FRACTION,
    liveOscarWaveBBreakevenInsurancePnlFrac:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_PNL_FRAC,
    liveOscarWaveBPreArmNoHalf8LadderEnabled: envBool(
      process.env.PAPER_LIVE_OSCAR_WAVE_B_PRE_ARM_NO_HALF8_LADDER_ENABLED,
      true,
    ),
    liveOscarWaveBPreArmNoHalf8PartialPnlFrac:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_PRE_ARM_NO_HALF8_PARTIAL_PNL_FRAC,
    liveOscarWaveBPreArmNoHalf8PullbackPnlFrac:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_PRE_ARM_NO_HALF8_PULLBACK_PNL_FRAC,
    liveOscarWaveBPreArmNoHalf8PartialFraction:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_PRE_ARM_NO_HALF8_PARTIAL_FRACTION,
    liveOscarDip10FirstTp5Enabled: envBool(process.env.PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_ENABLED, true),
    liveOscarDip10FirstTp5PartialPnlFrac: process.env.PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_PARTIAL_PNL_FRAC,
    liveOscarDip10FirstTp5PartialFraction:
      process.env.PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_PARTIAL_FRACTION,
    liveOscarDip10FirstTp5SignalDropPct: process.env.PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_SIGNAL_DROP_PCT,
    liveOscarWaveBPostTp1DeriskEnabled: envBool(
      process.env.PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_DERISK_ENABLED,
      false,
    ),
    liveOscarWaveBPostTp1DeriskPnlFrac: process.env.PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_DERISK_PNL_FRAC,
    liveOscarWaveBPostTp1DeriskFraction: process.env.PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_DERISK_FRACTION,
    liveOscarWaveBPostTp1ScratchReentryEnabled: envBool(
      process.env.PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_ENABLED,
      false,
    ),
    liveOscarWaveBPostTp1ScratchDropPct:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_DROP_PCT,
    liveOscarWaveBPostTp1ScratchReentryDropPct:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_DROP_PCT,
    liveOscarWaveBPostTp1ScratchReentryUsd:
      process.env.PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_USD,
    liveOscarThinVolExitEnabled: envBool(process.env.PAPER_LIVE_OSCAR_THIN_VOL_EXIT_ENABLED, false),
    dcaLevelsSpec: process.env.PAPER_DCA_LEVELS,
    dcaKillstop: process.env.PAPER_DCA_KILLSTOP,
    tpLadderSpec: process.env.PAPER_TP_LADDER,
    tpGridStepPnl: process.env.PAPER_TP_GRID_STEP_PNL,
    tpGridSellFraction: process.env.PAPER_TP_GRID_SELL_FRACTION,
    tpGridSellFractionByStep: parseTpGridSellFractionProfile(process.env.PAPER_TP_GRID_SELL_FRACTION_PROFILE),
    tpGridFirstRungRetraceMinPnlPct: process.env.PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL,
    tpGridMaxRungs: envOptNum(process.env.PAPER_TP_GRID_MAX_RUNGS),
    tpRegimeEnabled: envBool(process.env.PAPER_TP_REGIME_ENABLED, false),
    tpRegimeLookbackMin: process.env.PAPER_TP_REGIME_LOOKBACK_MIN,
    tpRegimeMinSamples: process.env.PAPER_TP_REGIME_MIN_SAMPLES,
    tpRegimeDownNetPct: process.env.PAPER_TP_REGIME_DOWN_NET_PCT,
    tpRegimeUpNetPct: process.env.PAPER_TP_REGIME_UP_NET_PCT,
    tpRegimeSidewaysAbsNetPct: process.env.PAPER_TP_REGIME_SIDEWAYS_ABS_NET_PCT,
    tpRegimeSidewaysMinRangePct: process.env.PAPER_TP_REGIME_SIDEWAYS_MIN_RANGE_PCT,
    tpRegimeDownDcaKillstop: (() => {
      const raw = process.env.PAPER_TP_REGIME_DOWN_DCA_KILLSTOP;
      if (raw === undefined || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n < 0 ? n : undefined;
    })(),
    followupOffsetsMinSpec: process.env.PAPER_FOLLOWUP_OFFSETS_MIN,
    contextSwapsEnabled: envBool(process.env.PAPER_CONTEXT_SWAPS, true),
    contextSwapsLimit: process.env.PAPER_CONTEXT_SWAPS_LIMIT,
    preEntryDynamicsEnabled: envBool(process.env.PAPER_PRE_ENTRY_DYNAMICS, true),
    peakLogStepPct: process.env.PAPER_PEAK_LOG_STEP_PCT,
    statsIntervalMs: process.env.PAPER_STATS_INTERVAL_MS,
    safetyCheckEnabled: process.env.PAPER_SAFETY_CHECK_ENABLED === '1',
    safetyTopHolderMaxPct: (() => {
      const n = Number(process.env.PAPER_SAFETY_TOP_HOLDER_MAX_PCT ?? 40);
      const x = Number.isFinite(n) ? n : 40;
      return Math.max(0, Math.min(100, x));
    })(),
    safetyRequireMintAuthNull: process.env.PAPER_SAFETY_REQUIRE_MINT_AUTH_NULL !== '0',
    safetyRequireFreezeAuthNull: process.env.PAPER_SAFETY_REQUIRE_FREEZE_AUTH_NULL !== '0',
    safetyTimeoutMs: (() => {
      const n = Number(process.env.PAPER_SAFETY_TIMEOUT_MS || 2500);
      const x = Number.isFinite(n) ? n : 2500;
      return Math.max(500, Math.min(10_000, x));
    })(),
    priorityFeeEnabled: process.env.PAPER_PRIORITY_FEE_ENABLED === '1',
    priorityFeeTickerMs: process.env.PAPER_PRIORITY_FEE_TICKER_MS,
    priorityFeeMaxAgeMs: process.env.PAPER_PRIORITY_FEE_MAX_AGE_MS,
    priorityFeeRpcTimeoutMs: process.env.PAPER_PRIORITY_FEE_RPC_TIMEOUT_MS,
    priorityFeePercentile: (() => {
      const v = process.env.PAPER_PRIORITY_FEE_PERCENTILE;
      if (v === 'p50' || v === 'p75' || v === 'p90') return v;
      return undefined;
    })(),
    priorityFeeTargetCu: process.env.PAPER_PRIORITY_FEE_TARGET_CU,
    priceVerifyEnabled: process.env.PAPER_PRICE_VERIFY_ENABLED === '1',
    priceVerifyBlockOnFail: process.env.PAPER_PRICE_VERIFY_BLOCK_ON_FAIL === '1',
    priceVerifyUseJupiterPrice: process.env.PAPER_PRICE_VERIFY_USE_JUPITER_PRICE === '1',
    priceVerifyMaxSlipPct: process.env.PAPER_PRICE_VERIFY_MAX_SLIP_PCT,
    priceVerifyMaxSlipBps: process.env.PAPER_PRICE_VERIFY_MAX_SLIP_BPS,
    priceVerifyMaxPriceImpactPct: process.env.PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT,
    priceVerifyTimeoutMs: process.env.PAPER_PRICE_VERIFY_TIMEOUT_MS,
    priceVerifyExitEnabled: process.env.PAPER_PRICE_VERIFY_EXIT_ENABLED === '1',
    priceVerifyExitBlockOnFail: process.env.PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL === '1',
    priceVerifyExitMaxDefersEscalation: process.env.PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION,
    priceVerifyQuoteRetriesEnabled: envBool(process.env.PAPER_PRICE_VERIFY_QUOTE_RETRIES_ENABLED, true),
    priceVerifyQuoteMaxAttempts: process.env.PAPER_PRICE_VERIFY_QUOTE_MAX_ATTEMPTS,
    priceVerifyQuoteRetryBackoffMs: process.env.PAPER_PRICE_VERIFY_QUOTE_RETRY_BACKOFF_MS,
    priceVerifyCircuitEnabled: envBool(process.env.PAPER_PRICE_VERIFY_CIRCUIT_ENABLED, true),
    priceVerifyCircuitWindowMs: process.env.PAPER_PRICE_VERIFY_CIRCUIT_WINDOW_MS,
    priceVerifyCircuitSkipRatePct: process.env.PAPER_PRICE_VERIFY_CIRCUIT_SKIP_RATE_PCT,
    priceVerifyCircuitMinAttempts: process.env.PAPER_PRICE_VERIFY_CIRCUIT_MIN_ATTEMPTS,
    priceVerifyCircuitCooldownMs: process.env.PAPER_PRICE_VERIFY_CIRCUIT_COOLDOWN_MS,
    liqWatchEnabled: process.env.PAPER_LIQ_WATCH_ENABLED === '1',
    liqWatchForceClose: process.env.PAPER_LIQ_WATCH_FORCE_CLOSE === '1',
    liqWatchDrainPct: process.env.PAPER_LIQ_WATCH_DRAIN_PCT,
    liqWatchMinAgeMin: process.env.PAPER_LIQ_WATCH_MIN_AGE_MIN,
    liqWatchConsecutiveFailures: process.env.PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES,
    liqWatchSnapshotMaxAgeMs: process.env.PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS,
    liqWatchRpcFallback: process.env.PAPER_LIQ_WATCH_RPC_FALLBACK === '1',
    liqWatchStampOnAllClose: process.env.PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE !== '0',
    liqWatchStampOnTrack: process.env.PAPER_LIQ_WATCH_STAMP_ON_TRACK === '1',
    liqWatchDisagreementPct: process.env.PAPER_LIQ_WATCH_DISAGREEMENT_PCT,
    liqWatchDiscoveryQuote: envBool(process.env.PAPER_LIQ_WATCH_DISCOVERY_QUOTE, true),
    volWatchEnabled: process.env.PAPER_VOL_WATCH_ENABLED === '1',
    volWatchForceClose: process.env.PAPER_VOL_WATCH_FORCE_CLOSE === '1',
    volWatchCollapsePct: process.env.PAPER_VOL_WATCH_COLLAPSE_PCT,
    volWatchSustainHours: process.env.PAPER_VOL_WATCH_SUSTAIN_HOURS,
    volWatchMinBaselineUsd: process.env.PAPER_VOL_WATCH_MIN_BASELINE_USD,
    volWatchMinAgeMin: process.env.PAPER_VOL_WATCH_MIN_AGE_MIN,
    volWatchSnapshotMaxAgeMs: process.env.PAPER_VOL_WATCH_SNAPSHOT_MAX_AGE_MS,
    volWatchStampOnTrack: process.env.PAPER_VOL_WATCH_STAMP_ON_TRACK === '1',
    flashCrashKillEnabled: process.env.PAPER_FLASH_CRASH_KILL_ENABLED === '1',
    flashCrashKillDrop30sPct: process.env.PAPER_FLASH_CRASH_KILL_DROP_30S_PCT,
    flashCrashKillDrop60sPct: process.env.PAPER_FLASH_CRASH_KILL_DROP_60S_PCT,
    flashCrashKillDrop180sPct: process.env.PAPER_FLASH_CRASH_KILL_DROP_180S_PCT,
    flashCrashKillPostDcaWarnPct: process.env.PAPER_FLASH_CRASH_KILL_POST_DCA_WARN_PCT,
    flashCrashKillPostDcaFullPct: process.env.PAPER_FLASH_CRASH_KILL_POST_DCA_FULL_PCT,
    flashCrashKillPostDcaWarnWindowMs: process.env.PAPER_FLASH_CRASH_KILL_POST_DCA_WARN_WINDOW_MS,
    flashCrashKillPostDcaFullWindowMs: process.env.PAPER_FLASH_CRASH_KILL_POST_DCA_FULL_WINDOW_MS,
    flashCrashKillQuoteMaxDiscountPct: process.env.PAPER_FLASH_CRASH_KILL_QUOTE_DISCOUNT_PCT,
    flashCrashKillQuoteDrop60sPct: process.env.PAPER_FLASH_CRASH_KILL_QUOTE_DROP_60S_PCT,
    flashCrashKillPartialSellFraction: process.env.PAPER_FLASH_CRASH_KILL_PARTIAL_SELL_FRACTION,
    flashCrashKillDcaBlockMs: process.env.PAPER_FLASH_CRASH_KILL_DCA_BLOCK_MS,
    holdersLiveEnabled: envBool(process.env.PAPER_HOLDERS_LIVE_ENABLED, false),
    holdersUseQnAddon: envBool(process.env.PAPER_HOLDERS_USE_QN_ADDON, false),
    holdersTtlMs: process.env.PAPER_HOLDERS_TTL_MS,
    holdersNegTtlMs: process.env.PAPER_HOLDERS_NEG_TTL_MS,
    holdersMaxPerTick: process.env.PAPER_HOLDERS_MAX_PER_TICK,
    holdersTimeoutMs: process.env.PAPER_HOLDERS_TIMEOUT_MS,
    holdersIncludeToken2022: envBool(process.env.PAPER_HOLDERS_INCLUDE_TOKEN2022, true),
    holdersExcludeOwners: process.env.PAPER_HOLDERS_EXCLUDE_OWNERS,
    holdersOnFail: (() => {
      const v = (process.env.PAPER_HOLDERS_ON_FAIL || '').toLowerCase();
      if (v === 'block' || v === 'warn' || v === 'db_fallback') return v;
      return undefined;
    })(),
    holdersDbWriteback: envBool(process.env.PAPER_HOLDERS_DB_WRITEBACK, false),
    holdersSnapshotWarmupMax: process.env.PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX,
    holdersGpaCreditsPerCall: process.env.PAPER_HOLDERS_GPA_CREDITS_PER_CALL,

    impulseConfirmEnabled: envBool(process.env.PAPER_IMPULSE_CONFIRM_ENABLED, false),
    impulsePgMinDropPct: process.env.PAPER_IMPULSE_PG_MIN_DROP_PCT ?? process.env.IMPULSE_PG_MIN_DROP_PCT,
    impulsePgAbsMode: envBool(process.env.PAPER_IMPULSE_PG_ABS_MODE, false),
    impulsePgMinAbsPct: process.env.PAPER_IMPULSE_PG_MIN_ABS_PCT ?? process.env.IMPULSE_PG_MIN_ABS_PCT,
    impulsePgMaxAgeSecMin:
      process.env.PAPER_IMPULSE_PG_MAX_AGE_SEC_MIN ?? process.env.IMPULSE_PG_MAX_AGE_SEC_MIN,
    impulsePgMaxAgeSecMax:
      process.env.PAPER_IMPULSE_PG_MAX_AGE_SEC_MAX ?? process.env.IMPULSE_PG_MAX_AGE_SEC_MAX,
    impulseRpcMaxPerMin: process.env.PAPER_IMPULSE_RPC_MAX_PER_MIN ?? process.env.IMPULSE_RPC_MAX_PER_MIN,
    impulseSingleFlightMs:
      process.env.PAPER_IMPULSE_SINGLE_FLIGHT_MS ?? process.env.IMPULSE_SINGLE_FLIGHT_MS,
    impulseMintCooldownSec:
      process.env.PAPER_IMPULSE_MINT_COOLDOWN_SEC ?? process.env.IMPULSE_MINT_COOLDOWN_SEC,
    impulseRpcTimeoutMs: process.env.PAPER_IMPULSE_RPC_TIMEOUT_MS ?? process.env.IMPULSE_RPC_TIMEOUT_MS,
    impulseRpcRetryCount:
      process.env.PAPER_IMPULSE_RPC_RETRY_COUNT ?? process.env.IMPULSE_RPC_RETRY_COUNT,
    impulseRpcRetryBackoffMs:
      process.env.PAPER_IMPULSE_RPC_RETRY_BACKOFF_MS ?? process.env.IMPULSE_RPC_RETRY_MS,
    impulseMaxUpPctFromAnchor:
      process.env.PAPER_IMPULSE_MAX_UP_PCT_FROM_ANCHOR ?? process.env.IMPULSE_MAX_UP_PCT_FROM_ANCHOR,
    impulseMaxDownPctFromAnchor:
      process.env.PAPER_IMPULSE_MAX_DOWN_PCT_FROM_ANCHOR ?? process.env.IMPULSE_MAX_DOWN_PCT_FROM_ANCHOR,
    impulseMinDownPctFromAnchor:
      process.env.PAPER_IMPULSE_MIN_DOWN_PCT_FROM_ANCHOR ?? process.env.IMPULSE_MIN_DOWN_PCT_FROM_ANCHOR,
    impulseMaxDisagreePct:
      process.env.PAPER_IMPULSE_MAX_DISAGREE_PCT ?? process.env.IMPULSE_MAX_DISAGREE_PCT,
    impulseRequireJupiter: envBool(
      process.env.PAPER_IMPULSE_REQUIRE_JUPITER ?? process.env.IMPULSE_REQUIRE_JUPITER,
      true,
    ),
    impulseAllowOnchainOnly: envBool(
      process.env.PAPER_IMPULSE_ALLOW_ONCHAIN_ONLY ?? process.env.IMPULSE_ALLOW_ONCHAIN_ONLY,
      false,
    ),
    impulseAllowJupiterOnlyUnsupported: envBool(
      process.env.PAPER_IMPULSE_ALLOW_JUPITER_ONLY_UNSUPPORTED ??
        process.env.IMPULSE_ONCHAIN_FALLBACK_JUPITER_ONLY,
      true,
    ),
    impulseDipPolicy: (() => {
      const v = (
        process.env.PAPER_IMPULSE_DIP_POLICY ??
        process.env.IMPULSE_DIP_POLICY ??
        ''
      ).toLowerCase();
      if (v === 'shadow' || v === 'parallel_and' || v === 'parallel_or' || v === 'boost') return v;
      return undefined;
    })(),
    impulseQnCreditsPerCall: process.env.PAPER_IMPULSE_QN_CREDITS_PER_CALL,
    impulseJupiterTimeoutMs: process.env.PAPER_IMPULSE_JUPITER_TIMEOUT_MS,
    entryImpulsePgBypassesDip: envBool(process.env.PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP, false),
    simAuditEnabled: envBool(process.env.PAPER_SIM_AUDIT_ENABLED, false),
    simSamplePct: (() => {
      const n = parseInt(String(process.env.PAPER_SIM_SAMPLE_PCT ?? '0'), 10);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.min(100, n);
    })(),
    simMaxWallMs: (() => {
      const n = Number(process.env.PAPER_SIM_MAX_WALL_MS ?? 8000);
      return Number.isFinite(n) ? Math.max(2000, Math.min(60_000, Math.floor(n))) : 8000;
    })(),
    simBuildTimeoutMs: (() => {
      const n = Number(process.env.PAPER_SIM_BUILD_TIMEOUT_MS ?? 5000);
      return Number.isFinite(n) ? Math.max(1000, Math.min(30_000, Math.floor(n))) : 5000;
    })(),
    simUseJupiterBuild: process.env.PAPER_SIM_USE_JUPITER_BUILD !== '0',
    simCredsPerCall: (() => {
      const n = parseInt(String(process.env.PAPER_SIM_CREDS_PER_CALL ?? '30'), 10);
      if (!Number.isFinite(n) || n < 10) return 30;
      return Math.min(200, n);
    })(),
    simStrictBudget: process.env.PAPER_SIM_STRICT_BUDGET !== '0',

    smlotEnableMigrationLane: envBool(process.env.SMLOT_ENABLE_MIGRATION_LANE, true),
    smlotEnablePostLane: envBool(process.env.SMLOT_ENABLE_POST_LANE, false),
    smlotMigMinAgeMin: process.env.SMLOT_MIG_MIN_AGE_MIN,
    smlotMigMaxAgeMin: process.env.SMLOT_MIG_MAX_AGE_MIN,
    smlotMigMinLiqUsd: process.env.SMLOT_MIG_MIN_LIQ_USD,
    smlotMigMaxLiqUsd: process.env.SMLOT_MIG_MAX_LIQ_USD,
    smlotMigMinVol5mUsd: process.env.SMLOT_MIG_MIN_VOL_5M_USD,
    smlotMigMinBuys5m: process.env.SMLOT_MIG_MIN_BUYS_5M,
    smlotMigMinSells5m: process.env.SMLOT_MIG_MIN_SELLS_5M,
    smlotPostMinAgeMin: process.env.SMLOT_POST_MIN_AGE_MIN,
    smlotPostMaxAgeMin: process.env.SMLOT_POST_MAX_AGE_MIN,
    smlotPostMinLiqUsd: process.env.SMLOT_POST_MIN_LIQ_USD,
    smlotPostMaxLiqUsd: process.env.SMLOT_POST_MAX_LIQ_USD,
    smlotPostMinVol5mUsd: process.env.SMLOT_POST_MIN_VOL_5M_USD,
    smlotPostMinBuys5m: process.env.SMLOT_POST_MIN_BUYS_5M,
    smlotPostMinSells5m: process.env.SMLOT_POST_MIN_SELLS_5M,
    smlotSnapshotCandidateLimit: process.env.SMLOT_SNAPSHOT_CANDIDATE_LIMIT,
    smlotIntelGateEnabled: envBool(process.env.SMLOT_INTEL_GATE_ENABLED, true),
    smlotEarlyBuyWindowSec: process.env.SMLOT_EARLY_BUY_WINDOW_SEC,
    smlotEarlyBuyWalletCap: process.env.SMLOT_EARLY_BUY_WALLET_CAP,
    smlotRequireEarlySwapCoverage: envBool(process.env.SMLOT_REQUIRE_EARLY_SWAP_COVERAGE, false),
    smlotBlockIntelBlockTrade: envBool(process.env.SMLOT_BLOCK_INTEL_BLOCK_TRADE, true),
    smlotBlockBadTags: envBool(process.env.SMLOT_BLOCK_BAD_TAGS, true),
    smlotBlockClusteredWallets: envBool(process.env.SMLOT_BLOCK_CLUSTERED_WALLETS, true),
    smlotBlockScamFarmMeta: envBool(process.env.SMLOT_BLOCK_SCAM_FARM_META, true),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid paper-trader env configuration:\n${issues}`);
  }
  const base = parsed.data;
  // Entry-wait window flag (ergonomic hours). DEFAULT 0 = OFF → keep current TTL behaviour
  // (prod `PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS=0` = no time limit). When > 0 it OVERRIDES the
  // staged-signal TTL so the −10%-from-signal anchor is dropped after the window without a fill.
  if (base.liveStagedEntryWaitHours > 0) {
    base.liveStagedEntrySignalTtlMs = Math.round(base.liveStagedEntryWaitHours * 3_600_000);
  }
  if (base.liveStagedEntryEnabled) {
    if (base.liveStagedEntryFirstLegUsd <= 0) {
      throw new Error(
        'PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD must be > 0 when PAPER_LIVE_STAGED_ENTRY_ENABLED=1',
      );
    }
    if (base.liveStagedEntryEntrySplitLegUsd <= 0) {
      throw new Error(
        'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD must be > 0 when PAPER_LIVE_STAGED_ENTRY_ENABLED=1',
      );
    }
  }
  if (base.mintBlacklistEnabled) {
    const raw = base.mintBlacklistPath.trim();
    const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    if (!fs.existsSync(abs)) {
      throw new Error(`LIVE_MINT_BLACKLIST_ENABLED=1 but blacklist file missing: ${abs}`);
    }
  }
  let discoveryDeepAuditWhitelistMintSet: ReadonlySet<string> | undefined;
  if (base.discoveryDeepAuditJsonl && base.discoveryDeepAuditWhitelistPath?.trim()) {
    const raw = base.discoveryDeepAuditWhitelistPath.trim();
    const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    discoveryDeepAuditWhitelistMintSet = loadMintWhitelistPathToSet(abs);
  }
  return discoveryDeepAuditWhitelistMintSet
    ? { ...base, discoveryDeepAuditWhitelistMintSet, pervyyVystrel: loadPervyyVystrelConfig() }
    : { ...base, pervyyVystrel: loadPervyyVystrelConfig() };
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function feeBpsForDex(cfg: PaperTraderConfig, dex: DexId): number {
  switch (dex) {
    case 'pumpfun':
      return cfg.feeBpsPumpfun;
    case 'pumpswap':
      return cfg.feeBpsPumpswap;
    case 'raydium':
      return cfg.feeBpsRaydium;
    case 'orca':
      return cfg.feeBpsOrca;
    case 'meteora':
      return cfg.feeBpsMeteora;
    case 'moonshot':
      return cfg.feeBpsMoonshot;
  }
}

export function slipBaseBpsForDex(cfg: PaperTraderConfig, dex: DexId): number {
  switch (dex) {
    case 'pumpfun':
      return cfg.slipBaseBpsPumpfun;
    case 'pumpswap':
      return cfg.slipBaseBpsPumpswap;
    case 'raydium':
      return cfg.slipBaseBpsRaydium;
    case 'orca':
      return cfg.slipBaseBpsOrca;
    case 'meteora':
      return cfg.slipBaseBpsMeteora;
    case 'moonshot':
      return cfg.slipBaseBpsMoonshot;
  }
}

/** W7.4.1 — Jupiter quote resilience for entry/exit/impulse/sim-audit paths (omit both → legacy single-attempt, no breaker). */
export function quoteResilienceFromPaperCfg(cfg: PaperTraderConfig): QuoteResilience | undefined {
  if (!cfg.priceVerifyQuoteRetriesEnabled && !cfg.priceVerifyCircuitEnabled) return undefined;
  return {
    retriesEnabled: cfg.priceVerifyQuoteRetriesEnabled,
    maxAttempts: cfg.priceVerifyQuoteRetriesEnabled ? cfg.priceVerifyQuoteMaxAttempts : 1,
    retryBackoffMs: cfg.priceVerifyQuoteRetryBackoffMs,
    circuitEnabled: cfg.priceVerifyCircuitEnabled,
    circuitWindowMs: cfg.priceVerifyCircuitWindowMs,
    circuitSkipRatePct: cfg.priceVerifyCircuitSkipRatePct,
    circuitMinAttempts: cfg.priceVerifyCircuitMinAttempts,
    circuitCooldownMs: cfg.priceVerifyCircuitCooldownMs,
  };
}

export interface DcaLevel {
  triggerPct: number;
  addFraction: number;
}

export interface TpLadderLevel {
  pnlPct: number;
  sellFraction: number;
}

export function parseDcaLevels(spec: string | undefined | null): DcaLevel[] {
  if (!spec) return [];
  const parts = spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [trig, frac] = p.split(':').map((s) => Number(s));
      return { triggerPct: trig / 100, addFraction: frac };
    })
    .filter((l) => Number.isFinite(l.triggerPct) && Number.isFinite(l.addFraction) && l.addFraction > 0);
  /** Same threshold twice → last addFraction wins; sort descending: shallower rung first (e.g. −7% then −14%), matching how price hits levels over time. */
  const byTrig = new Map<number, DcaLevel>();
  for (const l of parts) {
    byTrig.set(l.triggerPct, l);
  }
  return [...byTrig.entries()].sort((a, b) => b[0] - a[0]).map(([, level]) => level);
}

export function parseTpLadder(spec: string | undefined | null): TpLadderLevel[] {
  if (!spec) return [];
  const parts = spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [pnl, frac] = p.split(':').map((s) => Number(s));
      return { pnlPct: pnl, sellFraction: frac };
    })
    .filter((l) => Number.isFinite(l.pnlPct) && Number.isFinite(l.sellFraction) && l.sellFraction > 0);
  /** Stable combat order: ascending PnL threshold; duplicate thresholds keep last sellFraction from spec. */
  const byPnl = new Map<number, TpLadderLevel>();
  for (const l of parts) {
    byPnl.set(l.pnlPct, l);
  }
  return [...byPnl.entries()].sort((a, b) => a[0] - b[0]).map(([, level]) => level);
}

export function parseFollowupOffsets(spec: string | undefined | null): number[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}
