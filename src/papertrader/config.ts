import 'dotenv/config';
import { z } from 'zod';
import type { DexId } from './types.js';

const StrategyKindSchema = z.enum(['fresh', 'dip', 'smart_lottery', 'fresh_validated']);

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
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

const ConfigSchema = z.object({
  strategyId: z.string().default('paper_v1'),
  strategyKind: StrategyKindSchema.default('fresh'),
  storePath: z.string().default('/tmp/paper-trades.jsonl'),
  discoveryIntervalMs: z.coerce.number().int().positive().default(10_000),
  trackIntervalMs: z.coerce.number().int().positive().default(30_000),
  followupTickMs: z.coerce.number().int().positive().default(30_000),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(10_000),
  solPriceRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  btcContextRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  positionUsd: z.coerce.number().positive().default(100),
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

  // ---- snapshot lanes ----
  laneMigMinLiqUsd: z.coerce.number().nonnegative().default(12_000),
  laneMigMinVol5mUsd: z.coerce.number().nonnegative().default(1_800),
  laneMigMinBuys5m: z.coerce.number().int().nonnegative().default(18),
  laneMigMinSells5m: z.coerce.number().int().nonnegative().default(8),
  laneMigMinAgeMin: z.coerce.number().nonnegative().default(2),
  laneMigMaxAgeMin: z.coerce.number().nonnegative().default(25),
  lanePostMinLiqUsd: z.coerce.number().nonnegative().default(15_000),
  lanePostMinVol5mUsd: z.coerce.number().nonnegative().default(2_500),
  lanePostMinBuys5m: z.coerce.number().int().nonnegative().default(16),
  lanePostMinSells5m: z.coerce.number().int().nonnegative().default(10),
  lanePostMinAgeMin: z.coerce.number().nonnegative().default(25),
  lanePostMaxAgeMin: z.coerce.number().nonnegative().default(180),
  snapshotMinBs: z.coerce.number().nonnegative().default(1.0),

  // ---- dip detector ----
  dipLookbackMin: z.coerce.number().int().positive().default(60),
  /** Parsed into `dipLookbackWindowsMin` after transform (see `PAPER_DIP_LOOKBACK_WINDOWS_MIN`). */
  dipLookbackWindowsCsv: z.string().default(''),
  dipMinDropPct: z.coerce.number().default(-12),
  dipMaxDropPct: z.coerce.number().default(-45),
  dipMinImpulsePct: z.coerce.number().default(20),
  dipMinAgeMin: z.coerce.number().nonnegative().default(25),
  dipCooldownMinDefault: z.coerce.number().nonnegative().default(120),
  dipCooldownMinScalp: z.coerce.number().nonnegative().default(20),

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
  trailMode: z.enum(['peak', 'ladder_retrace']).default('peak'),
  timeoutHours: z.coerce.number().positive().default(12),

  dcaLevelsSpec: z.string().default(''),
  dcaKillstop: z.coerce.number().default(0),

  tpLadderSpec: z.string().default(''),

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

  /** Live SPL holder-count resolver via QuickNode. */
  holdersLiveEnabled: z.boolean().default(false),
  holdersUseQnAddon: z.boolean().default(false),
  holdersTtlMs: z.coerce.number().int().min(5_000).max(15 * 60_000).default(90_000),
  holdersNegTtlMs: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  holdersMaxPerTick: z.coerce.number().int().min(1).max(200).default(10),
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
  holdersGpaCreditsPerCall: z.coerce.number().int().min(10).max(2_000).default(100),
}).transform((data) => {
  const { dipLookbackWindowsCsv, ...rest } = data;
  const dipLookbackWindowsMin = resolveDipLookbackWindows(rest.dipLookbackMin, dipLookbackWindowsCsv);
  return { ...rest, dipLookbackWindowsMin };
});

export type PaperTraderConfig = z.infer<typeof ConfigSchema>;

