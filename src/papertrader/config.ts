import 'dotenv/config';
import { z } from 'zod';
import type { QuoteResilience } from './pricing/jupiter-quote-resilience.js';
import type { DexId } from './types.js';

const StrategyKindSchema = z.enum(['fresh', 'dip', 'smart_lottery', 'fresh_validated']);

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

function envOptNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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
  trackIntervalMs: z.coerce.number().int().positive().default(30_000),
  followupTickMs: z.coerce.number().int().positive().default(30_000),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(10_000),
  solPriceRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  btcContextRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  positionUsd: z.coerce.number().positive().default(100),
  /**
   * Доля **первой** ноги входа от `positionUsd` (1 = как раньше — полная позиция одним свопом).
   * Live Oscar: при < 1 и `LIVE_ENTRY_SCALE_IN_ENABLED` вторая нога исполняется отдельно в трекере (коридор Jupiter к якорю первой ноги).
   */
  entryFirstLegFraction: z.coerce.number().min(0.01).max(1).default(1),
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
  /** 0 = no cap. Upper bound on pool USD liquidity for migration lane snapshot SQL + evaluateSnapshot. */
  laneMigMaxLiqUsd: z.coerce.number().nonnegative().default(0),
  lanePostMinLiqUsd: z.coerce.number().nonnegative().default(15_000),
  lanePostMinVol5mUsd: z.coerce.number().nonnegative().default(2_500),
  lanePostMinBuys5m: z.coerce.number().int().nonnegative().default(16),
  lanePostMinSells5m: z.coerce.number().int().nonnegative().default(10),
  lanePostMinAgeMin: z.coerce.number().nonnegative().default(25),
  lanePostMaxAgeMin: z.coerce.number().nonnegative().default(180),
  /** 0 = no cap. Upper bound on pool USD liquidity for post lane snapshot SQL + evaluateSnapshot. */
  lanePostMaxLiqUsd: z.coerce.number().nonnegative().default(0),
  /** Max snapshot rows after lane filters (ORDER BY ts DESC). Higher = scan more mints per tick. */
  snapshotCandidateLimit: z.coerce.number().int().min(50).max(5000).default(300),
  /** Min seconds before re-evaluating the same mint in discovery (per process). */
  discoveryReevalSec: z.coerce.number().int().min(5).max(600).default(60),
  snapshotMinBs: z.coerce.number().nonnegative().default(1.0),
  /**
   * Require pair snapshot `volume_5m` to be consistent with `volume_1h` (same row).
   * Fails if hour volume missing/below floor or vol_5m exceeds (vol_1h/12)*mult (spike vs flat hour).
   */
  vol5m1hGuardEnabled: z.boolean().default(false),
  vol1hMinUsd: z.coerce.number().nonnegative().default(36_000),
  vol5mSpikeMaxMult: z.coerce.number().min(1.01).max(48).default(7),

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
  /** После убыточного закрытия — пауза повторного входа на тот же mint (часы). 0 = выкл. */
  dipLossExitCooldownHours: z.coerce.number().nonnegative().default(0),

  /** Live Oscar: режимы выхода A/B (до / после усреднения). Paper: держать false. */
  liveExitModeAbEnabled: z.boolean().default(false),
  liveExitModeBTrailDrop: z.coerce.number().min(0).max(1).optional(),
  liveExitModeBTrailTriggerX: z.coerce.number().positive().optional(),
  liveExitModeBTimeoutHours: z.coerce.number().positive().optional(),
  liveExitModeBTpGridStepPnl: z.coerce.number().nonnegative().optional(),
  liveExitModeBTpGridSellFraction: z.coerce.number().min(0).max(1).optional(),
  liveExitModeBTpGridFirstRungRetraceMinPnlPct: z.coerce.number().min(0).max(0.5).optional(),
  liveExitModeBDcaKillstop: z.coerce.number().optional(),
  liveExitModeBPeakLogStepPct: z.coerce.number().nonnegative().optional(),

  dipRecoveryVetoEnabled: z.boolean().default(false),
  dipRecoveryVetoWindowsCsv: z.string().default(''),
  dipRecoveryVetoMaxBouncePct: z.coerce.number().min(0.1).max(500).default(12),

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

  /**
   * Oscar-style TP grid: each multiple of this **PnL fraction vs avg** (e.g. 0.05 = +5%) fires once;
   * each hit sells `tpGridSellFraction` of **current** remaining position. Empty discrete `tpLadder` when >0.
   * Retrace (`ladder_retrace`) uses previous threshold like the discrete ladder.
   */
  tpGridStepPnl: z.coerce.number().nonnegative().default(0),
  tpGridSellFraction: z.coerce.number().min(0).max(1).default(0.2),
  /**
   * После **первой** срабатывающей ступени TP-grid «предыдущий порог» для retrace был бы 0 (= безубыток к средней).
   * Здесь задаётся **минимальный PnL (доля, напр. 0.025 = +2.5%)**: закрываем остаток, когда нереализованный xAvg-1
   * опускается до этого уровня **или ниже** — раньше, чем дать цене уйти в ноль/минус между тиками трекера.
   * `0` = прежнее поведение (retrace к 0%).
   */
  tpGridFirstRungRetraceMinPnlPct: z.coerce.number().min(0).max(0.5).default(0),

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
  const { dipLookbackWindowsCsv, dipRecoveryVetoWindowsCsv, ...rest } = data;
  const dipLookbackWindowsMin = resolveDipLookbackWindows(rest.dipLookbackMin, dipLookbackWindowsCsv);
  const dipRecoveryVetoWindowsMin = resolveRecoveryVetoWindows(dipRecoveryVetoWindowsCsv);
  const dipAggregationWindowsMin =
    rest.dipRecoveryVetoEnabled && dipRecoveryVetoWindowsMin.length > 0
      ? [...new Set([...dipLookbackWindowsMin, ...dipRecoveryVetoWindowsMin])].sort((a, b) => a - b)
      : dipLookbackWindowsMin;
  return {
    ...rest,
    dipLookbackWindowsMin,
    dipRecoveryVetoWindowsMin,
    dipAggregationWindowsMin,
  };
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
    entryFirstLegFraction: process.env.PAPER_ENTRY_FIRST_LEG_FRACTION,
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
    laneMigMaxLiqUsd: process.env.PAPER_MIG_MAX_LIQ_USD,
    lanePostMinLiqUsd: process.env.PAPER_POST_MIN_LIQ_USD,
    lanePostMinVol5mUsd: process.env.PAPER_POST_MIN_VOL_5M_USD,
    lanePostMinBuys5m: process.env.PAPER_POST_MIN_BUYS_5M,
    lanePostMinSells5m: process.env.PAPER_POST_MIN_SELLS_5M,
    lanePostMinAgeMin: process.env.PAPER_POST_MIN_AGE_MIN,
    lanePostMaxAgeMin: process.env.PAPER_POST_MAX_AGE_MIN,
    lanePostMaxLiqUsd: process.env.PAPER_POST_MAX_LIQ_USD,
    snapshotCandidateLimit: process.env.PAPER_SNAPSHOT_CANDIDATE_LIMIT,
    discoveryReevalSec: process.env.PAPER_DISCOVERY_REEVAL_SEC,
    snapshotMinBs: process.env.PAPER_POST_MIN_BS,
    vol5m1hGuardEnabled: envBool(process.env.PAPER_VOL_5M_1H_GUARD_ENABLED, false),
    vol1hMinUsd: process.env.PAPER_VOL_1H_MIN_USD,
    vol5mSpikeMaxMult: process.env.PAPER_VOL_5M_SPIKE_MAX_MULT,
    dipLookbackMin: process.env.PAPER_DIP_LOOKBACK_MIN,
    dipLookbackWindowsCsv: process.env.PAPER_DIP_LOOKBACK_WINDOWS_MIN ?? '',
    dipMinDropPct: process.env.PAPER_DIP_MIN_DROP_PCT,
    dipMaxDropPct: process.env.PAPER_DIP_MAX_DROP_PCT,
    dipMinImpulsePct: process.env.PAPER_DIP_MIN_IMPULSE_PCT,
    dipMinAgeMin: process.env.PAPER_DIP_MIN_AGE_MIN,
    dipCooldownMinDefault: process.env.PAPER_DIP_COOLDOWN_MIN,
    dipCooldownMinScalp: process.env.PAPER_DIP_COOLDOWN_MIN_SCALP,
    dipLossExitCooldownHours: process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS,
    liveExitModeAbEnabled: envBool(process.env.PAPER_LIVE_EXIT_MODE_AB, false),
    liveExitModeBTrailDrop: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP),
    liveExitModeBTrailTriggerX: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X),
    liveExitModeBTimeoutHours: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TIMEOUT_HOURS),
    liveExitModeBTpGridStepPnl: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL),
    liveExitModeBTpGridSellFraction: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION),
    liveExitModeBTpGridFirstRungRetraceMinPnlPct: envOptNum(
      process.env.PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL,
    ),
    liveExitModeBDcaKillstop: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP),
    liveExitModeBPeakLogStepPct: envOptNum(process.env.PAPER_LIVE_EXIT_MODE_B_PEAK_LOG_STEP_PCT),
    dipRecoveryVetoEnabled: envBool(process.env.PAPER_DIP_RECOVERY_VETO_ENABLED, false),
    dipRecoveryVetoWindowsCsv: process.env.PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN ?? '',
    dipRecoveryVetoMaxBouncePct: process.env.PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT,
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
    tpGridStepPnl: process.env.PAPER_TP_GRID_STEP_PNL,
    tpGridSellFraction: process.env.PAPER_TP_GRID_SELL_FRACTION,
    tpGridFirstRungRetraceMinPnlPct: process.env.PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL,
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
