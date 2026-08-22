import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import type { MildDipEntryGates, MildDipExitGates } from './gates.js';

const ExecutionModeSchema = z.enum(['paper', 'dry_run', 'live']);

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_MIRROR_AVERAGE_WINDOWS_MS = [
  3_600_000,
  7_200_000,
  10_800_000,
  14_400_000,
  21_600_000,
];

function envMirrorAverageWindowsMs(): number[] {
  const raw = process.env.MILD_DIP_MIRROR_AVERAGE_WINDOWS_MS?.trim();
  if (!raw) return [...DEFAULT_MIRROR_AVERAGE_WINDOWS_MS];
  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 60_000);
  return values.length > 0 ? [...new Set(values)].sort((a, b) => a - b) : [...DEFAULT_MIRROR_AVERAGE_WINDOWS_MS];
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

function stagedAddAnchorFromEnv(): 'fill' | 'trough' {
  return process.env.MILD_DIP_STAGED_ADD_ANCHOR?.trim().toLowerCase() === 'fill'
    ? 'fill'
    : 'trough';
}

const MildDipConfigSchema = z.object({
  executionMode: ExecutionModeSchema,
  rpcUrl: z.string().min(8),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
  journalPath: z.string().min(1),
  /** Cash-accurate fills + roundtrips (us + leaders). CF source of truth. */
  tradesPath: z.string().min(1),
  statePath: z.string().min(1),
  /** 1.11.841 — flat $1 across base/thick/micro (live via env). Fallback when liq power law off. */
  positionUsd: z.coerce.number().positive().max(10_000).default(1),
  /**
   * 1.11.925 — liquidity power law: clamp(min, max, coef × liq^exp).
   * Leader fit 0.0387×liq^0.866; live coef ≈0.0004168 (~1.08% scale) → $1 @ $8k liq … $30 cap.
   * coef ≤ 0 → flat tier clips (positionUsd / thick / micro).
   */
  sizeLiqPowerCoef: z.coerce.number().min(0).max(1).default(0),
  sizeLiqPowerExp: z.coerce.number().min(0).max(2).default(0.866),
  sizeMinUsd: z.coerce.number().min(0).max(10_000).default(1),
  sizeMaxUsd: z.coerce.number().min(0).max(10_000).default(30),
  /** 1.11.967 — reject only known pairs younger than this age; 0 = off. */
  entryMinPairAgeHours: z.coerce.number().max(10_000).default(1),
  /** 1.11.967 — reject known vol5m/liquidity ratios at or above this; 0 = off. */
  entryMaxVol5mToLiq: z.coerce.number().max(100_000).default(2),
  /** 1.11.970 — reject known pool liquidity below this; 0 = off. */
  entryMinLiquidityUsd: z.coerce.number().min(0).max(10_000_000).default(4_000),
  /** 1.11.1018 — minimum observed 5m buys+sells; 0 = off. */
  entryMinTxns5m: z.coerce.number().min(0).max(100_000).default(0),
  /** 1.11.1018 — minimum observed 5m volume/liquidity turnover; 0 = off. */
  entryMinTurnover5mLiq: z.coerce.number().min(0).max(100_000).default(0),
  stagedEntryEnabled: z.boolean().default(false),
  stagedFirstUsd: z.coerce.number().min(0).max(10_000).default(5),
  stagedAddTriggerPct: z.coerce.number().min(0).max(100).default(8),
  stagedAddMaxChasePct: z.coerce.number().min(0).max(100).default(4),
  stagedAddAnchor: z.enum(['fill', 'trough']).default('trough'),
  stagedAddTroughTriggerPct: z.coerce.number().min(0).max(100).default(8),
  stagedAddTroughBandPct: z.coerce.number().min(0).max(100).default(4),
  stagedAddMinTroughAgeMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  stagedAddMult: z.coerce.number().min(0).max(100).default(2),
  stagedAddMaxUsd: z.coerce.number().min(0).max(10_000).default(0),
  stagedProfitMinOverAvgPct: z.coerce.number().min(0).max(100).default(1),
  /** 1.11.993 — maximum staged-profit veto duration; 0 = unlimited. */
  stagedProfitVetoMaxMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
  /** 1.11.993 — outer full-exit retry slippage step; 0 = disabled. */
  exitRetrySlippageStepBps: z.coerce.number().int().min(0).max(5_000).default(0),
  exitRetrySlippageMaxBps: z.coerce.number().int().min(1).max(5_000).default(800),
  /**
   * Thick-name clip (mcap/liq/age). 0 = off.
   * 1.11.841 — same $1 as base (flat book).
   */
  thickPositionUsd: z.coerce.number().min(0).max(10_000).default(1),
  thickMinMarketCapUsd: z.coerce.number().min(0).default(100_000),
  thickMinLiquidityUsd: z.coerce.number().min(0).default(50_000),
  thickMinPairAgeHours: z.coerce.number().min(0).default(6),
  /**
   * Micro-cap clip: mcap ∈ [min, max] → this size (knife_stabilize only).
   * 1.11.841 — same $1 as base (flat book). 0 = off.
   */
  microPositionUsd: z.coerce.number().min(0).max(10_000).default(1),
  microMinMarketCapUsd: z.coerce.number().min(0).default(5_000),
  microMaxMarketCapUsd: z.coerce.number().min(0).default(50_000),
  /** 0 = unlimited — keep buying while USDC remains. */
  maxOpenPositions: z.coerce.number().int().min(0).max(500).default(0),
  /** Background lane may run at 3s when stream/leader fast-path owns entries. */
  scanIntervalMs: z.coerce.number().int().min(3_000).max(600_000).default(5_000),
  /**
   * Open-book exit poll cadence. Live target ≤5s (1.11.736); was 2s on paper
   * but Dex-only marks + scan blocking stretched real gaps to ~60s.
   */
  markIntervalMs: z.coerce.number().int().min(1_000).max(120_000).default(2_000),
  /**
   * Exit marks use the price ring only (stream + entry seed). Max age of the
   * last ring print before the mark is treated as null. 0 = any age accepted.
   * Dex is never awaited on the exit mark path (1.11.769).
   */
  markStreamMaxAgeMs: z.coerce.number().int().min(0).max(900_000).default(300_000),
  streamDexMaxDivergenceFactor: z.coerce.number().min(1).max(100).default(2),
  entrySignalMarkMaxAgeMs: z.coerce.number().int().min(0).max(900_000).default(0),
  entrySignalMaxDivergencePct: z.coerce.number().min(0).max(100).default(0),
  /**
   * Prefer a fresh stream print over Dex when choosing the exit mark (ms).
   * 0 = use whichever sample is newest in the ring.
   */
  markStreamPreferMaxAgeMs: z.coerce.number().int().min(0).max(120_000).default(15_000),
  /**
   * Background only: when stream/seed ring age ≥ this gap, fire-and-forget
   * Dex→ring for open bags (never blocks the exit mark pass). 0 = off.
   * Default 8s — enough to see pumps without flooding the 120 RPM gate.
   */
  markDexRefreshMs: z.coerce.number().int().min(0).max(300_000).default(8_000),
  /**
   * Background Jupiter sell quote → ring when stream is quiet on open bags. 0 = off.
   */
  markJupiterRefreshMs: z.coerce.number().int().min(0).max(300_000).default(0),
  markJupiterProbeUsd: z.coerce.number().min(0).max(100).default(1),
  markJupiterMaxInFlight: z.coerce.number().int().min(1).max(8).default(2),
  /** Skip Jupiter refresh when a stream print landed within this window. */
  markJupiterStreamQuietMs: z.coerce.number().int().min(0).max(120_000).default(5_000),
  /**
   * Dex cache TTL for discovery/entry Dex calls (not exit marks).
   */
  markCacheTtlMs: z.coerce.number().int().min(0).max(120_000).default(20_000),
  /**
   * 1.11.917 — armed bags must not trail on a stale or frozen stream print.
   * 0 = off. Default 10s.
   */
  markArmedMaxAgeMs: z.coerce.number().int().min(0).max(300_000).default(10_000),
  /**
   * 1.11.919 — how long a quarantined mark may be refused before we accept it.
   */
  markJumpConfirmMaxMs: z.coerce.number().int().min(0).max(120_000).default(8_000),
  /** 1.11.959 — immediate Jupiter read after a quarantined mark; 0 = off. */
  markQuarantineJupiterGapMs: z.coerce.number().int().min(0).max(120_000).default(0),
  /**
   * 1.11.794 — max concurrent background Dex→ring refreshes for open bags
   * (`requestOpenMarkRefresh`). Exit mark reads stay sync from the ring.
   */
  markConcurrency: z.coerce.number().int().min(1).max(64).default(48),
  /** Parallel Dex enrich during candidate scan (still behind Dex gate). */
  enrichConcurrency: z.coerce.number().int().min(1).max(32).default(12),
  /** Parallel Jupiter sells — sole consumer can push higher. */
  sellConcurrency: z.coerce.number().int().min(1).max(8).default(6),
  /**
   * Max bounce % off the price-ring trough (cooldown lookback) before rebuy.
   * 0 = off. Default 6 — refuse buying a “good” bounce off the wick.
   */
  maxCooldownBouncePct: z.coerce.number().min(0).max(100).default(6),
  /** GREEN override for cooldown-bounce; 0 = use maxCooldownBouncePct. */
  greenMaxCooldownBouncePct: z.coerce.number().min(0).max(100).default(0),
  /** Lookback window for trough / stream drawdown (default = 5m cooldown). */
  cooldownBounceLookbackMs: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  /**
   * After a full exit: require mark ≥ this % below exit price before rebuy.
   * Stream mark only — no Dex. 0 = off. Default 4.
   */
  /** 1.11.757 — live default 10 (was 20). */
  rebuyBelowExitPct: z.coerce.number().min(0).max(50).default(10),
  /** How long the last-exit floor applies (ms). Default 15m. */
  rebuyBelowExitMaxAgeMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
  /**
   * 1.11.797 — after a loss exit: skip rebuy when Dex liq is below the exit
   * snapshot (draining pool / death spiral).
   */
  rebuyLiqDropEnabled: z.boolean().default(true),
  /** Memory for exit-liq baseline (default 6h). 0 = no age cap. */
  rebuyLiqDropMaxAgeMs: z.coerce.number().int().min(0).max(86_400_000).default(21_600_000),
  /** 0 = any decline blocks; >0 requires at least this % drop. */
  rebuyLiqDropMinDropPct: z.coerce.number().min(0).max(90).default(0),
  /** Only apply after losing full exits (pnlPct < 0). */
  rebuyLiqDropOnlyAfterLoss: z.boolean().default(true),
  /** Allow entry when stream drawdown is in dip band even if Dex pc5m is flat. */
  streamDipEntryEnabled: z.boolean().default(true),
  /**
   * 1.11.798 — refuse entry unless price-ring has a recent `source=stream`
   * print (Helius swap decode). Blocks Dex-only green-candle fills when the
   * stream price sampler is dead.
   */
  requireStreamPriceEntry: z.boolean().default(true),
  /** Max age of the last stream ring print for entry (ms). */
  requireStreamPriceMaxAgeMs: z.coerce.number().int().min(5_000).max(900_000).default(120_000),
  /** Decode program-log signatures → stream price samples (RPC). */
  streamPriceSampleEnabled: z.boolean().default(true),
  streamPriceMinGapMs: z.coerce.number().int().min(250).max(60_000).default(2_000),
  streamPriceConcurrency: z.coerce.number().int().min(1).max(8).default(3),
  streamPriceTxRetryEnabled: z.boolean().default(false),
  streamPriceTxRetryMaxAttempts: z.coerce.number().int().min(0).max(5).default(2),
  streamPriceTxRetryDelayMs: z.coerce.number().int().min(0).max(10_000).default(400),
  streamPriceTxRetryMaxAgeMs: z.coerce.number().int().min(0).max(300_000).default(30_000),
  /** Journal-only tape lanes; this never enters the execution path. */
  tapeShadowEnabled: z.boolean().default(false),
  tapePendingSampleMaxMints: z.coerce.number().int().min(1).max(5_000).default(64),
  tapeShadowSampleMaxMints: z.coerce.number().int().min(0).max(5_000).default(0),
  tapeShadowSampleMinGapMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(15_000),
  tapePendingSampleGraceMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(300_000),
  tapeGreenMeasureAll: z.boolean().default(false),
  tapeGreenMeasureAllMinIntervalMs: z.coerce.number().int().min(0).default(300_000),
  tapeGreenMeasureAllMaxSignalsPerHour: z.coerce.number().int().min(0).default(1_500),
  tapeStructuralFetchMaxPerHour: z.coerce.number().int().min(0).default(400),
  tapeStructuralBatchMs: z.coerce.number().int().min(1_000).default(20_000),
  tapeStructuralMissRetryMs: z.coerce.number().int().min(0).default(3_600_000),
  tapeStructuralErrorRetryMs: z.coerce.number().int().min(0).default(300_000),
  tapeStructuralBatchMaxPerHour: z.coerce.number().int().min(0).default(200),
  tapePathMaxPoints: z.coerce.number().int().min(0).max(10_000).default(60),
  tapeExitArmPct: z.coerce.number().min(0).max(1_000).default(10),
  tapeExitTrailPct: z.coerce.number().min(0).max(100).default(9),
  tapeExitStopPct: z.coerce.number().min(-100).max(0).default(-30),
  tapeExitTimeoutMs: z.coerce.number().int().min(0).default(3_600_000),
  tapeGreenMinLiqUsd: z.coerce.number().min(0).default(1_700),
  tapeGreenMaxLiqUsd: z.coerce.number().min(0).default(20_000),
  tapeGreenMinMcapUsd: z.coerce.number().min(0).default(2_000),
  tapeGreenMinVol5mUsd: z.coerce.number().min(0).default(150),
  tapeGreenMaxTurnover: z.coerce.number().min(0).default(0),
  tapeGreenMinAgeHours: z.coerce.number().min(0).default(1),
  tapeDipMinLiqUsd: z.coerce.number().min(0).default(1_700),
  tapeDipMaxLiqUsd: z.coerce.number().min(0).default(6_000),
  tapeDipMinMcapUsd: z.coerce.number().min(0).default(2_000),
  tapeDipMinVol5mUsd: z.coerce.number().min(0).default(300),
  tapeDipMaxTurnover: z.coerce.number().min(0).default(0),
  tapeDipMinAgeHours: z.coerce.number().min(0).default(0.5),
  tapeWindowMs: z.coerce.number().int().min(60 * 60_000).max(3 * 60 * 60_000).default(90 * 60_000),
  tapeGreenImp60MinPct: z.coerce.number().min(-100).max(100).default(0),
  tapeGreenImp5MinPct: z.coerce.number().min(-100).max(100).default(4),
  tapeGreenImp5MaxPct: z.coerce.number().min(-100).max(200).default(40),
  tapeGreenDd60MaxPct: z.coerce.number().min(-100).max(0).default(-5),
  tapeGreenMinPairAgeHours: z.coerce.number().min(0).max(168).default(1),
  tapeDipRangePosMaxPct: z.coerce.number().min(0).max(100).default(20),
  tapeDipDd60MaxPct: z.coerce.number().min(-100).max(0).default(-40),
  tapeDipImp5MaxPct: z.coerce.number().min(-100).max(100).default(-15),
  tapeDipMinPairAgeHours: z.coerce.number().min(0).max(168).default(0.5),
  tapeDipMaxPairAgeHours: z.coerce.number().min(0).max(168).default(24),
  tapeMinIntervalMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  tapeMaxSignalsPerHour: z.coerce.number().int().min(1).max(10_000).default(60),
  tapeOutcomeStaleMs: z.coerce.number().int().min(0).max(86_400_000).default(300_000),
  /** Never below the tape window: a dormant mint that wakes up is the pattern we measure. */
  tapeIdleEvictMs: z.coerce.number().int().min(60_000).max(86_400_000).default(5_400_000),
  tapeSummaryIntervalMs: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  tapeStateSaveMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
  tapePairAgeMaxStaleMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(365 * 86_400_000)
    .default(7 * 86_400_000),
  tapePairAgeMaxEntries: z.coerce.number().int().min(1).max(100_000).default(5_000),
  tapePairAgeBackfillMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(30_000),
  tapePairAgeRetryMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(365 * 86_400_000)
    .default(6 * 3_600_000),
  /**
   * On open mints: if a stream sell empties a wallet bag (post≈0) and is large,
   * defer peak_giveback for graceMs. Configured cliff_dump / hard_stop still fire.
   * 0 grace = off.
   */
  oneshotDumpGraceEnabled: z.boolean().default(true),
  oneshotDumpGraceMs: z.coerce.number().int().min(0).max(600_000).default(60_000),
  /**
   * 1.11.767 — on startup, sell unmanaged `*pump` ATAs not in `state.open`
   * (safety net; primary fix is post-sell on-chain settle). 0 max = off.
   */
  orphanSweepEnabled: z.boolean().default(true),
  orphanSweepMaxSells: z.coerce.number().int().min(0).max(200).default(25),
  oneshotDumpMinSellUsd: z.coerce.number().min(0).max(1_000_000).default(500),
  /** post/pre ≤ this counts as emptied (dust left OK). */
  oneshotDumpMaxPostResidualFrac: z.coerce.number().min(0).max(1).default(0.02),
  /**
   * Before soft peak_giveback: classify red candle as whale oneshot vs mass flee
   * from stream sell tape. 0 wait = classify-only (no pending hold).
   */
  dumpClassifyEnabled: z.boolean().default(true),
  dumpClassifyWindowMs: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  /** Hold giveback while class=unknown, then timeout → sell as mass_flee. */
  dumpClassifyWaitMs: z.coerce.number().int().min(0).max(60_000).default(5_000),
  dumpClassifyMassMinSellers: z.coerce.number().int().min(2).max(20).default(3),
  /** Top seller USD share ≥ this (and ≥ minSellUsd) ⇒ whale_oneshot. */
  dumpClassifyWhaleShare: z.coerce.number().min(0.5).max(1).default(0.6),
  /**
   * Defer soft exits (stale/dead/vol_fade/giveback) when mark has bounced
   * ≥ minBouncePct off the ring trough in lookback. cliff/timeout still fire.
   */
  /** 1.11.749 default off — was blocking trail giveback on green-vs-trough. */
  /**
   * 1.11.874 — hold a soft exit while the entry gate would still open the bag.
   * Selling a name the entry side likes only to buy it back costs a full round
   * trip; GCa9TZ was sold at −10.48% and rebought 98s later, 7.7% lower.
   */
  /**
   * 1.11.875 — how many seeded mints the leader lane looks at per scan, and how
   * long before it looks again. The seed can hold `leaderSeedMax` names and the
   * lane runs every scan interval, so both bounds are what keep it from
   * re-checking the same 250 mints every three seconds.
   */
  leaderSeedWakeMax: z.coerce.number().int().min(0).max(250).default(12),
  leaderSeedRelookMs: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  /**
   * 1.11.879 — minimum gap between two sells on one mint. `sellInFlight` only
   * covers the transaction itself, so the next mark tick could decide again on
   * data older than the sell that just landed.
   */
  exitMinSpacingMs: z.coerce.number().int().min(0).max(600_000).default(10_000),
  exitDeferWouldBuyEnabled: z.boolean().default(false),
  /** Cumulative ms one bag may hold a soft exit this way. */
  exitDeferWouldBuyMaxMs: z.coerce.number().int().min(0).max(3_600_000).default(600_000),
  recoverDeferEnabled: z.boolean().default(false),
  recoverDeferLookbackMs: z.coerce.number().int().min(30_000).max(3_600_000).default(300_000),
  recoverDeferMinBouncePct: z.coerce.number().min(0).max(50).default(3),
  /** Profit cap for recover-defer; 0 preserves the existing behavior. */
  recoverDeferMaxPnlPct: z.coerce.number().min(0).max(200).default(0),
  /**
   * 1.11.783 — after our full exit, keep mint on own-tape wake / stream sample
   * / knife enrich for this long (leaders re-hit names over hours; 10m was too short).
   * 0 = off (hot-only wake).
   */
  postExitWakeMs: z.coerce.number().int().min(0).max(86_400_000).default(7_200_000),
  /** Cap of post-exit / recent-trade mints pinned into the wake set. */
  postExitWakeMax: z.coerce.number().int().min(0).max(200).default(48),
  /**
   * 1.11.782 — OFF by default. Leader-seed must NOT drive buys (own stream/
   * discovery only). Observer may still write seed for research.
   */
  leaderSeedEntryEnabled: z.boolean().default(false),
  /**
   * 1.11.761 — when a soft exit is about to fire and a tracked leader just
   * bought the same mint (average-down), defer the sell and optionally
   * scale-in once. 1.11.782 — OFF by default (not copytrading).
   */
  leaderAlignEnabled: z.boolean().default(false),
  /** Max age of leader seed hit to count as “just bought”. */
  leaderAlignMaxAgeMs: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
  /** Still-red floor vs entry (default 3%). Blocks green/flat align. */
  leaderAlignRequireRedPct: z.coerce.number().min(0).max(50).default(3),
  /** Leader fill/mark must be ≥ this % below our entry (0 = ≤ entry). */
  leaderAlignMinBelowEntryPct: z.coerce.number().min(0).max(50).default(0),
  /** Only count leader isAdd (not first bag open). Default off — any buy OK. */
  leaderAlignRequireAdd: z.boolean().default(false),
  /** One-shot average-in USD while deferring (0 = defer only, no buy). */
  leaderAlignScaleInEnabled: z.boolean().default(true),
  leaderAlignScaleInUsd: z.coerce.number().min(0).max(10_000).default(10),
  /**
   * Journal one `mild_dip_mark` row per open position at most this often.
   * Gives an offline price path per trade so trail widths can be re-fitted on
   * our own tape instead of the leader's. 0 = off. 1.11.736 default 5s.
   */
  markJournalMs: z.coerce.number().int().min(0).max(3_600_000).default(5_000),
  hotMintsPath: z.string().default(path.join('data', 'milddip', 'hot-mints.json')),
  priceRingPath: z.string().default(path.join('data', 'milddip', 'price-ring.json')),
  tapeShadowStatePath: z
    .string()
    .default(path.join('data', 'milddip', 'tape-shadow-state.json')),
  /** Telegram ALERT when mark pass / opens / null-ratio signal Dex pressure. */
  loadAlertEnabled: z.boolean().default(true),
  loadAlertMarkPassMs: z.coerce.number().int().min(5_000).max(600_000).default(20_000),
  loadAlertOpenCount: z.coerce.number().int().min(5).max(500).default(50),
  loadAlertNullRatio: z.coerce.number().min(0.1).max(1).default(0.4),
  loadAlertCooldownMs: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
  /** After any close — short so bounce clip can re-enter (1.11.715 → 60s). */
  mintCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  /**
   * After a losing exit (pnl &lt; 0). 1.11.715: same 60s as base so bounce
   * after close is not blocked for 10m.
   */
  lossCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  /**
   * Max successful entries per mint within rolling 24h (0 = off). Wallet-truth
   * backtest: 821/1390 re-entries were churn losses; blocking ~59% of trips
   * cut fees ~$238/48h on live wallet.
   */
  maxEntriesPerMint24h: z.coerce.number().int().min(0).max(100).default(0),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(150),
  minFeeSolReserve: z.coerce.number().min(0).max(10).default(0.02),
  /**
   * Periodic USDC→native SOL top-up when fee SOL wallet value is below floor.
   * Default on: check every 6h; if SOL &lt; $5, buy $20 SOL.
   */
  feeSolTopupEnabled: z.boolean().default(true),
  /** How often to re-check fee SOL when healthy (urgent path still bypasses). */
  feeSolTopupIntervalMs: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
  feeSolTopupMinUsd: z.coerce.number().min(0).max(1_000).default(5),
  feeSolTopupBuyUsd: z.coerce.number().positive().max(500).default(20),
  /**
   * Candidate mint sources: comma list —
   * stream,boosts,profiles,leaders,pg_volume,gecko,seed
   */
  discoverSources: z.string().default('stream,boosts,profiles'),
  seedMintsPath: z.string().optional(),
  /** Sidecar written by leader-observer (`leader_buy_observed` → seed). */
  leaderSeedPath: z.string().default(path.join('data', 'milddip', 'leader-seed.json')),
  leaderSeedMaxAgeMs: z.coerce.number().int().min(60_000).max(86_400_000).default(7_200_000),
  /**
   * 1.11.817 — ceiling 80 → 500. The seed stopped being a wake hint and became
   * the entry gate (1.11.816), so it must hold a full 2h of leader flow
   * (~36 bags/h/leader). Live env asked for 250 and the bot crash-looped on
   * `leaderSeedMax: Number must be less than or equal to 80`.
   */
  leaderSeedMax: z.coerce.number().int().min(0).max(500).default(40),
  /** PumpSwap PG top-vol seed (freshness-gated; soft-fail). */
  pgVolumeMax: z.coerce.number().int().min(0).max(80).default(30),
  pgVolumeCacheMs: z.coerce.number().int().min(15_000).max(600_000).default(60_000),
  pgVolumeLookbackMin: z.coerce.number().int().min(2).max(60).default(10),
  /** GeckoTerminal trending pools seed. */
  geckoMax: z.coerce.number().int().min(0).max(80).default(25),
  geckoCacheMs: z.coerce.number().int().min(30_000).max(600_000).default(120_000),
  geckoPages: z.coerce.number().int().min(1).max(2).default(1),
  /**
   * Deep knife (−50, −20]: wait, then buy only on stabilize / controlled bounce.
   * Ecosystem enables for live mild-dip-bot.
   */
  knifeStabilizeEnabled: z.boolean().default(false),
  knifeStabilizeMinDipPct: z.coerce.number().max(0).default(-50),
  knifeStabilizeMaxDipPct: z.coerce.number().max(0).default(-20),
  knifeStabilizeWaitMs: z.coerce.number().int().min(0).max(3_600_000).default(120_000),
  knifeStabilizeMaxWatchMs: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  knifeStabilizeQuietMs: z.coerce.number().int().min(0).max(600_000).default(45_000),
  knifeStabilizeBandPct: z.coerce.number().min(0).max(50).default(2.5),
  knifeStabilizeMinBouncePct: z.coerce.number().min(0).max(50).default(1.5),
  knifeStabilizeMaxBouncePct: z.coerce.number().min(0).max(50).default(10),
  /** Reject stream-derived knife evidence when Dex contradicts it. */
  knifeDexGreenVeto: z.boolean().default(false),
  /** Dex pc5m at or above this level is considered green for the veto. */
  knifeDexGreenMinPc5m: z.coerce.number().min(-100).max(100).default(0),
  /** Maximum stream-vs-Dex divergence, in percentage points, for knife evidence. */
  knifeStreamDivergenceMaxPp: z.coerce.number().min(0).max(200).default(40),
  /**
   * 1.11.753 — park signal; buy only after extra dump from signal.
   * 1.11.762 — default −10%; main-band only (stabilize buys immediate).
   * 0 waitDipPct = off shape.
   */
  /**
   * 1.11.816 — only enter mints a leader has touched recently.
   * 9.5h live split: mints with a leader print already known to us booked
   * +$9.82 (n=115, winrate 0.63); mints no leader ever touched booked −$7.46
   * (n=56, winrate 0.52). Off = trade the whole discovery universe.
   */
  /**
   * 1.11.827 — tiny real buys on re-entry blocks so we can price the rules.
   * `rebuy_liq_drop` / `rebuy_below_exit` refuse ~2000 times per 3h and we have
   * no forward tape on what we refused: marks stop for mints we do not hold.
   */
  probeBlockedEnabled: z.boolean().default(false),
  /**
   * 1.11.898 — size for the first position on a mint we have never closed.
   * 0 = off (first touch is sized like any other).
   */
  firstTouchPositionUsd: z.coerce.number().min(0).max(10_000).default(0),
  /** 1.11.962 — positive cap enables bounded probe entries; <=0 disables probes. */
  probeBlockedUsd: z.coerce.number().min(0).max(50).default(2),
  probeBlockedMaxPerHour: z.coerce.number().int().min(0).max(120).default(6),
  /**
   * Rug risk is priced, not banned — see `rug-risk.ts`. Leaders take these names
   * at $1–4 while their conviction clip is $10–27; we were flat-sizing both.
   */
  rugKnifeClipUsd: z.coerce.number().min(0).max(100).default(0),
  rugKnifeDumpPct: z.coerce.number().min(-100).max(0).default(-45),
  rugKnifeTurn: z.coerce.number().min(0).max(50).default(3),
  /** pc5m at or below this is refused outright — the dump already happened. */
  rugBlockDumpPct: z.coerce.number().min(-100).max(0).default(0),
  requireLeaderSeen: z.boolean().default(false),
  /** GREEN-only override; true preserves the global leader-seen requirement. */
  greenRequireLeaderSeen: z.boolean().default(true),
  /** 1.11.899 — the same requirement, but only for the first touch on a mint. */
  requireLeaderSeenFirstTouch: z.boolean().default(false),
  /** 1.11.906 — how long we remember that a leader traded a mint. 0 = off. */
  leaderSeenMemoryMs: z.coerce.number().int().min(0).max(30 * 86_400_000).default(0),
  /** Journal-only shadow sample for candidates rejected by the leader gate. */
  leaderGateShadowRecord: z.boolean().default(true),
  leaderGateShadowMinIntervalMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(600_000),
  leaderGateShadowMaxPerHour: z.coerce.number().int().min(0).max(100_000).default(2_000),
  leaderGateShadowDefer: z.boolean().default(false),
  leaderGateShadowDeferMaxPerHour: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(60),
  requireLeaderSeenMaxAgeMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 3_600_000)
    .default(7_200_000),
  /**
   * 1.11.921 — low-turn entries need a leader on the same dip, not just a name
   * touched days ago. 49% of solo buys had turn<0.06 while co-bought was 24%.
   */
  leaderCoBuyAlignEnabled: z.boolean().default(false),
  leaderCoBuyAlignMaxMs: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  /** Entry-only structural trust window; 0 falls back to leaderCoBuyAlignMaxMs. */
  entryLeaderTrustStructuralMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(0),
  leaderCoBuyAlignMinTurn: z.coerce.number().min(0).max(5).default(0.06),
  waitDipEnabled: z.boolean().default(true),
  /**
   * 1.11.803 — allow wait-dip to run under the turn→dump gate (formula selects
   * the mint, wait-dip selects the price). Off = legacy buy-at-signal.
   */
  waitDipWithTurnDump: z.boolean().default(false),
  waitDipPct: z.coerce.number().max(0).default(-10),
  waitDipMaxWatchMs: z.coerce.number().int().min(30_000).max(3_600_000).default(1_200_000),
  entryTroughLookbackMs: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
  waitDipMinTroughAgeMs: z.coerce.number().int().min(0).max(3_600_000).default(0),
  waitDipTroughReadyFraction: z.coerce.number().min(0).max(1).default(0),
  waitDipTroughMinAgeMs: z.coerce.number().int().min(0).max(3_600_000).default(0),
  waitDipTroughMinBouncePct: z.coerce.number().min(0).max(100).default(0),
  waitDipTroughMaxBouncePct: z.coerce.number().min(0).max(100).default(100),
  /** Maximum wait-dip dump from the original signal; 0 = off. */
  waitDipMaxDumpFromSignalPct: z.coerce.number().min(0).max(100).default(0),
  /**
   * 1.11.753 — after ready, allow at most this many pp of dump edge to erode
   * before abort (wait −7% + overshoot 2 → fill/quote must stay ≤ −5% vs signal).
   */
  waitDipMaxOvershootPct: z.coerce.number().min(0).max(20).default(2),
  /** Chase vs ready mark only (not vs park signal). */
  waitDipMaxChasePct: z.coerce.number().min(0).max(20).default(3),
  /** Jupiter quote premium above signal ceiling (must be >0 so live guard runs). */
  waitDipQuotePremiumPct: z.coerce.number().min(0.1).max(10).default(1),
  /**
   * 1.11.773 — 8zkg turn→dump gate. When on, wait-dip is forced off (buy at
   * signal if formula allows; skip if dump too shallow vs turnover).
   * MAIN: pred = alpha + beta·log1p(turn·100); dump = −pc5m.
   * 1.11.777 — optional SHALLOW OR-branch (flatter curve) for scrapes.
   */
  turnDumpGateEnabled: z.boolean().default(false),
  /** GREEN override for the shared turn→dump choke; true preserves the shared gate. */
  greenTurnDumpGate: z.boolean().default(true),
  turnDumpAlpha: z.coerce.number().default(-5.08),
  turnDumpBeta: z.coerce.number().default(6.86),
  /** MAIN: reject when dump < pred − slack (pp). 1.11.774 default 10 (slip). */
  turnDumpShallowSlackPct: z.coerce.number().min(0).max(50).default(10),
  /** MAIN: reject when dump > pred + slack (pp). 0 = no deep ceiling. */
  turnDumpDeepSlackPct: z.coerce.number().min(0).max(80).default(12),
  /** 1.11.777 — second branch: dump ≈ -8.83 + 4.23·log1p(turn·100) ± band. */
  turnDumpShallowBranchEnabled: z.boolean().default(false),
  turnDumpShallowAlpha: z.coerce.number().default(-8.83),
  turnDumpShallowBeta: z.coerce.number().default(4.23),
  turnDumpShallowBandPct: z.coerce.number().min(0).max(50).default(8),
  /**
   * 1.11.793 — 7BNax OR after MAIN|SHALLOW: dump≥min AND turn≥minTurn.
   * Same wallet / same bot — not a second lane.
   */
  turnDumpKnifeBranchEnabled: z.boolean().default(false),
  /** Positive dump depth % (30 ⇒ pc5m ≤ −30). */
  turnDumpKnifeMinDumpPct: z.coerce.number().min(0).max(90).default(30),
  turnDumpKnifeMinTurn: z.coerce.number().min(0).max(10).default(0.3),
  turnDumpKnifeTroughMinAgeMs: z.coerce.number().int().min(0).max(3_600_000).default(0),
  turnDumpKnifeTroughMaxBouncePct: z.coerce.number().min(0).max(100).default(100),
  /**
   * Leader-style bounce clip: dump from ring peak then buy reclaim off trough.
   * Additive to main-band / deep-knife. Second-clip scale-in removed (1.11.730).
   */
  mildStabilizeEnabled: z.boolean().default(false),
  /**
   * When false (default): no fresh mild_stabilize seats
   * (Gymbmn/7rMnp9 green-candle noise).
   */
  mildStabilizeFreshEntryEnabled: z.boolean().default(false),
  mildStabilizeMinDumpPct: z.coerce.number().max(0).default(-25),
  /** Shallowest dump allowed (more negative = require deeper). Was −5. */
  mildStabilizeMaxDumpPct: z.coerce.number().max(0).default(-8),
  /** 1.11.971 — max attempted fresh mild_stabilize buys per rolling hour; 0 = unlimited. */
  mildStabilizeMaxPerHour: z.coerce.number().int().min(0).max(1_000).default(0),
  /** 1.11.971 — global mild_stabilize verdict skip journal budget per hour. */
  mildStabilizeSkipMaxPerHour: z.coerce.number().int().min(0).max(1_000).default(240),
  /** 1.11.972 — minimum ring dump to retain failed-verdict telemetry. */
  mildStabilizeSkipMinDumpPct: z.coerce.number().min(-100).max(0).default(-3),
  mildStabilizeMinBouncePct: z.coerce.number().min(0).max(50).default(1.5),
  mildStabilizeMaxBouncePct: z.coerce.number().min(0).max(50).default(8),
  mildStabilizeTroughMinAgeMs: z.coerce.number().int().min(0).max(600_000).default(15_000),
  /** Last must stay ≥ this % below local peak (0 = off). */
  mildStabilizeMinBelowPeakPct: z.coerce.number().min(0).max(50).default(2),
  /**
   * 1.11.800 — refuse mild_stabilize when live Dex pc5m is greener than this
   * (EjD5Y9: ring dump −8% + bounce while Dex m5 already green).
   */
  mildStabilizeRequireDexDip: z.boolean().default(true),
  mildStabilizeDexMaxDipPct: z.coerce.number().max(0).default(-2),
  /**
   * Autonomous red-hour shallow: when 1h ≤ h1Max and pc5m ∈ (min,max],
   * enter without the main mild band (own logic — not leader copy).
   */
  h1RedShallowEnabled: z.boolean().default(false),
  h1RedShallowH1MaxPct: z.coerce.number().max(0).default(-15),
  h1RedShallowMinDipPct: z.coerce.number().default(-10),
  h1RedShallowMaxDipPct: z.coerce.number().max(0).default(-3),
  /**
   * Flat/chop micro-dip: pc5m ∈ (min,max] while pc1h ∈ [h1Min,h1Max].
   * Own logic (not leader copy) — small scrapes leaders take on range names.
   */
  flatMicroDipEnabled: z.boolean().default(false),
  flatMicroMinDipPct: z.coerce.number().default(-5),
  flatMicroMaxDipPct: z.coerce.number().max(0).default(-1.5),
  /** 1h floor — reject fresh nukes (pc1h worse than this). */
  flatMicroH1MinPct: z.coerce.number().default(-35),
  /** 1h ceiling — reject strong green hours. */
  flatMicroH1MaxPct: z.coerce.number().default(10),
  /** Helius/RPC logsSubscribe on pump programs → hot mint universe. */
  streamEnabled: z.boolean().default(true),
  streamWsUrl: z.string().optional(),
  /** Hard skip — stables / junk mints (comma-separated env). */
  deniedMints: z.array(z.string()).default([]),
  /**
   * Fresh DexScreener check immediately before send — skip if pc5m left the
   * band or price bounced above the signal by more than maxChasePct.
   */
  preBuyRevalidate: z.boolean().default(true),
  /** Max % mark can rise vs signal price before abort (0 = chase check off). */
  maxChasePct: z.coerce.number().min(0).max(50).default(10),
  /**
   * Stream/leader fast-path: skip the Dex enrich batch; one structural fetch +
   * stream drawdown → Jupiter. Default ON.
   */
  fastPathEnabled: z.boolean().default(true),
  /** Chase allowance on fast-path (latency-tolerant). */
  fastPathChasePct: z.coerce.number().min(0).max(50).default(12),
  /** Skip cooldown-bounce guard on fast-path (0 = use maxCooldownBouncePct). */
  fastPathSkipBounce: z.boolean().default(true),
  /** Min gap between fast-path attempts per mint. */
  fastPathMinGapMs: z.coerce.number().int().min(0).max(120_000).default(2_000),
  /**
   * When stream trigger has no local drawdown yet, still Dex-probe hot mints
   * (restores autonomous discovery vs leader-only wake). 0 gap / 0 max = off.
   */
  fastPathHotDexProbeEnabled: z.boolean().default(true),
  fastPathHotDexProbeGapMs: z.coerce.number().int().min(0).max(120_000).default(10_000),
  fastPathHotDexProbeMaxPerMin: z.coerce.number().int().min(0).max(120).default(40),
  /**
   * Soft cooldown after a failed fast-path buy (impact/sim/etc).
   * Default 0 — 15s was burning the dump while price ran +10%.
   * Does NOT touch Helius WS; only gates Jupiter/Dex retries.
   */
  fastPathSoftSkipCooldownMs: z.coerce.number().int().min(0).max(120_000).default(0),
  /**
   * Stream-only main-band entries must be at least this deep (more negative).
   * Blocks −5% ring wiggles (Gs2Liw). Dex+stream / Dex-only use entry band.
   */
  streamOnlyMaxDipPct: z.coerce.number().max(0).default(-10),
  /**
   * When true: stream-only also needs Dex pc5m ≤ dexMaxDipPct.
   * JBKWfC 07:47 — ring −21% / Dex ≈0 after reclaim; leaders sat out.
   * 1.11.779 — can stay on; near-trough fallback covers Dex lag without reclaim.
   */
  streamOnlyRequireDexDip: z.boolean().default(true),
  /** Dex ceiling for stream-only (e.g. −8 = still a dump on Dex tape). */
  streamOnlyDexMaxDipPct: z.coerce.number().max(0).default(-8),
  /** 1.11.779 — null Dex OK when requireDexDip (API lag). */
  streamOnlyAllowMissingDex: z.boolean().default(true),
  /** Hard-reject stream-only when Dex pc5m > 0 (green reclaim). */
  streamOnlyBlockDexGreen: z.boolean().default(true),
  /**
   * When Dex has not confirmed dump: allow stream-only if still near trough
   * (bounce ≤ max). Beats leader-seed on early dumps; blocks JBKWfC reclaim.
   */
  streamOnlyNearTroughEnabled: z.boolean().default(true),
  streamOnlyNearTroughMaxBouncePct: z.coerce.number().min(0).max(50).default(3),
  /** Min price-ring samples in lookback before near-trough / stream-only. */
  streamOnlyMinSamples: z.coerce.number().int().min(1).max(64).default(3),
  /**
   * 1.11.790 — reject pump-wick "dumps": when rally into the swing peak
   * is ≥ this %, |dump extent| must be ≥ rally × dumpRallyMinFrac.
   * 0 = off. Default 12 — EjD5-class +30% pump / −2.7% wick fails.
   */
  dumpRallyGateMinPct: z.coerce.number().min(0).max(200).default(12),
  /** Fraction of pre-peak rally that post-peak dump must cover. 0 = off. */
  dumpRallyMinFrac: z.coerce.number().min(0).max(2).default(0.4),
  /**
   * 1.11.801 — when Dex pc1h ≥ this (pump), require dump ≤ dumpH1PumpMinDumpPct.
   * Catches D2zNEW-class 30→27 pulls when the ring missed the pump base. 0 = off.
   */
  dumpH1PumpMinPct: z.coerce.number().min(0).max(500).default(15),
  /** Required dump depth (negative) while H1 is pumping. */
  dumpH1PumpMinDumpPct: z.coerce.number().max(0).default(-15),
  /** Reuse structural Dex metrics this long (ms). */
  fastPathStructuralCacheMs: z.coerce.number().int().min(1_000).max(120_000).default(8_000),
  /**
   * How long a structural snapshot may be reused when a live Dex fetch returns
   * null. The floors it feeds — liquidity, market cap, pair age, 5m volume — do
   * not move on an 8s scale, while `structural_fetch_null` was 27% of every
   * fast-path skip because DexScreener is rate limited.
   */
  fastPathStructuralStaleMs: z.coerce.number().int().min(0).max(600_000).default(30_000),
  /** Optional GeckoTerminal structural fallback; disabled by default. */
  structuralFallbackEnabled: z.boolean().default(false),
  structuralFallbackMaxPerMin: z.coerce.number().int().min(0).max(60).default(20),
  structuralFallbackMintGapMs: z.coerce.number().int().min(0).max(300_000).default(30_000),
  structuralFallbackCacheTtlMs: z.coerce.number().int().min(0).max(120_000).default(15_000),
  structuralFallbackTimeoutMs: z.coerce.number().int().min(100).max(10_000).default(2_500),
  /**
   * 1.11.863 — scan floor while positions are open. Was a hard-coded 15_000.
   * 0 falls back to `scanIntervalMs`.
   */
  scanIntervalWithOpensMs: z.coerce.number().int().min(0).max(120_000).default(3_000),
  /** Background enrich size (slow lane). Keep small — fast-path owns entries. */
  enrichMax: z.coerce.number().int().min(5).max(400).default(12),
  /**
   * 1.11.859 — green lane. Momentum entries with their own exit; see
   * `src/milddip/green-lane.ts` for how every number below was measured.
   * Off by default: it is a different trade from the dip lane.
   */
  green: z.object({
    enabled: z.boolean().default(false),
    positionUsd: z.coerce.number().min(0).max(10_000).default(1),
    minTurnover5mLiq: z.coerce.number().min(0).max(100).default(0.4),
    minVolume5mUsd: z.coerce.number().min(0).default(8_000),
    minVolume1hUsd: z.coerce.number().min(0).default(60_000),
    minPc5mPct: z.coerce.number().min(0).max(1000).default(14),
    maxPc5mPct: z.coerce.number().min(0).max(1000).default(0),
    tapeMinuteGatesEnabled: z.boolean().default(false),
    minTapeRet1mPct: z.coerce.number().min(-100).max(1000).default(5),
    maxTapePrior5mPct: z.coerce.number().min(-100).max(1000).default(10),
    tapeMinuteStrictFreshnessEnabled: z.boolean().default(true),
    tapeMinuteMinRecentSamples: z.coerce.number().int().min(1).max(60).default(3),
    tapeMinuteLatestMaxAgeMs: z.coerce.number().int().min(0).max(300_000).default(15_000),
    tapeMinuteBoundaryMinAgeMs: z.coerce.number().int().min(0).max(300_000).default(50_000),
    tapeMinuteBoundaryMaxAgeMs: z.coerce.number().int().min(0).max(300_000).default(75_000),
    tapeMinutePriorAnchorMinAgeMs: z.coerce.number().int().min(0).max(900_000).default(270_000),
    tapeMinutePriorAnchorMaxAgeMs: z.coerce.number().int().min(0).max(900_000).default(390_000),
    jupiterMinuteEnabled: z.boolean().default(false),
    jupiterMinuteIntervalMs: z.coerce.number().int().min(500).max(60_000).default(3_000),
    jupiterMinuteMinGapMs: z.coerce.number().int().min(500).max(60_000).default(3_000),
    jupiterMinuteMaxMints: z.coerce.number().int().min(1).max(100).default(10),
    jupiterMinuteTtlMs: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
    jupiterMinuteGraceMs: z.coerce.number().int().min(0).max(600_000).default(90_000),
    jupiterMinuteStreamImpulsePct: z.coerce.number().min(0).max(1000).default(8),
    jupiterMinuteMaxInFlight: z.coerce.number().int().min(1).max(8).default(2),
    jupiterMinuteProbeUsd: z.coerce.number().positive().max(100).default(1),
    jupiterMinuteSlippageBps: z.coerce.number().int().min(1).max(2_000).default(150),
    requirePc1h: z.boolean().default(true),
    minPc1hPct: z.coerce.number().min(-100).max(1000).default(20),
    minBuys5m: z.coerce.number().min(0).max(100_000).default(43),
    maxBuyShare5m: z.coerce.number().min(0).max(1).default(0.85),
    minLiquidityUsd: z.coerce.number().min(0).default(6_000),
    minPairAgeHours: z.coerce.number().min(0).max(10_000).default(1),
    entryMaxVol5mToLiq: z.coerce.number().min(0).max(100_000).default(0),
    chasePct: z.coerce.number().min(0).max(1000).default(0),
    maxRet1mPct: z.coerce.number().min(-100).max(100).default(0),
    takeProfitPct: z.coerce.number().min(0).max(1000).default(30),
    stopPct: z.coerce.number().min(0).max(100).default(6),
    maxHoldMs: z.coerce.number().min(0).default(600_000),
    exitTrailEnabled: z.boolean().default(false),
    exitArmPct: z.coerce.number().min(0).max(1000).default(10),
    exitTrailPct: z.coerce.number().min(0).max(100).default(9),
    exitStopPct: z.coerce.number().min(0).max(100).default(30),
    exitMaxHoldMs: z.coerce.number().int().min(0).default(3_600_000),
    noMoveCutMs: z.coerce.number().int().min(0).default(900_000),
    noMoveMinMfePct: z.coerce.number().min(0).max(1000).default(3),
    fastExitEnabled: z.boolean().default(false),
    strongRet1mPct: z.coerce.number().min(-100).max(1000).default(40),
    fastExitArmPct: z.coerce.number().min(0).max(1000).default(5),
    fastExitTrailPct: z.coerce.number().min(0).max(100).default(6),
    fastExitMaxHoldMs: z.coerce.number().int().min(0).default(900_000),
    maxOpen: z.coerce.number().int().min(0).default(0),
    maxBuysPerHour: z.coerce.number().int().min(0).default(0),
  }),
  leaderMirror: z.object({
    enabled: z.boolean().default(false),
    mirrorOnly: z.boolean().default(false),
    greenCopyEnabled: z.boolean().default(false),
    requireDipCandle: z.boolean().default(true),
    greenCorridorPct: z.coerce.number().min(0).default(1.5),
    greenCopyMaxPc5mPct: z.coerce.number().min(0).default(40),
    exitRefireMax: z.coerce.number().int().min(0).default(0),
    leaderSellExitEnabled: z.boolean().default(false),
    leaderSellExitMaxAgeMs: z.coerce.number().int().min(0).default(60_000),
    leaderSellTradesPath: z.string().default('data/milddip/trades.jsonl'),
    leaderSellOnlyExit: z.boolean().default(false),
    safetyMaxHoldMs: z.coerce.number().int().min(0).default(0),
    leaders: z.array(z.string()).default([]),
    hitMaxAgeMs: z.coerce.number().int().min(1_000).max(600_000).default(45_000),
    observeMs: z.coerce.number().int().min(1_000).max(86_400_000).default(45_000),
    retryWhileLeaderHolds: z.boolean().default(false),
    leaderFillGraceMs: z.coerce.number().int().min(0).default(60_000),
    minLeaderSizeUsd: z.coerce.number().min(0).default(0),
    quoteIntervalMs: z.coerce.number().int().min(500).max(60_000).default(3_000),
    staleQuoteIntervalMs: z.coerce.number().int().min(500).max(60_000).default(5_000),
    quoteMaxAgeMs: z.coerce.number().int().min(500).max(60_000).default(10_000),
    minLiquidityUsd: z.coerce.number().min(0).default(4_000),
    minPairAgeHours: z.coerce.number().min(0).default(1),
    minMcapUsd: z.coerce.number().min(0).default(50_000),
    maxOpen: z.coerce.number().int().min(0).default(3),
    maxQuoteMints: z.coerce.number().int().min(0).max(32).default(8),
    quoteMaxMints: z.coerce.number().int().min(0).max(32).default(8),
    tickIntervalMs: z.coerce.number().int().min(500).max(60_000).default(2_000),
    structuralMaxMints: z.coerce.number().int().min(1).max(8).default(4),
    structuralGapMs: z.coerce.number().int().min(500).max(60_000).default(5_000),
    positionUsd: z.coerce.number().min(0).default(30),
    maxVol5mToLiq: z.coerce.number().min(0).default(2),
    maxEntryPc5mPct: z.coerce.number().max(1000).default(0),
    maxPreEntryPc5mPct: z.coerce.number().max(1000).default(0),
    requireDeepDump: z.boolean().default(false),
    deepDumpPc5mPct: z.coerce.number().max(0).default(-8),
    greenImpulsePct: z.coerce.number().min(0).default(5),
    runUpPc5mPct: z.coerce.number().min(0).default(10),
    maxPremiumPct: z.coerce.number().min(-100).default(2),
    entryGraceMs: z.coerce.number().int().min(0).default(60_000),
    entryGraceMaxPremiumPct: z.coerce.number().min(-100).default(1),
    ladderStepPct: z.coerce.number().min(0).default(5),
    ladderStepAfterAveragePct: z.coerce.number().min(0).default(10),
    ladderSellFraction: z.coerce.number().min(0).max(1).default(0.2),
    ladderDustUsd: z.coerce.number().min(0).default(1.5),
    averageEnabled: z.boolean().default(false),
    averageUsd: z.coerce.number().min(0).default(20),
    averageWindowsMs: z.array(z.coerce.number().int().min(60_000)).min(1).default(DEFAULT_MIRROR_AVERAGE_WINDOWS_MS),
    averageExcludeTailMs: z.coerce.number().int().min(0).default(900_000),
    averageTolerancePct: z.coerce.number().min(0).default(0.5),
    averageMaxTimes: z.coerce.number().int().min(0).default(2),
    averageMinDiscountPct: z.coerce.number().min(0).default(15),
    averageNextDiscountPct: z.coerce.number().min(0).default(15),
    averageMinHoldMs: z.coerce.number().int().min(0).default(120_000),
    cooldownMs: z.coerce.number().int().min(0).default(900_000),
    executionRetryBackoffMs: z.coerce.number().int().min(0).max(60_000).default(3_000),
    executionSlippageMultiplier: z.coerce.number().min(1).max(8).default(2),
    executionSlippageMaxBps: z.coerce.number().int().min(10).max(5_000).default(800),
    exitArmPct: z.coerce.number().min(0).default(2),
    exitTrailPct: z.coerce.number().min(0).default(4),
    ownExitEnabled: z.boolean().default(false),
    ownExitTimeStopMs: z.coerce.number().int().min(0).default(0),
    lossCapUsd: z.coerce.number().min(0).default(0),
    exitStopPct: z.coerce.number().min(0).default(45),
    noMoveCutMs: z.coerce.number().int().min(0).default(600_000),
    noMoveMinMfePct: z.coerce.number().min(0).default(2),
    maxHoldMs: z.coerce.number().int().min(0).default(3_600_000),
  }),
  leaderStyle: z.object({
    enabled: z.boolean().default(false),
    positionUsd: z.coerce.number().min(0).default(0),
    minVol5mToLiq: z.coerce.number().min(0).default(0),
    minLiquidityUsd: z.coerce.number().min(0).default(0),
    maxLiquidityUsd: z.coerce.number().min(0).default(0),
    pullbackPct: z.coerce.number().min(0).default(0),
    pullbackWindowMs: z.coerce.number().int().min(60_000).default(120_000),
    minRingSpanMs: z.coerce.number().int().min(0).default(0),
    minPairAgeMs: z.coerce.number().int().min(0).default(0),
    maxOpen: z.coerce.number().int().min(0).default(0),
    maxBuysPerHour: z.coerce.number().int().min(0).default(0),
    profitReboundPct: z.coerce.number().min(0).default(0),
    pnlTpPct: z.coerce.number().min(0).default(0),
    volFadeRatio: z.coerce.number().min(0).default(0),
    depthDrainMax: z.coerce.number().min(0).default(0),
    maxHoldMs: z.coerce.number().int().min(0).default(0),
    maxEnrich: z.coerce.number().int().min(1).max(200).default(12),
    enrichConcurrency: z.coerce.number().int().min(1).max(12).default(4),
    skipJournalIntervalMs: z.coerce.number().int().min(0).default(60_000),
    skipJournalMaxPerHour: z.coerce.number().int().min(0).default(60),
  }),
  entry: z.object({
    minDipPct: z.number(),
    maxDipPct: z.number(),
    minVolume5mUsd: z.number(),
    /** 1.11.895 — 5m volume as a share of the hourly pace. 0 = off. */
    minVolume5mPaceRatio: z.number(),
    /** 1.11.904 — 5m volume over pool liquidity. 0 = off. */
    minTurnover5mLiq: z.number(),
    /** 1.11.907 — upper bound on 5m volume over liquidity. 0 = off. */
    maxTurnover5mLiq: z.number(),
    /**
     * 1.11.870 — upper bound on 5m volume at entry. 0 = off.
     * A name doing this much in five minutes is inside an event, and we are on
     * the wrong side of it: see the ceiling note in `ecosystem.config.cjs`.
     */
    maxVolume5mUsd: z.number(),
    minLiquidityUsd: z.number(),
    minMarketCapUsd: z.number(),
    maxMarketCapUsd: z.number(),
    minPairAgeHours: z.number(),
    /**
     * 1.11.905 — the age floor for a name a leader is buying. 0 = no exception.
     * Only ever lowers the floor, never raises it.
     */
    minPairAgeHoursLeaderSeen: z.number(),
    maxPairAgeHours: z.number(),
    allowedDexIds: z.array(z.string()),
  }),
  exit: z.object({
    /** W9.1: arm when MFE ≥ armPct. */
    armPct: z.number(),
    /** Armed: sell scaleOutFraction at this giveback % (0=off). */
    partialGivebackPct: z.coerce.number().min(0).max(100).default(3),
    /** Fraction sold on partial giveback (default 0.5). */
    scaleOutFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** W9.1: full exit when giveback from peak ≤ −givebackPct. */
    givebackPct: z.number(),
    /**
     * 1.11.750 — MFE bank + runner sleeve (default on).
     * When on, classic armed −3%/−8% giveback scale-out is skipped.
     */
    mfeBankEnabled: z.boolean().default(true),
    mfeBank1Pct: z.coerce.number().min(0).max(500).default(8),
    mfeBank1Fraction: z.coerce.number().min(0).max(1).default(0.4),
    mfeBank2Pct: z.coerce.number().min(0).max(500).default(15),
    mfeBank2Fraction: z.coerce.number().min(0).max(1).default(0.4),
    mfeBankSleeveGivebackPct: z.coerce.number().min(0).max(100).default(12),
    /** 1.11.849 — Oscar-style unbounded TP ladder. 0 = off (mfe-bank owns exits). */
    tpGridStepPct: z.coerce.number().min(0).max(500).default(0),
    /** 1.11.957 — first TP-grid rung; 0 = use tpGridStepPct. */
    tpGridFirstRungPct: z.coerce.number().min(0).max(500).default(0),
    /** 1.11.993 — minimum spacing between successful TP-grid fills. */
    tpGridMinGapMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
    /** 1.11.852 — confirm single-tick jumps larger than this % before acting. */
    markJumpConfirmPct: z.coerce.number().min(0).max(100).default(25),
    /** 1.11.868 — tighter guard for stream prints; 0 = use markJumpConfirmPct. */
    markJumpConfirmStreamPct: z.coerce.number().min(0).max(100).default(8),
    /** Measured mark-to-fill gap on the sell side; taken off the gain only. */
    markSellHaircutPct: z.coerce.number().min(0).max(10).default(1),
    /** 1.11.957 — max quote slip below a profit decision; 0 = off. */
    profitFillMaxSlipPct: z.coerce.number().min(0).max(100).default(0),
    /** 1.11.961 — max quote slip below a bounce-based loss decision; 0 = off. */
    lossFillMaxSlipPct: z.coerce.number().min(0).max(100).default(0),
    /** 1.11.969 — liquidity-drain exit; 0 = off. */
    liqDrainRatio: z.coerce.number().min(0).max(10).default(0.7),
    liqDrainMinAgeMs: z.coerce.number().int().min(0).max(86_400_000).default(600_000),
    liqDrainConfirmTicks: z.coerce.number().int().min(0).max(48).default(2),
    liqDrainSkipArmedRunner: z.boolean().default(true),
    liqAbsFloorUsd: z.coerce.number().min(0).max(10_000_000).default(0),
    /** 1.11.959 — green armed quarantine blind window; 0 = off. */
    markQuarantineGreenMaxMs: z.coerce.number().int().min(0).max(120_000).default(0),
    /** 1.11.910 — the dead-set exit: volume, turnover and price all gone. */
    deadSetVolFadeFrac: z.coerce.number().min(0).max(1).default(0),
    deadSetTurnFadeFrac: z.coerce.number().min(0).max(1).default(0),
    deadSetMinDropPct: z.coerce.number().min(0).max(100).default(10),
    deadSetBouncePct: z.coerce.number().min(0).max(100).default(0),
    deadSetMinHoldMs: z.coerce.number().int().min(0).max(86_400_000).default(300_000),
    /** 1.11.855 — breakeven floor once the bag has been green. 0 = off. */
    breakevenArmPct: z.coerce.number().min(0).max(500).default(0),
    breakevenFloorPct: z.coerce.number().min(-100).max(100).default(0),
    tpGridSellFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** 1.11.861 — close out rather than leave less than this of the original. */
    tpGridMinRemainderFraction: z.coerce.number().min(0).max(1).default(0.2),
    /** 1.11.821 — min hold before the first bank (SPL settle race). 0 = off. */
    mfeBankMinHoldMs: z.coerce.number().int().min(0).max(600_000).default(0),
    /** Minimum hold before profitable TP/trail/reclaim exits. 0 = off. */
    profitExitMinHoldMs: z.coerce.number().int().min(0).max(14_400_000).default(0),
    /** PnL threshold that bypasses the profitable-exit minimum hold. 0 = off. */
    profitExitMinHoldBypassPnlPct: z.coerce.number().min(0).max(500).default(0),
    /** 1.11.955 — underwater sleeve fraction; 0 = one full-bag decision. */
    mfeBankSleeveLossPartialFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** 1.11.949 — green sleeve partial; 0 preserves the full-bag exit. */
    mfeBankSleeveGreenPartialFraction: z.coerce.number().min(0).max(1).default(0),
    /** 1.11.953 — wide green sleeve runner trail; 0 keeps the no-op default. */
    mfeBankSleeveRunnerGivebackPct: z.coerce.number().min(0).max(100).default(0),
    /** 1.11.993 — tighter runner giveback after the remainder floor exhausts the ladder. */
    mfeBankSleeveRunnerGivebackExhaustedPct: z.coerce.number().min(0).max(100).default(0),
    /** Never-armed soft giveback after this many ms (0=off). Default off. */
    neverArmPatienceMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
    /**
     * Hold ceiling ms (0=off). Default 15m.
     * 1.11.782 — unarmed always; armed only when mark pnl ≤ 0.
     * Green armed runners may outlive this for TP / trail steps.
     */
    neverArmMaxHoldMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
    /** 1.11.1017 — unconditional underwater time stop; 0 = off. */
    hardTimeStopMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
    /** Never-armed deep-loss cut min hold (0=off). Default 15m. */
    /** 1.11.728 — default 30m (was 15m). */
    neverArmDeadMinMs: z.coerce.number().int().min(0).max(86_400_000).default(1_800_000),
    /** Never-armed deep-loss cut: exit if pnl ≤ −this % (0=off). Default 10. */
    neverArmDeadPnlPct: z.coerce.number().min(0).max(100).default(10),
    /**
     * Never-armed stale: min hold before stagnation cut (0=off). Default 20m.
     * If MFE ≤ maxMfe and pnl ≤ −stalePnl → exit (`never_arm_stale`).
     * 1.11.733 — was 10m (BV5wre full exit at ~11m / MFE 0).
     */
    neverArmStaleMinMs: z.coerce.number().int().min(0).max(86_400_000).default(1_200_000),
    neverArmStaleMaxMfePct: z.coerce.number().min(0).max(100).default(2),
    neverArmStalePnlPct: z.coerce.number().min(0).max(100).default(5),
    /** Never-armed sustained fade: min hold before checks (0=off). Default 15m. */
    neverArmVolFadeMinMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
    /** A 5m window is weak if vol ≤ ratio × entry (0=off). Default 0.25. */
    neverArmVolFadeRatio: z.coerce.number().min(0).max(10).default(0.25),
    /** A 5m window is weak if vol ≤ this USD floor (0=off). Default 300. */
    neverArmVolFadeFloorUsd: z.coerce.number().min(0).default(300),
    /** Min spacing between vol samples (distinct Dex m5 windows). Default 5m. */
    neverArmVolFadeSampleMs: z.coerce.number().int().min(0).max(86_400_000).default(300_000),
    /** Consecutive weak windows required before exit. Default 3. */
    neverArmVolFadeWeakWindows: z.coerce.number().int().min(0).max(48).default(3),
    /** Instant rug / LP-pull cut when pnl ≤ −this % (0=off). Default 50. */
    cliffDumpPnlPct: z.coerce.number().min(0).max(100).default(50),
    dustCloseUsd: z.coerce.number().min(0).max(50).default(0),
    dustCloseMinHoldMs: z.coerce.number().int().min(0).default(1_800_000),
    /**
     * 1.11.791 — hard stop from entry when pnl ≤ −this % (0=off). Default 25.
     */
    hardStopPnlPct: z.coerce.number().min(0).max(100).default(25),
    /** 1.11.791 — fraction sold at hard stop; 0 = full exit. */
    hardStopPartialFraction: z.coerce.number().min(0).max(1).default(0.5),
    /**
     * 1.11.747 — never-arm bounce reclaim (sell into bounce off post-entry trough).
     * 0 bouncePct = off.
     */
    neverArmBounceMinDumpPct: z.coerce.number().min(0).max(100).default(8),
    neverArmBouncePct: z.coerce.number().min(0).max(100).default(8),
    neverArmBounceMinTroughAgeMs: z.coerce
      .number()
      .int()
      .min(0)
      .max(3_600_000)
      .default(60_000),
    /** Armed runner bounce reclaim; default true preserves historical behavior. */
    neverArmBounceArmedRunner: z.boolean().default(true),
    neverArmBounceRequireRedPct: z.coerce.number().min(0).max(100).default(3),
    /** 1.11.851 — bounce may only sell at or above this P&L. −1000 = off. */
    neverArmBounceMinPnlPct: z.coerce.number().min(-1000).max(100).default(-1000),
    /** 1.11.759 — first bounce cut (0.5); 0 = full on first bounce. */
    neverArmBouncePartialFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** 1.11.759 — second bounce for runner (default 16). */
    neverArmBounce2Pct: z.coerce.number().min(0).max(100).default(16),
    /** Never-arm freefall floor (no bounce). 0 = off. */
    neverArmFreefallPnlPct: z.coerce.number().min(0).max(100).default(25),
    neverArmFreefallMinMs: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
    /**
     * 1.11.792 — never-arm HELD+PC+SL (7BNax DOWN): 5m / −15% / pc5m ≤ −5.
     * 0 min = off.
     */
    neverArmTimeRedMinMs: z.coerce.number().int().min(0).max(86_400_000).default(300_000),
    neverArmTimeRedPnlPct: z.coerce.number().min(0).max(100).default(15),
    /** Positive N → require pc5m ≤ −N. 0 = no pc5m gate. */
    neverArmTimeRedMaxPc5mPct: z.coerce.number().min(0).max(100).default(5),
    /**
     * 1.11.920 — min bounce off trough before soft loss exits (0 = off).
     */
    lossExitMinBouncePct: z.coerce.number().min(0).max(100).default(3),
    /**
     * Loss-bounce safety caps. Drawdown reads gainPct, while hard_stop reads
     * pnlPct; staged/averaged entries can make those bases differ. 0 = off.
     */
    lossExitMaxDrawdownPct: z.coerce.number().min(0).max(100).default(0),
    lossExitMaxTroughAgeMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
    /** 1.11.994 — small-loss reclaim wait; 0 = off. */
    lossReclaimMaxLossPct: z.coerce.number().min(0).max(100).default(0),
    lossReclaimTargetPct: z.coerce.number().min(0).max(100).default(2),
    lossReclaimStopPct: z.coerce.number().min(0).max(100).default(25),
    lossReclaimMaxWaitMs: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),
  }),
});