export function loadPaperTraderConfig(): PaperTraderConfig {
  const parsed = ConfigSchema.safeParse({
    strategyId: process.env.PAPER_STRATEGY_ID,
    strategyKind: process.env.PAPER_STRATEGY_KIND,
    storePath: process.env.PAPER_TRADES_PATH,
    discoveryIntervalMs: process.env.PAPER_DISCOVERY_INTERVAL_MS,
    trackIntervalMs: process.env.PAPER_TRACK_INTERVAL_MS,
    followupTickMs: process.env.PAPER_FOLLOWUP_TICK_MS,
    heartbeatIntervalMs: process.env.PAPER_HEARTBEAT_INTERVAL_MS,
    solPriceRefreshMs: process.env.PAPER_SOL_PRICE_REFRESH_MS,
    btcContextRefreshMs: process.env.PAPER_BTC_CONTEXT_REFRESH_MS,
    positionUsd: process.env.PAPER_POSITION_USD,
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
    laneMigMinLiqUsd: process.env.PAPER_MIG_MIN_LIQ_USD,
    laneMigMinVol5mUsd: process.env.PAPER_MIG_MIN_VOL_5M_USD,
    laneMigMinBuys5m: process.env.PAPER_MIG_MIN_BUYS_5M,
    laneMigMinSells5m: process.env.PAPER_MIG_MIN_SELLS_5M,
    laneMigMinAgeMin: process.env.PAPER_MIG_MIN_AGE_MIN,
    laneMigMaxAgeMin: process.env.PAPER_MIG_MAX_AGE_MIN,
    lanePostMinLiqUsd: process.env.PAPER_POST_MIN_LIQ_USD,
    lanePostMinVol5mUsd: process.env.PAPER_POST_MIN_VOL_5M_USD,
    lanePostMinBuys5m: process.env.PAPER_POST_MIN_BUYS_5M,
    lanePostMinSells5m: process.env.PAPER_POST_MIN_SELLS_5M,
    lanePostMinAgeMin: process.env.PAPER_POST_MIN_AGE_MIN,
    lanePostMaxAgeMin: process.env.PAPER_POST_MAX_AGE_MIN,
    snapshotMinBs: process.env.PAPER_POST_MIN_BS,
    dipLookbackMin: process.env.PAPER_DIP_LOOKBACK_MIN,
    dipLookbackWindowsCsv: process.env.PAPER_DIP_LOOKBACK_WINDOWS_MIN ?? '',
    dipMinDropPct: process.env.PAPER_DIP_MIN_DROP_PCT,
    dipMaxDropPct: process.env.PAPER_DIP_MAX_DROP_PCT,
    dipMinImpulsePct: process.env.PAPER_DIP_MIN_IMPULSE_PCT,
    dipMinAgeMin: process.env.PAPER_DIP_MIN_AGE_MIN,
    dipCooldownMinDefault: process.env.PAPER_DIP_COOLDOWN_MIN,
    dipCooldownMinScalp: process.env.PAPER_DIP_COOLDOWN_MIN_SCALP,
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
    trailMode: process.env.PAPER_TRAIL_MODE === 'ladder_retrace' ? 'ladder_retrace' : 'peak',
    timeoutHours: process.env.PAPER_TIMEOUT_HOURS,
    dcaLevelsSpec: process.env.PAPER_DCA_LEVELS,
    dcaKillstop: process.env.PAPER_DCA_KILLSTOP,
    tpLadderSpec: process.env.PAPER_TP_LADDER,
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
    liqWatchEnabled: process.env.PAPER_LIQ_WATCH_ENABLED === '1',
    liqWatchForceClose: process.env.PAPER_LIQ_WATCH_FORCE_CLOSE === '1',
    liqWatchDrainPct: process.env.PAPER_LIQ_WATCH_DRAIN_PCT,
    liqWatchMinAgeMin: process.env.PAPER_LIQ_WATCH_MIN_AGE_MIN,
    liqWatchConsecutiveFailures: process.env.PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES,
    liqWatchSnapshotMaxAgeMs: process.env.PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS,
    liqWatchRpcFallback: process.env.PAPER_LIQ_WATCH_RPC_FALLBACK === '1',
    liqWatchStampOnAllClose: process.env.PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE !== '0',
    liqWatchStampOnTrack: process.env.PAPER_LIQ_WATCH_STAMP_ON_TRACK === '1',
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
    holdersGpaCreditsPerCall: process.env.PAPER_HOLDERS_GPA_CREDITS_PER_CALL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid paper-trader env configuration:\n${issues}`);
  }
  return parsed.data;
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
  return spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [trig, frac] = p.split(':').map((s) => Number(s));
      return { triggerPct: trig / 100, addFraction: frac };
    })
    .filter((l) => Number.isFinite(l.triggerPct) && Number.isFinite(l.addFraction) && l.addFraction > 0);
}

export function parseTpLadder(spec: string | undefined | null): TpLadderLevel[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [pnl, frac] = p.split(':').map((s) => Number(s));
      return { pnlPct: pnl, sellFraction: frac };
    })
    .filter((l) => Number.isFinite(l.pnlPct) && Number.isFinite(l.sellFraction) && l.sellFraction > 0);
}

export function parseFollowupOffsets(spec: string | undefined | null): number[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}