export type MildDipConfig = z.infer<typeof MildDipConfigSchema>;

export function loadMildDipConfig(): MildDipConfig {
  const rpcUrl =
    process.env.MILD_DIP_RPC_URL?.trim() ||
    process.env.COPY_TRADER_RPC_URL?.trim() ||
    liveOscarRpcHttpUrlFromEnv() ||
    resolveSolanaRpcUrl() ||
    '';

  const allowedDexRaw = (process.env.MILD_DIP_ALLOWED_DEX_IDS ?? 'pumpswap,pumpfun,raydium').trim();
  const allowedDexIds = allowedDexRaw
    ? allowedDexRaw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

  const green = {
    enabled: envBool('MILD_DIP_GREEN_ENABLED', false),
    positionUsd: envNum('MILD_DIP_GREEN_POSITION_USD', 1),
    minTurnover5mLiq: envNum('MILD_DIP_GREEN_MIN_TURNOVER', 0.4),
    minVolume5mUsd: envNum('MILD_DIP_GREEN_MIN_VOL5M_USD', 8_000),
    minVolume1hUsd: envNum('MILD_DIP_GREEN_MIN_VOL1H_USD', 60_000),
    minPc5mPct: envNum('MILD_DIP_GREEN_MIN_PC5M_PCT', 14),
    maxPc5mPct: envNum('MILD_DIP_GREEN_MAX_PC5M_PCT', 0),
    tapeMinuteGatesEnabled: envBool('MILD_DIP_GREEN_TAPE_GATES_ENABLED', false),
    minTapeRet1mPct: envNum('MILD_DIP_GREEN_MIN_RET1M_PCT', 5),
    maxTapePrior5mPct: envNum('MILD_DIP_GREEN_MAX_PRIOR5M_PCT', 10),
    tapeMinuteStrictFreshnessEnabled: envBool(
      'MILD_DIP_GREEN_TAPE_STRICT_FRESHNESS_ENABLED',
      true,
    ),
    tapeMinuteMinRecentSamples: envNum('MILD_DIP_GREEN_TAPE_MIN_RECENT_SAMPLES', 3),
    tapeMinuteLatestMaxAgeMs: envNum('MILD_DIP_GREEN_TAPE_LATEST_MAX_AGE_MS', 15_000),
    tapeMinuteBoundaryMinAgeMs: envNum('MILD_DIP_GREEN_TAPE_BOUNDARY_MIN_AGE_MS', 50_000),
    tapeMinuteBoundaryMaxAgeMs: envNum('MILD_DIP_GREEN_TAPE_BOUNDARY_MAX_AGE_MS', 75_000),
    tapeMinutePriorAnchorMinAgeMs: envNum(
      'MILD_DIP_GREEN_TAPE_PRIOR_ANCHOR_MIN_AGE_MS',
      270_000,
    ),
    tapeMinutePriorAnchorMaxAgeMs: envNum(
      'MILD_DIP_GREEN_TAPE_PRIOR_ANCHOR_MAX_AGE_MS',
      390_000,
    ),
    jupiterMinuteEnabled: envBool('MILD_DIP_GREEN_JUPITER_MINUTE_ENABLED', false),
    jupiterMinuteIntervalMs: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_INTERVAL_MS', 3_000),
    jupiterMinuteMinGapMs: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_MIN_GAP_MS', 3_000),
    jupiterMinuteMaxMints: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_MAX_MINTS', 10),
    jupiterMinuteTtlMs: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_TTL_MS', 600_000),
    jupiterMinuteGraceMs: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_GRACE_MS', 90_000),
    jupiterMinuteStreamImpulsePct: envNum(
      'MILD_DIP_GREEN_JUPITER_MINUTE_STREAM_IMPULSE_PCT',
      8,
    ),
    jupiterMinuteMaxInFlight: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_MAX_IN_FLIGHT', 2),
    jupiterMinuteProbeUsd: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_PROBE_USD', 1),
    jupiterMinuteSlippageBps: envNum('MILD_DIP_GREEN_JUPITER_MINUTE_SLIPPAGE_BPS', 150),
    requirePc1h: envBool('MILD_DIP_GREEN_REQUIRE_PC1H', true),
    minPc1hPct: envNum('MILD_DIP_GREEN_MIN_PC1H_PCT', 20),
    minBuys5m: envNum('MILD_DIP_GREEN_MIN_BUYS5M', 43),
    maxBuyShare5m: envNum('MILD_DIP_GREEN_MAX_BUY_SHARE', 0.85),
    minLiquidityUsd: envNum('MILD_DIP_GREEN_MIN_LIQUIDITY_USD', 6_000),
    minPairAgeHours: envNum('MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS', 1),
    entryMaxVol5mToLiq: envNum('MILD_DIP_GREEN_ENTRY_MAX_VOL5M_TO_LIQ', 0),
    chasePct: envNum('MILD_DIP_GREEN_CHASE_PCT', 0),
    maxRet1mPct: envNum('MILD_DIP_GREEN_MAX_RET1M_PCT', 0),
    takeProfitPct: envNum('MILD_DIP_GREEN_TP_PCT', 30),
    stopPct: envNum('MILD_DIP_GREEN_STOP_PCT', 6),
    maxHoldMs: envNum('MILD_DIP_GREEN_MAX_HOLD_MS', 600_000),
    exitTrailEnabled: envBool('MILD_DIP_GREEN_EXIT_TRAIL_ENABLED', false),
    exitArmPct: envNum('MILD_DIP_GREEN_EXIT_ARM_PCT', 10),
    exitTrailPct: envNum('MILD_DIP_GREEN_EXIT_TRAIL_PCT', 9),
    exitStopPct: envNum('MILD_DIP_GREEN_EXIT_STOP_PCT', 30),
    exitMaxHoldMs: envNum('MILD_DIP_GREEN_EXIT_MAX_HOLD_MS', 3_600_000),
    noMoveCutMs: envNum('MILD_DIP_GREEN_NO_MOVE_CUT_MS', 900_000),
    noMoveMinMfePct: envNum('MILD_DIP_GREEN_NO_MOVE_MIN_MFE_PCT', 3),
    fastExitEnabled: envBool('MILD_DIP_GREEN_FAST_EXIT_ENABLED', false),
    strongRet1mPct: envNum('MILD_DIP_GREEN_STRONG_RET1M_PCT', 40),
    fastExitArmPct: envNum('MILD_DIP_GREEN_FAST_EXIT_ARM_PCT', 5),
    fastExitTrailPct: envNum('MILD_DIP_GREEN_FAST_EXIT_TRAIL_PCT', 6),
    fastExitMaxHoldMs: envNum('MILD_DIP_GREEN_FAST_EXIT_MAX_HOLD_MS', 900_000),
    maxOpen: envNum('MILD_DIP_GREEN_MAX_OPEN', 0),
    maxBuysPerHour: envNum('MILD_DIP_GREEN_MAX_BUYS_PER_HOUR', 0),
  };

  const entry: MildDipEntryGates = {
    /** 1.11.702 — wider knife floor (default −25 ⇒ pc5m > −25%). */
    minDipPct: envNum('MILD_DIP_MIN_DIP_PCT', -25),
    /** Inclusive upper bound — require dump depth (default −8 ⇒ pc5m ≤ −8%). */
    maxDipPct: envNum('MILD_DIP_MAX_DIP_PCT', -8),
    /** 1.11.735 — default $500 (was $1500). Dex 5m volume floor before buy. */
    minVolume5mUsd: envNum('MILD_DIP_MIN_VOLUME_5M_USD', 300),
    minVolume5mPaceRatio: envNum('MILD_DIP_MIN_VOL5M_PACE_RATIO', 0),
    minTurnover5mLiq: envNum('MILD_DIP_MIN_TURNOVER_5M_LIQ', 0),
    maxTurnover5mLiq: envNum('MILD_DIP_MAX_TURNOVER_5M_LIQ', 0),
    maxVolume5mUsd: envNum('MILD_DIP_MAX_VOLUME_5M_USD', 0),
    /** 1.11.700 — default $10k (canary $40k was too tight for mild dips). */
    minLiquidityUsd: envNum('MILD_DIP_MIN_LIQUIDITY_USD', 5_000),
    /**
     * Global entry floor ($5k). Knife+micro may arm down to
     * MILD_DIP_MICRO_MIN_MCAP_USD (see knifeStabilizeMinMarketCapUsd).
     */
    minMarketCapUsd: envNum('MILD_DIP_MIN_MCAP_USD', 5_000),
    maxMarketCapUsd: envNum('MILD_DIP_MAX_MCAP_USD', 300_000_000),
    /** 1.11.724 — floor 30m (was 15m). Youngest bucket had worst cliffs. */
    minPairAgeHours: envNum('MILD_DIP_MIN_PAIR_AGE_HOURS', 0.5),
    minPairAgeHoursLeaderSeen: envNum('MILD_DIP_MIN_PAIR_AGE_HOURS_LEADER_SEEN', 0),
    /** 0 = no max age cap (older pump names like CATE still eligible). */
    maxPairAgeHours: envNum('MILD_DIP_MAX_PAIR_AGE_HOURS', 0),
    allowedDexIds,
  };

  /** Built-in junk/stables + optional env extras. */
  const defaultDenied = [
    '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'So11111111111111111111111111111111111111112', // WSOL
  ];
  const deniedExtra = (process.env.MILD_DIP_DENIED_MINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= 32);
  const deniedMints = [...new Set([...defaultDenied, ...deniedExtra])];

  /**
   * W9.1 peak-giveback + never-armed finite exits (no infinite hold).
   * No SL% from entry / hard TP on the armed path.
   */
  const exit: MildDipExitGates = {
    /** 1.11.699 — arm earlier so NV2RYH-style +5.5% MFE is not invisible. */
    armPct: envNum('MILD_DIP_EXIT_ARM_PCT', 5),
    /** Scale-out half at −3% from peak; full remainder at givebackPct. */
    partialGivebackPct: envNum('MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT', 3),
    scaleOutFraction: envNum('MILD_DIP_EXIT_SCALE_OUT_FRACTION', 0.5),
    givebackPct: envNum('MILD_DIP_EXIT_GIVEBACK_PCT', 8),
    /**
     * 1.11.750 — bank +8%×40% / +15%×40%, sleeve 20% trails −12% from peak.
     * Set MILD_DIP_EXIT_MFE_BANK=0 to restore classic −3%/−8% giveback trail.
     */
    mfeBankEnabled: envBool('MILD_DIP_EXIT_MFE_BANK', true),
    mfeBank1Pct: envNum('MILD_DIP_EXIT_MFE_BANK1_PCT', 8),
    mfeBank1Fraction: envNum('MILD_DIP_EXIT_MFE_BANK1_FRACTION', 0.4),
    mfeBank2Pct: envNum('MILD_DIP_EXIT_MFE_BANK2_PCT', 15),
    mfeBank2Fraction: envNum('MILD_DIP_EXIT_MFE_BANK2_FRACTION', 0.4),
    mfeBankSleeveGivebackPct: envNum('MILD_DIP_EXIT_MFE_BANK_SLEEVE_GIVEBACK_PCT', 12),
    tpGridStepPct: envNum('MILD_DIP_EXIT_TP_GRID_STEP_PCT', 0),
    tpGridFirstRungPct: envNum('MILD_DIP_EXIT_TP_GRID_FIRST_RUNG_PCT', 0),
    tpGridMinGapMs: envNum('MILD_DIP_EXIT_TP_GRID_MIN_GAP_MS', 0),
    markJumpConfirmPct: envNum('MILD_DIP_EXIT_MARK_JUMP_CONFIRM_PCT', 25),
    markJumpConfirmStreamPct: envNum('MILD_DIP_EXIT_MARK_JUMP_CONFIRM_STREAM_PCT', 8),
    markSellHaircutPct: envNum('MILD_DIP_EXIT_MARK_SELL_HAIRCUT_PCT', 1),
    profitFillMaxSlipPct: envNum('MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT', 0),
    lossFillMaxSlipPct: envNum('MILD_DIP_EXIT_LOSS_FILL_MAX_SLIP_PCT', 0),
    liqDrainRatio: envNum('MILD_DIP_EXIT_LIQ_DRAIN_RATIO', 0.7),
    liqDrainMinAgeMs: envNum('MILD_DIP_EXIT_LIQ_DRAIN_MIN_AGE_MIN', 10) * 60_000,
    liqDrainConfirmTicks: envNum('MILD_DIP_EXIT_LIQ_DRAIN_CONFIRM_TICKS', 2),
    liqDrainSkipArmedRunner: envBool('MILD_DIP_EXIT_LIQ_DRAIN_SKIP_ARMED_RUNNER', true),
    liqAbsFloorUsd: envNum('MILD_DIP_EXIT_LIQ_ABS_FLOOR_USD', 0),
    markQuarantineGreenMaxMs: envNum('MILD_DIP_EXIT_MARK_QUARANTINE_GREEN_MAX_MS', 0),
    deadSetVolFadeFrac: envNum('MILD_DIP_EXIT_DEAD_SET_VOL_FADE_FRAC', 0),
    deadSetTurnFadeFrac: envNum('MILD_DIP_EXIT_DEAD_SET_TURN_FADE_FRAC', 0),
    deadSetMinDropPct: envNum('MILD_DIP_EXIT_DEAD_SET_MIN_DROP_PCT', 10),
    deadSetBouncePct: envNum('MILD_DIP_EXIT_DEAD_SET_BOUNCE_PCT', 0),
    deadSetMinHoldMs: envNum('MILD_DIP_EXIT_DEAD_SET_MIN_HOLD_MS', 300_000),
    breakevenArmPct: envNum('MILD_DIP_EXIT_BREAKEVEN_ARM_PCT', 0),
    breakevenFloorPct: envNum('MILD_DIP_EXIT_BREAKEVEN_FLOOR_PCT', 0),
    tpGridSellFraction: envNum('MILD_DIP_EXIT_TP_GRID_SELL_FRACTION', 0.5),
    tpGridMinRemainderFraction: envNum('MILD_DIP_EXIT_TP_GRID_MIN_REMAINDER', 0.2),
    mfeBankMinHoldMs: envNum('MILD_DIP_EXIT_MFE_BANK_MIN_HOLD_MS', 0),
    profitExitMinHoldMs: envNum('MILD_DIP_EXIT_PROFIT_MIN_HOLD_MS', 0),
    profitExitMinHoldBypassPnlPct: envNum(
      'MILD_DIP_EXIT_PROFIT_MIN_HOLD_BYPASS_PNL_PCT',
      0,
    ),
    mfeBankSleeveLossPartialFraction: envNum(
      'MILD_DIP_EXIT_MFE_BANK_SLEEVE_LOSS_PARTIAL_FRACTION',
      0.5,
    ),
    mfeBankSleeveGreenPartialFraction: envNum(
      'MILD_DIP_EXIT_MFE_BANK_SLEEVE_GREEN_PARTIAL_FRACTION',
      0,
    ),
    mfeBankSleeveRunnerGivebackPct: envNum(
      'MILD_DIP_EXIT_SLEEVE_RUNNER_GIVEBACK_PCT',
      0,
    ),
    mfeBankSleeveRunnerGivebackExhaustedPct: envNum(
      'MILD_DIP_EXIT_SLEEVE_RUNNER_GIVEBACK_EXHAUSTED_PCT',
      0,
    ),
    /** 0 = disable never_arm_giveback (early −6% cuts were the grind loss). */
    neverArmPatienceMs: envNum('MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS', 0),
    neverArmMaxHoldMs: envNum('MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS', 900_000),
    hardTimeStopMs: envNum('MILD_DIP_EXIT_HARD_TIME_STOP_MS', 0),
    /** Deep-loss cut before max-hold (rugs); not the early 5m knife. */
    neverArmDeadMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS', 1_800_000),
    /** 1.11.706 — align with leader loser med (~−10%), was 15. */
    neverArmDeadPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT', 10),
    /**
     * 1.11.706 — stagnation: 10m unarmed + MFE≤2% + pnl≤−5% → never_arm_stale.
     * Dead-path names flatten early; don't wait for −10/−15.
     */
    neverArmStaleMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS', 1_200_000),
    neverArmStaleMaxMfePct: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_MAX_MFE_PCT', 2),
    neverArmStalePnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_PNL_PCT', 5),
    /**
     * Sustained activity fade — leave only after N consecutive weak 5m windows.
     * One-shot Dex dips (Gymbmn) must not sell.
     */
    neverArmVolFadeMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS', 900_000),
    neverArmVolFadeRatio: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO', 0.25),
    neverArmVolFadeFloorUsd: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD', 300),
    neverArmVolFadeSampleMs: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_SAMPLE_MS', 300_000),
    neverArmVolFadeWeakWindows: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_WEAK_WINDOWS', 3),
    /** 1.11.697 — LP-pull cliff: exit immediately at ≤ −50% mark pnl. */
    cliffDumpPnlPct: envNum('MILD_DIP_EXIT_CLIFF_DUMP_PNL_PCT', 50),
    dustCloseUsd: envNum('MILD_DIP_EXIT_DUST_CLOSE_USD', 0),
    dustCloseMinHoldMs: envNum('MILD_DIP_EXIT_DUST_CLOSE_MIN_HOLD_MS', 1_800_000),
    /** 1.11.791 — first loss stage (half). 0 = off. */
    hardStopPnlPct: envNum('MILD_DIP_EXIT_HARD_STOP_PNL_PCT', 25),
    /** 1.11.791 — sell this fraction at hard stop; 0 = full hard_stop. */
    hardStopPartialFraction: envNum('MILD_DIP_EXIT_HARD_STOP_PARTIAL_FRACTION', 0.5),
    /**
     * 1.11.751 — never-arm bounce hardened vs stream-wick churn (F1XdRe/AENK1Y):
     * trough ≤ −8%, bounce ≥ 8%, trough age ≥ 60s, still red ≤ −3% vs entry.
     * Freefall floor −25% if no bounce ever prints.
     */
    neverArmBounceMinDumpPct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_DUMP_PCT', 8),
    neverArmBouncePct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PCT', 8),
    neverArmBounceMinTroughAgeMs: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_TROUGH_AGE_MS',
      60_000,
    ),
    neverArmBounceArmedRunner: envBool(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_ARMED_RUNNER',
      true,
    ),
    neverArmBounceRequireRedPct: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_REQUIRE_RED_PCT',
      3,
    ),
    neverArmBounceMinPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_PNL_PCT', -1000),
    neverArmBouncePartialFraction: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PARTIAL_FRACTION',
      0.5,
    ),
    neverArmBounce2Pct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_2_PCT', 16),
    neverArmFreefallPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_FREEFALL_PNL_PCT', 25),
    neverArmFreefallMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_FREEFALL_MIN_MS', 60_000),
    /**
     * 1.11.792 — never-arm DOWN formula: held≥5m & pnl≤−15% & pc5m≤−5%.
     * Armed trail / MFE-bank unchanged. Ecosystem zeros freefall/stale/dead/vol_fade/max_hold.
     */
    neverArmTimeRedMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MIN_MS', 300_000),
    neverArmTimeRedPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_TIME_RED_PNL_PCT', 15),
    neverArmTimeRedMaxPc5mPct: envNum('MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MAX_PC5M_PCT', 5),
    /**
     * 1.11.920 — soft loss exits wait for bounce off trough (AzXuLS mfe_bank_sleeve).
     */
    lossExitMinBouncePct: envNum('MILD_DIP_EXIT_LOSS_MIN_BOUNCE_PCT', 3),
    /**
     * Loss-bounce safety caps; 0 keeps the legacy bounce-only behavior.
     */
    lossExitMaxDrawdownPct: envNum('MILD_DIP_EXIT_LOSS_MAX_DRAWDOWN_PCT', 0),
    lossExitMaxTroughAgeMs: envNum('MILD_DIP_EXIT_LOSS_MAX_TROUGH_AGE_MS', 0),
    lossReclaimMaxLossPct: envNum('MILD_DIP_EXIT_LOSS_RECLAIM_MAX_LOSS_PCT', 0),
    lossReclaimTargetPct: envNum('MILD_DIP_EXIT_LOSS_RECLAIM_TARGET_PCT', 2),
    lossReclaimStopPct: envNum('MILD_DIP_EXIT_LOSS_RECLAIM_STOP_PCT', 25),
    lossReclaimMaxWaitMs: envNum('MILD_DIP_EXIT_LOSS_RECLAIM_MAX_WAIT_MS', 3_600_000),
  };

  const raw = {
    executionMode: (process.env.MILD_DIP_EXECUTION_MODE?.trim() || 'live') as string,
    rpcUrl,
    walletSecret: process.env.MILD_DIP_WALLET_SECRET?.trim() || undefined,
    walletPubkeyExpected: process.env.MILD_DIP_WALLET_PUBKEY?.trim() || undefined,
    journalPath:
      process.env.MILD_DIP_JOURNAL_PATH?.trim() || path.join('data', 'milddip', 'journal.jsonl'),
    tradesPath:
      process.env.MILD_DIP_TRADES_PATH?.trim() || path.join('data', 'milddip', 'trades.jsonl'),
    statePath: process.env.MILD_DIP_STATE_PATH?.trim() || path.join('data', 'milddip', 'state.json'),
    positionUsd: process.env.MILD_DIP_POSITION_USD ?? 1,
    sizeLiqPowerCoef: process.env.MILD_DIP_SIZE_LIQ_POWER_COEF ?? 0,
    sizeLiqPowerExp: process.env.MILD_DIP_SIZE_LIQ_POWER_EXP ?? 0.866,
    sizeMinUsd: process.env.MILD_DIP_SIZE_MIN_USD ?? 1,
    sizeMaxUsd: process.env.MILD_DIP_SIZE_MAX_USD ?? 30,
    entryMinPairAgeHours: envNum('MILD_DIP_ENTRY_MIN_PAIR_AGE_HOURS', 1),
    entryMaxVol5mToLiq: envNum('MILD_DIP_ENTRY_MAX_VOL5M_TO_LIQ', 2),
    entryMinLiquidityUsd: envNum('MILD_DIP_ENTRY_MIN_LIQ_USD', 4_000),
    entryMinTxns5m: envNum('MILD_DIP_ENTRY_MIN_TXNS_5M', 0),
    entryMinTurnover5mLiq: envNum('MILD_DIP_ENTRY_MIN_TURNOVER', 0),
    stagedEntryEnabled: envBool('MILD_DIP_STAGED_ENTRY_ENABLED', false),
    stagedFirstUsd: envNum('MILD_DIP_STAGED_FIRST_USD', 5),
    stagedAddTriggerPct: envNum('MILD_DIP_STAGED_ADD_TRIGGER_PCT', 8),
    stagedAddMaxChasePct: envNum('MILD_DIP_STAGED_ADD_MAX_CHASE_PCT', 4),
    stagedAddAnchor: stagedAddAnchorFromEnv(),
    stagedAddTroughTriggerPct: envNum('MILD_DIP_STAGED_ADD_TROUGH_TRIGGER_PCT', 8),
    stagedAddTroughBandPct: envNum('MILD_DIP_STAGED_ADD_TROUGH_BAND_PCT', 4),
    stagedAddMinTroughAgeMs: envNum('MILD_DIP_STAGED_ADD_MIN_TROUGH_AGE_MS', 60_000),
    stagedAddMult: envNum('MILD_DIP_STAGED_ADD_MULT', 2),
    stagedAddMaxUsd: envNum('MILD_DIP_STAGED_ADD_MAX_USD', 0),
    stagedProfitMinOverAvgPct: envNum('MILD_DIP_STAGED_PROFIT_MIN_OVER_AVG_PCT', 1),
    stagedProfitVetoMaxMs: envNum('MILD_DIP_STAGED_PROFIT_VETO_MAX_MS', 0),
    exitRetrySlippageStepBps: envNum('MILD_DIP_EXIT_RETRY_SLIPPAGE_STEP_BPS', 0),
    exitRetrySlippageMaxBps: envNum('MILD_DIP_EXIT_RETRY_SLIPPAGE_MAX_BPS', 800),
    thickPositionUsd: process.env.MILD_DIP_THICK_POSITION_USD ?? 1,
    thickMinMarketCapUsd: process.env.MILD_DIP_THICK_MIN_MCAP_USD ?? 100_000,
    thickMinLiquidityUsd: process.env.MILD_DIP_THICK_MIN_LIQUIDITY_USD ?? 50_000,
    thickMinPairAgeHours: process.env.MILD_DIP_THICK_MIN_PAIR_AGE_HOURS ?? 6,
    /** 1.11.841 — $1 live; knife_stabilize only (see mildDipMicroSizeGatesForSource). */
    microPositionUsd: process.env.MILD_DIP_MICRO_POSITION_USD ?? 1,
    microMinMarketCapUsd: process.env.MILD_DIP_MICRO_MIN_MCAP_USD ?? 5_000,
    microMaxMarketCapUsd: process.env.MILD_DIP_MICRO_MAX_MCAP_USD ?? 50_000,
    maxOpenPositions: process.env.MILD_DIP_MAX_OPEN_POSITIONS ?? 0,
    scanIntervalMs: process.env.MILD_DIP_SCAN_INTERVAL_MS ?? 5_000,
    markIntervalMs: process.env.MILD_DIP_MARK_INTERVAL_MS ?? 2_000,
    markStreamMaxAgeMs: process.env.MILD_DIP_MARK_STREAM_MAX_AGE_MS ?? 300_000,
    streamDexMaxDivergenceFactor: process.env.MILD_DIP_STREAM_DEX_MAX_DIVERGENCE_FACTOR ?? 2,
    entrySignalMarkMaxAgeMs: envNum('MILD_DIP_ENTRY_SIGNAL_MARK_MAX_AGE_MS', 0),
    entrySignalMaxDivergencePct: envNum('MILD_DIP_ENTRY_SIGNAL_MAX_DIVERGENCE_PCT', 0),
    markStreamPreferMaxAgeMs: process.env.MILD_DIP_MARK_STREAM_PREFER_MAX_AGE_MS ?? 15_000,
    markDexRefreshMs: process.env.MILD_DIP_MARK_DEX_REFRESH_MS ?? 8_000,
    markJupiterRefreshMs: process.env.MILD_DIP_MARK_JUPITER_REFRESH_MS ?? 0,
    markJupiterProbeUsd: process.env.MILD_DIP_MARK_JUPITER_PROBE_USD ?? 1,
    markJupiterMaxInFlight: process.env.MILD_DIP_MARK_JUPITER_MAX_IN_FLIGHT ?? 2,
    markJupiterStreamQuietMs: process.env.MILD_DIP_MARK_JUPITER_STREAM_QUIET_MS ?? 5_000,
    markCacheTtlMs: process.env.MILD_DIP_MARK_CACHE_TTL_MS ?? 20_000,
    markArmedMaxAgeMs: process.env.MILD_DIP_MARK_ARMED_MAX_AGE_MS ?? 10_000,
    markJumpConfirmMaxMs: process.env.MILD_DIP_MARK_JUMP_CONFIRM_MAX_MS ?? 8_000,
    markQuarantineGreenMaxMs:
      process.env.MILD_DIP_EXIT_MARK_QUARANTINE_GREEN_MAX_MS ?? 0,
    markQuarantineJupiterGapMs:
      process.env.MILD_DIP_MARK_QUARANTINE_JUPITER_GAP_MS ?? 0,
    /** 1.11.736 — tighter journal so giveback gaps are visible (was 30s). */
    markJournalMs: process.env.MILD_DIP_MARK_JOURNAL_MS ?? 5_000,
    markConcurrency: process.env.MILD_DIP_MARK_CONCURRENCY ?? 48,
    enrichConcurrency: process.env.MILD_DIP_ENRICH_CONCURRENCY ?? 12,
    sellConcurrency: process.env.MILD_DIP_SELL_CONCURRENCY ?? 6,
    loadAlertEnabled: (() => {
      const v = process.env.MILD_DIP_LOAD_ALERT?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    loadAlertMarkPassMs: process.env.MILD_DIP_LOAD_ALERT_MARK_PASS_MS ?? 20_000,
    loadAlertOpenCount: process.env.MILD_DIP_LOAD_ALERT_OPEN_COUNT ?? 50,
    loadAlertNullRatio: process.env.MILD_DIP_LOAD_ALERT_NULL_RATIO ?? 0.4,
    loadAlertCooldownMs: process.env.MILD_DIP_LOAD_ALERT_COOLDOWN_MS ?? 1_800_000,
    mintCooldownMs: process.env.MILD_DIP_MINT_COOLDOWN_MS ?? 60_000,
    lossCooldownMs: process.env.MILD_DIP_LOSS_COOLDOWN_MS ?? 60_000,
    maxEntriesPerMint24h: process.env.MILD_DIP_MAX_ENTRIES_PER_MINT_24H ?? 0,
    slippageBps: process.env.MILD_DIP_SLIPPAGE_BPS ?? 150,
    minFeeSolReserve: process.env.MILD_DIP_MIN_FEE_SOL_RESERVE ?? 0.02,
    feeSolTopupEnabled: (() => {
      const v = process.env.MILD_DIP_FEE_SOL_TOPUP?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    feeSolTopupIntervalMs: process.env.MILD_DIP_FEE_SOL_TOPUP_INTERVAL_MS ?? 1_800_000,
    feeSolTopupMinUsd: process.env.MILD_DIP_FEE_SOL_TOPUP_MIN_USD ?? 5,
    feeSolTopupBuyUsd: process.env.MILD_DIP_FEE_SOL_TOPUP_BUY_USD ?? 20,
    discoverSources: process.env.MILD_DIP_DISCOVER_SOURCES ?? 'stream,boosts,profiles',
    seedMintsPath: process.env.MILD_DIP_SEED_MINTS_PATH?.trim() || undefined,
    leaderSeedPath:
      process.env.MILD_DIP_LEADER_SEED_PATH?.trim() ||
      path.join('data', 'milddip', 'leader-seed.json'),
    leaderSeedMaxAgeMs: process.env.MILD_DIP_LEADER_SEED_MAX_AGE_MS ?? 7_200_000,
    leaderSeedMax: process.env.MILD_DIP_LEADER_SEED_MAX ?? 40,
    pgVolumeMax: process.env.MILD_DIP_PG_VOLUME_MAX ?? 30,
    pgVolumeCacheMs: process.env.MILD_DIP_PG_VOLUME_CACHE_MS ?? 60_000,
    pgVolumeLookbackMin: process.env.MILD_DIP_PG_VOLUME_LOOKBACK_MIN ?? 10,
    geckoMax: process.env.MILD_DIP_GECKO_MAX ?? 25,
    geckoCacheMs: process.env.MILD_DIP_GECKO_CACHE_MS ?? 120_000,
    geckoPages: process.env.MILD_DIP_GECKO_PAGES ?? 1,
    knifeStabilizeEnabled: envBool('MILD_DIP_KNIFE_STABILIZE_ENABLED', false),
    knifeStabilizeMinDipPct: envNum('MILD_DIP_KNIFE_STABILIZE_MIN_DIP_PCT', -50),
    knifeStabilizeMaxDipPct: envNum('MILD_DIP_KNIFE_STABILIZE_MAX_DIP_PCT', -20),
    knifeStabilizeWaitMs: envNum('MILD_DIP_KNIFE_STABILIZE_WAIT_MS', 120_000),
    knifeStabilizeMaxWatchMs: envNum('MILD_DIP_KNIFE_STABILIZE_MAX_WATCH_MS', 600_000),
    knifeStabilizeQuietMs: envNum('MILD_DIP_KNIFE_STABILIZE_QUIET_MS', 45_000),
    knifeStabilizeBandPct: envNum('MILD_DIP_KNIFE_STABILIZE_BAND_PCT', 2.5),
    knifeStabilizeMinBouncePct: envNum('MILD_DIP_KNIFE_STABILIZE_MIN_BOUNCE_PCT', 1.5),
    knifeStabilizeMaxBouncePct: envNum('MILD_DIP_KNIFE_STABILIZE_MAX_BOUNCE_PCT', 10),
    knifeDexGreenVeto: envBool('MILD_DIP_KNIFE_DEX_GREEN_VETO', false),
    knifeDexGreenMinPc5m: envNum('MILD_DIP_KNIFE_DEX_GREEN_MIN_PC5M', 0),
    knifeStreamDivergenceMaxPp: envNum('MILD_DIP_KNIFE_STREAM_DIVERGENCE_MAX_PP', 40),
    /**
     * 1.11.752 — wait extra −7% from signal before buy (MFE-bank CF winner).
     * Set MILD_DIP_WAIT_DIP=0 to restore immediate entries (all branches).
     * 1.11.773 — forced off when turn-dump gate is enabled.
     */
    probeBlockedEnabled: envBool('MILD_DIP_PROBE_BLOCKED', false),
    /** 1.11.962 — positive value enables bounded probes; <=0 disables them. */
    probeBlockedUsd: envNum('MILD_DIP_PROBE_BLOCKED_USD', 2),
    probeBlockedMaxPerHour: envNum('MILD_DIP_PROBE_BLOCKED_MAX_PER_HOUR', 6),
    rugKnifeClipUsd: envNum('MILD_DIP_RUG_KNIFE_CLIP_USD', 0),
    rugKnifeDumpPct: envNum('MILD_DIP_RUG_KNIFE_DUMP_PCT', -45),
    rugKnifeTurn: envNum('MILD_DIP_RUG_KNIFE_TURN', 3),
    rugBlockDumpPct: envNum('MILD_DIP_RUG_BLOCK_DUMP_PCT', 0),
    requireLeaderSeen: envBool('MILD_DIP_REQUIRE_LEADER_SEEN', false),
    greenRequireLeaderSeen: envBool('MILD_DIP_GREEN_REQUIRE_LEADER_SEEN', true),
    requireLeaderSeenFirstTouch: envBool('MILD_DIP_REQUIRE_LEADER_SEEN_FIRST_TOUCH', false),
    leaderSeenMemoryMs: process.env.MILD_DIP_LEADER_SEEN_MEMORY_MS ?? 0,
    leaderGateShadowRecord: envBool('MILD_DIP_LEADER_GATE_SHADOW_RECORD', true),
    leaderGateShadowMinIntervalMs: envNum(
      'MILD_DIP_LEADER_GATE_SHADOW_MIN_INTERVAL_MS',
      600_000,
    ),
    leaderGateShadowMaxPerHour: envNum('MILD_DIP_LEADER_GATE_SHADOW_MAX_PER_HOUR', 2_000),
    leaderGateShadowDefer: envBool('MILD_DIP_LEADER_GATE_SHADOW_DEFER', false),
    leaderGateShadowDeferMaxPerHour: envNum(
      'MILD_DIP_LEADER_GATE_SHADOW_DEFER_MAX_PER_HOUR',
      60,
    ),
    requireLeaderSeenMaxAgeMs: envNum('MILD_DIP_REQUIRE_LEADER_SEEN_MAX_AGE_MS', 7_200_000),
    leaderCoBuyAlignEnabled: envBool('MILD_DIP_LEADER_CO_BUY_ALIGN', false),
    leaderCoBuyAlignMaxMs: envNum('MILD_DIP_LEADER_CO_BUY_ALIGN_MAX_MS', 120_000),
    entryLeaderTrustStructuralMs: envNum(
      'MILD_DIP_ENTRY_LEADER_TRUST_STRUCTURAL_MS',
      0,
    ),
    leaderCoBuyAlignMinTurn: envNum('MILD_DIP_LEADER_CO_BUY_ALIGN_MIN_TURN', 0.06),
    waitDipEnabled: envBool('MILD_DIP_WAIT_DIP', true),
    waitDipWithTurnDump: envBool('MILD_DIP_WAIT_DIP_WITH_TURN_DUMP', false),
    waitDipPct: envNum('MILD_DIP_WAIT_DIP_PCT', -10),
    waitDipMaxWatchMs: envNum('MILD_DIP_WAIT_DIP_MAX_WATCH_MS', 1_200_000),
    entryTroughLookbackMs: envNum('MILD_DIP_ENTRY_TROUGH_LOOKBACK_MS', 900_000),
    waitDipMinTroughAgeMs: envNum('MILD_DIP_WAIT_DIP_MIN_TROUGH_AGE_MS', 0),
    waitDipTroughReadyFraction: envNum('MILD_DIP_WAIT_DIP_TROUGH_READY_FRACTION', 0),
    waitDipTroughMinAgeMs: envNum('MILD_DIP_WAIT_DIP_TROUGH_MIN_AGE_MS', 0),
    waitDipTroughMinBouncePct: envNum('MILD_DIP_WAIT_DIP_TROUGH_MIN_BOUNCE_PCT', 0),
    waitDipTroughMaxBouncePct: envNum('MILD_DIP_WAIT_DIP_TROUGH_MAX_BOUNCE_PCT', 100),
    waitDipMaxDumpFromSignalPct: envNum(
      'MILD_DIP_WAIT_DIP_MAX_DUMP_FROM_SIGNAL_PCT',
      0,
    ),
    waitDipMaxOvershootPct: envNum('MILD_DIP_WAIT_DIP_MAX_OVERSHOOT_PCT', 2),
    waitDipMaxChasePct: envNum('MILD_DIP_WAIT_DIP_MAX_CHASE_PCT', 3),
    waitDipQuotePremiumPct: envNum('MILD_DIP_WAIT_DIP_QUOTE_PREMIUM_PCT', 1),
    turnDumpGateEnabled: envBool('MILD_DIP_TURN_DUMP_GATE', false),
    greenTurnDumpGate: envBool('MILD_DIP_GREEN_TURN_DUMP_GATE', true),
    turnDumpAlpha: envNum('MILD_DIP_TURN_DUMP_ALPHA', -5.08),
    turnDumpBeta: envNum('MILD_DIP_TURN_DUMP_BETA', 6.86),
    turnDumpShallowSlackPct: envNum('MILD_DIP_TURN_DUMP_SHALLOW_SLACK_PCT', 10),
    turnDumpDeepSlackPct: envNum('MILD_DIP_TURN_DUMP_DEEP_SLACK_PCT', 12),
    turnDumpShallowBranchEnabled: envBool('MILD_DIP_TURN_DUMP_SHALLOW_BRANCH', false),
    turnDumpShallowAlpha: envNum('MILD_DIP_TURN_DUMP_SHALLOW_ALPHA', -8.83),
    turnDumpShallowBeta: envNum('MILD_DIP_TURN_DUMP_SHALLOW_BETA', 4.23),
    turnDumpShallowBandPct: envNum('MILD_DIP_TURN_DUMP_SHALLOW_BAND_PCT', 8),
    turnDumpKnifeBranchEnabled: envBool('MILD_DIP_TURN_DUMP_KNIFE_BRANCH', false),
    turnDumpKnifeMinDumpPct: envNum('MILD_DIP_TURN_DUMP_KNIFE_MIN_DUMP_PCT', 30),
    turnDumpKnifeMinTurn: envNum('MILD_DIP_TURN_DUMP_KNIFE_MIN_TURN', 0.3),
    turnDumpKnifeTroughMinAgeMs: envNum(
      'MILD_DIP_TURN_DUMP_KNIFE_TROUGH_MIN_AGE_MS',
      0,
    ),
    turnDumpKnifeTroughMaxBouncePct: envNum(
      'MILD_DIP_TURN_DUMP_KNIFE_TROUGH_MAX_BOUNCE_PCT',
      100,
    ),
    greenMaxCooldownBouncePct: envNum(
      'MILD_DIP_GREEN_MAX_COOLDOWN_BOUNCE_PCT',
      0,
    ),
    mildStabilizeEnabled: envBool('MILD_DIP_MILD_STABILIZE_ENABLED', false),
    mildStabilizeFreshEntryEnabled: envBool('MILD_DIP_MILD_STABILIZE_FRESH_ENTRY', false),
    mildStabilizeMinDumpPct: envNum('MILD_DIP_MILD_STABILIZE_MIN_DUMP_PCT', -25),
    mildStabilizeMaxDumpPct: envNum('MILD_DIP_MILD_STABILIZE_MAX_DUMP_PCT', -8),
    mildStabilizeMaxPerHour: envNum('MILD_DIP_MILD_STABILIZE_MAX_PER_HOUR', 0),
    mildStabilizeSkipMaxPerHour: envNum('MILD_DIP_MILD_STABILIZE_SKIP_MAX_PER_HOUR', 240),
    mildStabilizeSkipMinDumpPct: envNum('MILD_DIP_MILD_STABILIZE_SKIP_MIN_DUMP_PCT', -3),
    mildStabilizeMinBouncePct: envNum('MILD_DIP_MILD_STABILIZE_MIN_BOUNCE_PCT', 1.5),
    mildStabilizeMaxBouncePct: envNum('MILD_DIP_MILD_STABILIZE_MAX_BOUNCE_PCT', 8),
    mildStabilizeTroughMinAgeMs: envNum('MILD_DIP_MILD_STABILIZE_TROUGH_MIN_AGE_MS', 15_000),
    mildStabilizeMinBelowPeakPct: envNum('MILD_DIP_MILD_STABILIZE_MIN_BELOW_PEAK_PCT', 2),
    mildStabilizeRequireDexDip: envBool('MILD_DIP_MILD_STABILIZE_REQUIRE_DEX_DIP', true),
    mildStabilizeDexMaxDipPct: envNum('MILD_DIP_MILD_STABILIZE_DEX_MAX_DIP_PCT', -2),
    h1RedShallowEnabled: envBool('MILD_DIP_H1_RED_SHALLOW_ENABLED', false),
    h1RedShallowH1MaxPct: envNum('MILD_DIP_H1_RED_SHALLOW_H1_MAX_PCT', -15),
    h1RedShallowMinDipPct: envNum('MILD_DIP_H1_RED_SHALLOW_MIN_DIP_PCT', -10),
    h1RedShallowMaxDipPct: envNum('MILD_DIP_H1_RED_SHALLOW_MAX_DIP_PCT', -3),
    flatMicroDipEnabled: envBool('MILD_DIP_FLAT_MICRO_ENABLED', false),
    flatMicroMinDipPct: envNum('MILD_DIP_FLAT_MICRO_MIN_DIP_PCT', -5),
    flatMicroMaxDipPct: envNum('MILD_DIP_FLAT_MICRO_MAX_DIP_PCT', -1.5),
    flatMicroH1MinPct: envNum('MILD_DIP_FLAT_MICRO_H1_MIN_PCT', -35),
    flatMicroH1MaxPct: envNum('MILD_DIP_FLAT_MICRO_H1_MAX_PCT', 10),
    streamEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    streamWsUrl: process.env.MILD_DIP_STREAM_WS_URL?.trim() || undefined,
    deniedMints,
    preBuyRevalidate: (() => {
      const v = process.env.MILD_DIP_PREBUY_REVALIDATE?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    maxChasePct: process.env.MILD_DIP_MAX_CHASE_PCT ?? 10,
    fastPathEnabled: envBool('MILD_DIP_FAST_PATH', true),
    fastPathChasePct: process.env.MILD_DIP_FAST_PATH_CHASE_PCT ?? 12,
    fastPathSkipBounce: envBool('MILD_DIP_FAST_PATH_SKIP_BOUNCE', true),
    fastPathMinGapMs: process.env.MILD_DIP_FAST_PATH_MIN_GAP_MS ?? 2_000,
    /** Stream-hot Dex probe when ring has no dd yet (Agmu8X-class). */
    fastPathHotDexProbeEnabled: envBool('MILD_DIP_FAST_PATH_HOT_DEX_PROBE_ENABLED', true),
    fastPathHotDexProbeGapMs: process.env.MILD_DIP_FAST_PATH_HOT_DEX_PROBE_GAP_MS ?? 10_000,
    fastPathHotDexProbeMaxPerMin: process.env.MILD_DIP_FAST_PATH_HOT_DEX_PROBE_MAX_PER_MIN ?? 40,
    fastPathSoftSkipCooldownMs: process.env.MILD_DIP_FAST_PATH_SOFT_SKIP_MS ?? 0,
    streamOnlyMaxDipPct: process.env.MILD_DIP_STREAM_ONLY_MAX_DIP_PCT ?? -10,
    streamOnlyRequireDexDip: envBool('MILD_DIP_STREAM_ONLY_REQUIRE_DEX_DIP', true),
    streamOnlyDexMaxDipPct: process.env.MILD_DIP_STREAM_ONLY_DEX_MAX_DIP_PCT ?? -8,
    streamOnlyAllowMissingDex: envBool('MILD_DIP_STREAM_ONLY_ALLOW_MISSING_DEX', true),
    streamOnlyBlockDexGreen: envBool('MILD_DIP_STREAM_ONLY_BLOCK_DEX_GREEN', true),
    streamOnlyNearTroughEnabled: envBool('MILD_DIP_STREAM_ONLY_NEAR_TROUGH', true),
    streamOnlyNearTroughMaxBouncePct:
      process.env.MILD_DIP_STREAM_ONLY_NEAR_TROUGH_MAX_BOUNCE_PCT ?? 3,
    streamOnlyMinSamples: process.env.MILD_DIP_STREAM_ONLY_MIN_SAMPLES ?? 3,
    dumpRallyGateMinPct: process.env.MILD_DIP_DUMP_RALLY_GATE_MIN_PCT ?? 12,
    dumpRallyMinFrac: process.env.MILD_DIP_DUMP_RALLY_MIN_FRAC ?? 0.4,
    dumpH1PumpMinPct: process.env.MILD_DIP_DUMP_H1_PUMP_MIN_PCT ?? 15,
    dumpH1PumpMinDumpPct: process.env.MILD_DIP_DUMP_H1_PUMP_MIN_DUMP_PCT ?? -15,
    fastPathStructuralCacheMs: process.env.MILD_DIP_FAST_PATH_STRUCTURAL_CACHE_MS ?? 8_000,
    fastPathStructuralStaleMs:
      process.env.MILD_DIP_FAST_PATH_STRUCTURAL_STALE_MS ?? 30_000,
    structuralFallbackEnabled: envBool('MILD_DIP_STRUCTURAL_FALLBACK_ENABLED', false),
    structuralFallbackMaxPerMin: envNum('MILD_DIP_STRUCTURAL_FALLBACK_MAX_PER_MIN', 20),
    structuralFallbackMintGapMs: envNum('MILD_DIP_STRUCTURAL_FALLBACK_MINT_GAP_MS', 30_000),
    structuralFallbackCacheTtlMs: envNum(
      'MILD_DIP_STRUCTURAL_FALLBACK_CACHE_TTL_MS',
      15_000,
    ),
    structuralFallbackTimeoutMs: envNum(
      'MILD_DIP_STRUCTURAL_FALLBACK_TIMEOUT_MS',
      2_500,
    ),
    enrichMax: process.env.MILD_DIP_ENRICH_MAX ?? 12,
    scanIntervalWithOpensMs: process.env.MILD_DIP_SCAN_INTERVAL_WITH_OPENS_MS ?? 3000,
    maxCooldownBouncePct: process.env.MILD_DIP_MAX_COOLDOWN_BOUNCE_PCT ?? 6,
    rebuyBelowExitPct: process.env.MILD_DIP_REBUY_BELOW_EXIT_PCT ?? 10,
    rebuyBelowExitMaxAgeMs: process.env.MILD_DIP_REBUY_BELOW_EXIT_MAX_AGE_MS ?? 900_000,
    rebuyLiqDropEnabled: envBool('MILD_DIP_REBUY_LIQ_DROP', true),
    rebuyLiqDropMaxAgeMs: process.env.MILD_DIP_REBUY_LIQ_DROP_MAX_AGE_MS ?? 21_600_000,
    rebuyLiqDropMinDropPct: process.env.MILD_DIP_REBUY_LIQ_DROP_MIN_DROP_PCT ?? 0,
    rebuyLiqDropOnlyAfterLoss: envBool('MILD_DIP_REBUY_LIQ_DROP_ONLY_LOSS', true),
    cooldownBounceLookbackMs: process.env.MILD_DIP_COOLDOWN_BOUNCE_LOOKBACK_MS ?? 300_000,
    streamDipEntryEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM_DIP_ENTRY?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    requireStreamPriceEntry: envBool('MILD_DIP_REQUIRE_STREAM_PRICE', true),
    requireStreamPriceMaxAgeMs: process.env.MILD_DIP_REQUIRE_STREAM_PRICE_MAX_AGE_MS ?? 120_000,
    streamPriceSampleEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM_PRICE_SAMPLE?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    streamPriceMinGapMs: process.env.MILD_DIP_STREAM_PRICE_MIN_GAP_MS ?? 500,
    streamPriceConcurrency: process.env.MILD_DIP_STREAM_PRICE_CONCURRENCY ?? 6,
    streamPriceTxRetryEnabled: envBool('MILD_DIP_STREAM_PRICE_TX_RETRY_ENABLED', false),
    streamPriceTxRetryMaxAttempts: envNum('MILD_DIP_STREAM_PRICE_TX_RETRY_MAX_ATTEMPTS', 2),
    streamPriceTxRetryDelayMs: envNum('MILD_DIP_STREAM_PRICE_TX_RETRY_DELAY_MS', 400),
    streamPriceTxRetryMaxAgeMs: envNum('MILD_DIP_STREAM_PRICE_TX_RETRY_MAX_AGE_MS', 30_000),
    tapeShadowEnabled: envBool('MILD_DIP_TAPE_SHADOW_ENABLED', false),
    tapePendingSampleMaxMints: envNum('MILD_DIP_TAPE_PENDING_SAMPLE_MAX_MINTS', 64),
    tapeShadowSampleMaxMints: envNum('MILD_DIP_TAPE_SHADOW_SAMPLE_MAX_MINTS', 0),
    tapeShadowSampleMinGapMs: envNum('MILD_DIP_TAPE_SHADOW_SAMPLE_MIN_GAP_MS', 15_000),
    tapePendingSampleGraceMs: envNum('MILD_DIP_TAPE_PENDING_SAMPLE_GRACE_MS', 300_000),
    tapeGreenMeasureAll: envBool('MILD_DIP_TAPE_GREEN_MEASURE_ALL', false),
    tapeGreenMeasureAllMinIntervalMs: envNum(
      'MILD_DIP_TAPE_GREEN_MEASURE_ALL_MIN_INTERVAL_MS',
      300_000,
    ),
    tapeGreenMeasureAllMaxSignalsPerHour: envNum(
      'MILD_DIP_TAPE_GREEN_MEASURE_ALL_MAX_SIGNALS_PER_HOUR',
      1_500,
    ),
    tapeStructuralFetchMaxPerHour: envNum(
      'MILD_DIP_TAPE_STRUCTURAL_FETCH_MAX_PER_HOUR',
      400,
    ),
    tapeStructuralBatchMs: envNum('MILD_DIP_TAPE_STRUCTURAL_BATCH_MS', 20_000),
    tapeStructuralMissRetryMs: envNum(
      'MILD_DIP_TAPE_STRUCTURAL_MISS_RETRY_MS',
      3_600_000,
    ),
    tapeStructuralErrorRetryMs: envNum(
      'MILD_DIP_TAPE_STRUCTURAL_ERROR_RETRY_MS',
      300_000,
    ),
    tapeStructuralBatchMaxPerHour: envNum(
      'MILD_DIP_TAPE_STRUCTURAL_BATCH_MAX_PER_HOUR',
      200,
    ),
    tapePathMaxPoints: envNum('MILD_DIP_TAPE_PATH_MAX_POINTS', 60),
    tapeExitArmPct: envNum('MILD_DIP_TAPE_EXIT_ARM_PCT', 10),
    tapeExitTrailPct: envNum('MILD_DIP_TAPE_EXIT_TRAIL_PCT', 9),
    tapeExitStopPct: envNum('MILD_DIP_TAPE_EXIT_STOP_PCT', -30),
    tapeExitTimeoutMs: envNum('MILD_DIP_TAPE_EXIT_TIMEOUT_MS', 3_600_000),
    tapeGreenMinLiqUsd: envNum('MILD_DIP_TAPE_GREEN_MIN_LIQ_USD', 1_700),
    tapeGreenMaxLiqUsd: envNum('MILD_DIP_TAPE_GREEN_MAX_LIQ_USD', 20_000),
    tapeGreenMinMcapUsd: envNum('MILD_DIP_TAPE_GREEN_MIN_MCAP_USD', 2_000),
    tapeGreenMinVol5mUsd: envNum('MILD_DIP_TAPE_GREEN_MIN_VOL5M_USD', 150),
    tapeGreenMaxTurnover: envNum('MILD_DIP_TAPE_GREEN_MAX_TURNOVER', 0),
    tapeGreenMinAgeHours: envNum('MILD_DIP_TAPE_GREEN_MIN_AGE_HOURS', 1),
    tapeDipMinLiqUsd: envNum('MILD_DIP_TAPE_DIP_MIN_LIQ_USD', 1_700),
    tapeDipMaxLiqUsd: envNum('MILD_DIP_TAPE_DIP_MAX_LIQ_USD', 6_000),
    tapeDipMinMcapUsd: envNum('MILD_DIP_TAPE_DIP_MIN_MCAP_USD', 2_000),
    tapeDipMinVol5mUsd: envNum('MILD_DIP_TAPE_DIP_MIN_VOL5M_USD', 300),
    tapeDipMaxTurnover: envNum('MILD_DIP_TAPE_DIP_MAX_TURNOVER', 0),
    tapeDipMinAgeHours: envNum('MILD_DIP_TAPE_DIP_MIN_AGE_HOURS', 0.5),
    tapeWindowMs: envNum('MILD_DIP_TAPE_WINDOW_MS', 5_400_000),
    tapeGreenImp60MinPct: envNum('MILD_DIP_TAPE_GREEN_IMP60_MIN_PCT', 0),
    tapeGreenImp5MinPct: envNum('MILD_DIP_TAPE_GREEN_IMP5_MIN_PCT', 4),
    tapeGreenImp5MaxPct: envNum('MILD_DIP_TAPE_GREEN_IMP5_MAX_PCT', 40),
    tapeGreenDd60MaxPct: envNum('MILD_DIP_TAPE_GREEN_DD60_MAX_PCT', -5),
    tapeGreenMinPairAgeHours: envNum('MILD_DIP_TAPE_GREEN_MIN_PAIR_AGE_HOURS', 1),
    tapeDipRangePosMaxPct: envNum('MILD_DIP_TAPE_DIP_RANGE_POS_MAX_PCT', 20),
    tapeDipDd60MaxPct: envNum('MILD_DIP_TAPE_DIP_DD60_MAX_PCT', -40),
    tapeDipImp5MaxPct: envNum('MILD_DIP_TAPE_DIP_IMP5_MAX_PCT', -15),
    tapeDipMinPairAgeHours: envNum('MILD_DIP_TAPE_DIP_MIN_PAIR_AGE_HOURS', 0.5),
    tapeDipMaxPairAgeHours: envNum('MILD_DIP_TAPE_DIP_MAX_PAIR_AGE_HOURS', 24),
    tapeMinIntervalMs: envNum('MILD_DIP_TAPE_MIN_INTERVAL_MS', 60_000),
    tapeMaxSignalsPerHour: envNum('MILD_DIP_TAPE_MAX_SIGNALS_PER_HOUR', 60),
    tapeOutcomeStaleMs: envNum('MILD_DIP_TAPE_OUTCOME_STALE_MS', 300_000),
    tapeIdleEvictMs: envNum('MILD_DIP_TAPE_IDLE_EVICT_MS', 5_400_000),
    tapeSummaryIntervalMs: envNum('MILD_DIP_TAPE_SUMMARY_INTERVAL_MS', 300_000),
    tapeStateSaveMs: envNum('MILD_DIP_TAPE_STATE_SAVE_MS', 60_000),
    /** 1.11.734 — oneshot emptied-bag dump grace on peak_giveback. */
    oneshotDumpGraceEnabled: envBool('MILD_DIP_ONESHOT_DUMP_GRACE', true),
    oneshotDumpGraceMs: process.env.MILD_DIP_ONESHOT_DUMP_GRACE_MS ?? 60_000,
    /** 1.11.767 — sell unmanaged pump ATAs not in open (startup safety net). */
    orphanSweepEnabled: envBool('MILD_DIP_ORPHAN_SWEEP', true),
    orphanSweepMaxSells: process.env.MILD_DIP_ORPHAN_SWEEP_MAX_SELLS ?? 25,
    oneshotDumpMinSellUsd: process.env.MILD_DIP_ONESHOT_DUMP_MIN_SELL_USD ?? 500,
    oneshotDumpMaxPostResidualFrac:
      process.env.MILD_DIP_ONESHOT_DUMP_MAX_POST_RESIDUAL_FRAC ?? 0.02,
    /** 1.11.740 — classify whale vs mass flee before soft giveback. */
    dumpClassifyEnabled: envBool('MILD_DIP_DUMP_CLASSIFY', true),
    dumpClassifyWindowMs: process.env.MILD_DIP_DUMP_CLASSIFY_WINDOW_MS ?? 30_000,
    dumpClassifyWaitMs: process.env.MILD_DIP_DUMP_CLASSIFY_WAIT_MS ?? 5_000,
    dumpClassifyMassMinSellers: process.env.MILD_DIP_DUMP_CLASSIFY_MASS_MIN_SELLERS ?? 3,
    dumpClassifyWhaleShare: process.env.MILD_DIP_DUMP_CLASSIFY_WHALE_SHARE ?? 0.6,
    /** 1.11.744 — defer soft exits while reclaiming off local trough. */
    /** 1.11.749 — default off; dump_classify owns soft-giveback gating. */
    leaderSeedWakeMax: process.env.MILD_DIP_LEADER_SEED_WAKE_MAX ?? 12,
    leaderSeedRelookMs: process.env.MILD_DIP_LEADER_SEED_RELOOK_MS ?? 60_000,
    exitMinSpacingMs: process.env.MILD_DIP_EXIT_MIN_SPACING_MS ?? 10_000,
    exitDeferWouldBuyEnabled: envBool('MILD_DIP_EXIT_DEFER_WOULD_BUY', false),
    exitDeferWouldBuyMaxMs: process.env.MILD_DIP_EXIT_DEFER_WOULD_BUY_MAX_MS ?? 600_000,
    recoverDeferEnabled: envBool('MILD_DIP_RECOVER_DEFER', false),
    recoverDeferLookbackMs: process.env.MILD_DIP_RECOVER_DEFER_LOOKBACK_MS ?? 300_000,
    recoverDeferMinBouncePct: process.env.MILD_DIP_RECOVER_DEFER_MIN_BOUNCE_PCT ?? 3,
    recoverDeferMaxPnlPct: process.env.MILD_DIP_RECOVER_DEFER_MAX_PNL_PCT ?? 0,
    /** 1.11.783 — keep own exits on stream/knife wake (default 2h). */
    postExitWakeMs: process.env.MILD_DIP_POST_EXIT_WAKE_MS ?? 7_200_000,
    postExitWakeMax: process.env.MILD_DIP_POST_EXIT_WAKE_MAX ?? 48,
    /** 1.11.782 — leader-seed must not open buys. */
    leaderSeedEntryEnabled: envBool('MILD_DIP_LEADER_SEED_ENTRY', false),
    /** 1.11.782 — leader-align OFF (own exits; not copy defer/scale-in). */
    leaderAlignEnabled: envBool('MILD_DIP_LEADER_ALIGN', false),
    leaderAlignMaxAgeMs: process.env.MILD_DIP_LEADER_ALIGN_MAX_AGE_MS ?? 120_000,
    leaderAlignRequireRedPct: process.env.MILD_DIP_LEADER_ALIGN_REQUIRE_RED_PCT ?? 3,
    leaderAlignMinBelowEntryPct: process.env.MILD_DIP_LEADER_ALIGN_MIN_BELOW_ENTRY_PCT ?? 0,
    leaderAlignRequireAdd: envBool('MILD_DIP_LEADER_ALIGN_REQUIRE_ADD', false),
    leaderAlignScaleInEnabled: envBool('MILD_DIP_LEADER_ALIGN_SCALE_IN', false),
    leaderAlignScaleInUsd: process.env.MILD_DIP_LEADER_ALIGN_SCALE_IN_USD ?? 10,
    hotMintsPath:
      process.env.MILD_DIP_HOT_MINTS_PATH?.trim() || path.join('data', 'milddip', 'hot-mints.json'),
    priceRingPath:
      process.env.MILD_DIP_PRICE_RING_PATH?.trim() || path.join('data', 'milddip', 'price-ring.json'),
    tapeShadowStatePath:
      process.env.MILD_DIP_TAPE_STATE_PATH?.trim() ||
      path.join('data', 'milddip', 'tape-shadow-state.json'),
    tapePairAgeMaxStaleMs:
      process.env.MILD_DIP_TAPE_PAIR_AGE_MAX_STALE_MS ?? 7 * 86_400_000,
    tapePairAgeMaxEntries: process.env.MILD_DIP_TAPE_PAIR_AGE_MAX_ENTRIES ?? 5_000,
    tapePairAgeBackfillMs: process.env.MILD_DIP_TAPE_PAIR_AGE_BACKFILL_MS ?? 30_000,
    tapePairAgeRetryMs:
      process.env.MILD_DIP_TAPE_PAIR_AGE_RETRY_MS ?? 6 * 3_600_000,
    green,
    leaderMirror: {
      enabled: envBool('MILD_DIP_MIRROR_ENABLED', false),
      mirrorOnly: envBool('MILD_DIP_MIRROR_ONLY', false),
      greenCopyEnabled: envBool('MILD_DIP_MIRROR_GREEN_COPY_ENABLED', false),
      requireDipCandle: envBool('MILD_DIP_MIRROR_REQUIRE_DIP_CANDLE', true),
      greenCorridorPct: envNum('MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT', 1.5),
      greenCopyMaxPc5mPct: envNum('MILD_DIP_MIRROR_GREEN_MAX_PC5M_PCT', 40),
      exitRefireMax: envNum('MILD_DIP_MIRROR_EXIT_REFIRE_MAX', 0),
      leaderSellExitEnabled: envBool('MILD_DIP_MIRROR_LEADER_SELL_ENABLED', false),
      leaderSellExitMaxAgeMs: envNum('MILD_DIP_MIRROR_LEADER_SELL_MAX_AGE_MS', 60_000),
      leaderSellTradesPath:
        process.env.MILD_DIP_MIRROR_LEADER_SELL_TRADES_PATH?.trim() ||
        path.join('data', 'milddip', 'trades.jsonl'),
      leaderSellOnlyExit: envBool('MILD_DIP_MIRROR_LEADER_SELL_ONLY', false),
      lossCapUsd: envNum('MILD_DIP_MIRROR_LOSS_CAP_USD', 0),
      safetyMaxHoldMs: envNum('MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS', 0),
      leaders: (process.env.MILD_DIP_MIRROR_LEADERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      hitMaxAgeMs: envNum('MILD_DIP_MIRROR_LEADER_MAX_AGE_MS', 45_000),
      observeMs: envNum('MILD_DIP_MIRROR_OBSERVE_MS', 45_000),
      retryWhileLeaderHolds: envBool('MILD_DIP_MIRROR_RETRY_WHILE_LEADER_HOLDS', false),
      leaderFillGraceMs: envNum('MILD_DIP_MIRROR_LEADER_FILL_GRACE_MS', 60_000),
      minLeaderSizeUsd: envNum('MILD_DIP_MIRROR_MIN_LEADER_SIZE_USD', 0),
      quoteIntervalMs: envNum('MILD_DIP_MIRROR_QUOTE_INTERVAL_MS', 3_000),
      staleQuoteIntervalMs: envNum('MILD_DIP_MIRROR_STALE_QUOTE_INTERVAL_MS', 5_000),
      quoteMaxAgeMs: envNum('MILD_DIP_MIRROR_QUOTE_MAX_AGE_MS', 10_000),
      minLiquidityUsd: envNum('MILD_DIP_MIRROR_MIN_LIQUIDITY_USD', 4_000),
      minPairAgeHours: envNum('MILD_DIP_MIRROR_MIN_PAIR_AGE_HOURS', 1),
      minMcapUsd: envNum('MILD_DIP_MIRROR_MIN_MCAP_USD', 50_000),
      maxOpen: envNum('MILD_DIP_MIRROR_MAX_OPEN', 3),
      maxQuoteMints: envNum('MILD_DIP_MIRROR_MAX_QUOTE_MINTS', 8),
      quoteMaxMints: envNum('MILD_DIP_MIRROR_QUOTE_MAX_MINTS', 8),
      tickIntervalMs: envNum('MILD_DIP_MIRROR_TICK_INTERVAL_MS', 2_000),
      structuralMaxMints: envNum('MILD_DIP_MIRROR_STRUCTURAL_MAX_MINTS', 4),
      structuralGapMs: envNum('MILD_DIP_MIRROR_STRUCTURAL_GAP_MS', 5_000),
      positionUsd: envNum('MILD_DIP_MIRROR_POSITION_USD', 30),
      maxVol5mToLiq: envNum('MILD_DIP_MIRROR_MAX_VOL5M_TO_LIQ', 2),
      maxEntryPc5mPct: envNum('MILD_DIP_MIRROR_MAX_ENTRY_PC5M_PCT', 0),
      maxPreEntryPc5mPct: envNum('MILD_DIP_MIRROR_MAX_PC5M_PCT', 0),
      requireDeepDump: envBool('MILD_DIP_MIRROR_REQUIRE_DEEP_DUMP', false),
      deepDumpPc5mPct: envNum('MILD_DIP_MIRROR_DEEP_DUMP_PCT', -8),
      greenImpulsePct: envNum('MILD_DIP_MIRROR_GREEN_IMPULSE_PCT', 5),
      runUpPc5mPct: envNum('MILD_DIP_MIRROR_RUNUP_PC5M_PCT', 10),
      maxPremiumPct: envNum('MILD_DIP_MIRROR_MAX_PREMIUM_PCT', 2),
      entryGraceMs: envNum('MILD_DIP_MIRROR_ENTRY_GRACE_MS', 60_000),
      entryGraceMaxPremiumPct: envNum('MILD_DIP_MIRROR_ENTRY_GRACE_MAX_PREMIUM_PCT', 1),
      ladderStepPct: envNum('MILD_DIP_MIRROR_LADDER_STEP_PCT', 5),
      ladderStepAfterAveragePct: envNum('MILD_DIP_MIRROR_LADDER_STEP_AFTER_AVG_PCT', 10),
      ladderSellFraction: envNum('MILD_DIP_MIRROR_LADDER_SELL_FRACTION', 0.2),
      ladderDustUsd: envNum('MILD_DIP_MIRROR_LADDER_DUST_USD', 1.5),
      averageEnabled: envBool('MILD_DIP_MIRROR_AVERAGE_ENABLED', false),
      averageUsd: envNum('MILD_DIP_MIRROR_AVERAGE_USD', 20),
      averageWindowsMs: envMirrorAverageWindowsMs(),
      averageExcludeTailMs: envNum('MILD_DIP_MIRROR_AVERAGE_EXCLUDE_TAIL_MS', 900_000),
      averageTolerancePct: envNum('MILD_DIP_MIRROR_AVERAGE_TOLERANCE_PCT', 0.5),
      averageMaxTimes: envNum('MILD_DIP_MIRROR_AVERAGE_MAX_TIMES', 2),
      averageMinDiscountPct: envNum('MILD_DIP_MIRROR_AVERAGE_MIN_DISCOUNT_PCT', 15),
      averageNextDiscountPct: envNum('MILD_DIP_MIRROR_AVERAGE_NEXT_DISCOUNT_PCT', 15),
      averageMinHoldMs: envNum('MILD_DIP_MIRROR_AVERAGE_MIN_HOLD_MS', 120_000),
      cooldownMs: envNum('MILD_DIP_MIRROR_COOLDOWN_MS', 900_000),
      executionRetryBackoffMs: envNum('MILD_DIP_MIRROR_EXEC_RETRY_BACKOFF_MS', 3_000),
      executionSlippageMultiplier: envNum('MILD_DIP_MIRROR_EXEC_SLIPPAGE_MULTIPLIER', 2),
      executionSlippageMaxBps: envNum('MILD_DIP_MIRROR_EXEC_SLIPPAGE_MAX_BPS', 800),
      exitArmPct: envNum('MILD_DIP_MIRROR_EXIT_ARM_PCT', 2),
      exitTrailPct: envNum('MILD_DIP_MIRROR_EXIT_TRAIL_PCT', 4),
      ownExitEnabled: envBool('MILD_DIP_MIRROR_OWN_EXIT_ENABLED', false),
      ownExitTimeStopMs: envNum('MILD_DIP_MIRROR_OWN_EXIT_TIME_STOP_MS', 0),
      exitStopPct: envNum('MILD_DIP_MIRROR_EXIT_STOP_PCT', 45),
      noMoveCutMs: envNum('MILD_DIP_MIRROR_NO_MOVE_CUT_MS', 600_000),
      noMoveMinMfePct: envNum('MILD_DIP_MIRROR_NO_MOVE_MIN_MFE_PCT', 2),
      maxHoldMs: envNum('MILD_DIP_MIRROR_MAX_HOLD_MS', 3_600_000),
    },
    leaderStyle: {
      enabled: envBool('MILD_DIP_LSTYLE_ENABLED', false),
      positionUsd: envNum('MILD_DIP_LSTYLE_POSITION_USD', 0),
      minVol5mToLiq: envNum('MILD_DIP_LSTYLE_MIN_VOL5M_TO_LIQ', 0),
      minLiquidityUsd: envNum('MILD_DIP_LSTYLE_MIN_LIQUIDITY_USD', 0),
      maxLiquidityUsd: envNum('MILD_DIP_LSTYLE_MAX_LIQUIDITY_USD', 0),
      pullbackPct: envNum('MILD_DIP_LSTYLE_PULLBACK_PCT', 0),
      pullbackWindowMs: envNum('MILD_DIP_LSTYLE_PULLBACK_WINDOW_MS', 120_000),
      minRingSpanMs: envNum('MILD_DIP_LSTYLE_MIN_RING_SPAN_MS', 0),
      minPairAgeMs: envNum('MILD_DIP_LSTYLE_MIN_PAIR_AGE_MS', 0),
      maxOpen: envNum('MILD_DIP_LSTYLE_MAX_OPEN', 0),
      maxBuysPerHour: envNum('MILD_DIP_LSTYLE_MAX_BUYS_PER_HOUR', 0),
      profitReboundPct: envNum('MILD_DIP_LSTYLE_PROFIT_REBOUND_PCT', 0),
      pnlTpPct: envNum('MILD_DIP_LSTYLE_PNL_TP_PCT', 0),
      volFadeRatio: envNum('MILD_DIP_LSTYLE_VOL_FADE_RATIO', 0),
      depthDrainMax: envNum('MILD_DIP_LSTYLE_DEPTH_DRAIN_MAX', 0),
      maxHoldMs: envNum('MILD_DIP_LSTYLE_MAX_HOLD_MS', 0),
      maxEnrich: envNum('MILD_DIP_LSTYLE_MAX_ENRICH', 12),
      enrichConcurrency: envNum('MILD_DIP_LSTYLE_ENRICH_CONCURRENCY', 4),
      skipJournalIntervalMs: envNum('MILD_DIP_LSTYLE_SKIP_JOURNAL_INTERVAL_MS', 60_000),
      skipJournalMaxPerHour: envNum('MILD_DIP_LSTYLE_SKIP_JOURNAL_MAX_PER_HOUR', 60),
    },
    entry,
    exit,
  };

  const parsed = MildDipConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`mild-dip config invalid: ${msg}`);
  }

  if (parsed.data.executionMode === 'live' && !parsed.data.walletSecret) {
    throw new Error('mild-dip live mode requires MILD_DIP_WALLET_SECRET');
  }
  if (!parsed.data.rpcUrl) {
    throw new Error('mild-dip requires MILD_DIP_RPC_URL / COPY_TRADER_RPC_URL / SA_RPC_HTTP_URL');
  }
  if (!(parsed.data.entry.minDipPct < parsed.data.entry.maxDipPct)) {
    throw new Error('mild-dip requires MILD_DIP_MIN_DIP_PCT < MILD_DIP_MAX_DIP_PCT');
  }
  if (
    parsed.data.knifeStabilizeEnabled &&
    !(parsed.data.knifeStabilizeMinDipPct < parsed.data.knifeStabilizeMaxDipPct)
  ) {
    throw new Error(
      'mild-dip requires MILD_DIP_KNIFE_STABILIZE_MIN_DIP_PCT < MILD_DIP_KNIFE_STABILIZE_MAX_DIP_PCT',
    );
  }
  if (
    parsed.data.flatMicroDipEnabled &&
    !(parsed.data.flatMicroMinDipPct < parsed.data.flatMicroMaxDipPct)
  ) {
    throw new Error(
      'mild-dip requires MILD_DIP_FLAT_MICRO_MIN_DIP_PCT < MILD_DIP_FLAT_MICRO_MAX_DIP_PCT',
    );
  }
  if (
    parsed.data.mildStabilizeEnabled &&
    !(parsed.data.mildStabilizeMinDumpPct < parsed.data.mildStabilizeMaxDumpPct)
  ) {
    throw new Error(
      'mild-dip requires MILD_DIP_MILD_STABILIZE_MIN_DUMP_PCT < MILD_DIP_MILD_STABILIZE_MAX_DUMP_PCT',
    );
  }

  // 1.11.773 — turn-dump replaced park-and-wait: enter at signal when formula ok.
  // 1.11.803 — the two are complementary again: turn→dump picks the name, wait-dip
  // picks the price. 8h CF: buying at signal books −$33, waiting −10…−15% more
  // books +$13…+$78. Opt in explicitly so the old behaviour stays the default.
  if (
    parsed.data.turnDumpGateEnabled &&
    parsed.data.waitDipEnabled &&
    !parsed.data.waitDipWithTurnDump
  ) {
    return { ...parsed.data, waitDipEnabled: false };
  }

  return parsed.data;
}
