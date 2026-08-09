import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import type { MildDipEntryGates, MildDipExitGates } from './gates.js';

const ExecutionModeSchema = z.enum(['paper', 'dry_run', 'live']);

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw == null || raw === '') return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const EntryModeSchema = z.enum(['mild_dip', 'awakening', 'green_tape']);

const MildDipConfigSchema = z.object({
  executionMode: ExecutionModeSchema,
  /**
   * `mild_dip` — pc5m dump band (default).
   * `awakening` — dormant → vol5m spike ignition.
   * `green_tape` — leader-like green candle + buy pressure + turnover.
   */
  entryMode: EntryModeSchema.default('mild_dip'),
  rpcUrl: z.string().min(8),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
  journalPath: z.string().min(1),
  statePath: z.string().min(1),
  positionUsd: z.coerce.number().positive().max(10_000).default(5),
  /** 0 = unlimited — keep buying while USDC remains. */
  maxOpenPositions: z.coerce.number().int().min(0).max(500).default(0),
  scanIntervalMs: z.coerce.number().int().min(1_000).max(600_000).default(5_000),
  markIntervalMs: z.coerce.number().int().min(2_000).max(120_000).default(2_000),
  /**
   * DexScreener mark cache TTL — avoid bypassCache hammering the gate.
   * Keep ≈ markIntervalMs (default 2s on sole-consumer Oscar).
   */
  markCacheTtlMs: z.coerce.number().int().min(0).max(120_000).default(2_000),
  /** Parallel DexScreener marks per exit pass. */
  markConcurrency: z.coerce.number().int().min(1).max(64).default(48),
  /** Parallel Dex enrich during candidate scan (still behind Dex gate). */
  enrichConcurrency: z.coerce.number().int().min(1).max(32).default(12),
  /**
   * After Dex probe + vol5m rank, how many top-volume mints get full entry gates
   * (green_tape / awakening). mild_dip uses 80 in the loop.
   */
  maxEnrichPerScan: z.coerce.number().int().min(1).max(80).default(20),
  /**
   * How many stream/priority mints to Dex-probe before ranking by vol5m.
   * Should be ≥ maxEnrichPerScan. Cheap prefilter so we don't gate random noise.
   */
  probeEnrichMax: z.coerce.number().int().min(1).max(120).default(48),
  /**
   * Cap first-seen stream mints force-enriched per rolling minute (0=off).
   * Vol-green: 4 — catch ignition without flooding Dex 120 RPM.
   */
  forceEnrichFirstSeenPerMin: z.coerce.number().int().min(0).max(30).default(0),
  /**
   * Green-tape: block entry when local ring over this window is ≤0 (1m-red proxy).
   * 0 = off. Default 60s.
   */
  greenTapeShortRedWindowMs: z.coerce.number().int().min(0).max(600_000).default(60_000),
  /** Hard wall-clock budget for one enrich pass (ms). */
  enrichBudgetMs: z.coerce.number().int().min(3_000).max(180_000).default(40_000),
  /**
   * green_tape: skip Dex/Gecko enrich entirely — stream → local 1m impulse → buy.
   * Oscar mild_dip leaves this false.
   */
  streamImpulseOnly: z.boolean().default(false),
  /** Parallel Jupiter sells — sole consumer can push higher. */
  sellConcurrency: z.coerce.number().int().min(1).max(8).default(6),
  /** Journal entry_skip / awaken_skip for enriched fails (default on). */
  journalEntrySkips: z.boolean().default(true),
  /**
   * Max bounce % off the price-ring trough (cooldown lookback) before rebuy.
   * 0 = off. Default 6 — refuse buying a “good” bounce off the wick.
   */
  maxCooldownBouncePct: z.coerce.number().min(0).max(100).default(6),
  /** Lookback window for trough / stream drawdown (default = 5m cooldown). */
  cooldownBounceLookbackMs: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  /** Allow entry when stream drawdown is in dip band even if Dex pc5m is flat. */
  streamDipEntryEnabled: z.boolean().default(true),
  /** Decode program-log signatures → stream price samples (RPC). */
  streamPriceSampleEnabled: z.boolean().default(true),
  streamPriceMinGapMs: z.coerce.number().int().min(500).max(60_000).default(2_000),
  streamPriceConcurrency: z.coerce.number().int().min(1).max(8).default(3),
  /**
   * Cap getTransaction mint-resolves/min when Buy/Sell logs omit mint (0=off).
   * Vol-green default 40 — close the PumpSwap blind spot without blowing RPC.
   */
  buyMintResolveMaxPerMin: z.coerce.number().int().min(0).max(600).default(0),
  buyMintResolveConcurrency: z.coerce.number().int().min(1).max(12).default(4),
  /** 0 = derive from maxPerMin in stream starter. */
  buyMintResolveQueueMax: z.coerce.number().int().min(0).max(400).default(0),
  /**
   * Journal one `mild_dip_mark` row per open position at most this often.
   * Gives an offline price path per trade so trail widths can be re-fitted on
   * our own tape instead of the leader's. 0 = off.
   */
  markJournalMs: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  hotMintsPath: z.string().default(path.join('data', 'milddip', 'hot-mints.json')),
  priceRingPath: z.string().default(path.join('data', 'milddip', 'price-ring.json')),
  /** Telegram ALERT when mark pass / opens / null-ratio signal Dex pressure. */
  loadAlertEnabled: z.boolean().default(true),
  loadAlertMarkPassMs: z.coerce.number().int().min(5_000).max(600_000).default(20_000),
  loadAlertOpenCount: z.coerce.number().int().min(5).max(500).default(50),
  loadAlertNullRatio: z.coerce.number().min(0.1).max(1).default(0.4),
  loadAlertCooldownMs: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
  mintCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),
  /**
   * After a losing exit (pnl &lt; 0), pause rebuy longer than `mintCooldownMs`
   * so grinding dumps are not re-entered every 5m. 0 = disable (use base only).
   */
  lossCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(600_000),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(150),
  minFeeSolReserve: z.coerce.number().min(0).max(10).default(0.02),
  /** Candidate mint sources: comma list — stream,boosts,profiles,seed */
  discoverSources: z.string().default('stream,boosts,profiles'),
  seedMintsPath: z.string().optional(),
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
  maxChasePct: z.coerce.number().min(0).max(50).default(4),
  /**
   * Jupiter quote premium vs signal/mark anchor (%). 0 = fall back to maxChasePct
   * (legacy mild-dip). Vol-green sets this looser than chase so impacty pump
   * quotes are not double-killed by a tight premium guard.
   */
  quotePremiumGuardPct: z.coerce.number().min(0).max(100).default(0),
  entry: z.object({
    minDipPct: z.number(),
    maxDipPct: z.number(),
    minVolume5mUsd: z.number(),
    minLiquidityUsd: z.number(),
    minMarketCapUsd: z.number(),
    maxMarketCapUsd: z.number(),
    minPairAgeHours: z.number(),
    maxPairAgeHours: z.number(),
    allowedDexIds: z.array(z.string()),
  }),
  /** Oscar exit stack (mfeBank / bounce / time_red) — validated at runtime via MildDipExitGates. */
  exit: z.custom<import('./gates.js').MildDipExitGates>(),
  /** Leader-like green candle gates — liquid OR early OR rocket. */
  greenTape: z.object({
    minLiquidityUsd: z.number(),
    minMarketCapUsd: z.number(),
    maxMarketCapUsd: z.number(),
    minPairAgeHours: z.number(),
    maxPairAgeHours: z.number(),
    allowedDexIds: z.array(z.string()),
    impulseMinPc5mPct: z.number(),
    impulseMaxPc5mPct: z.number(),
    impulseMinVolume5mUsd: z.number(),
    impulseMinBuySellRatio5m: z.number(),
    impulseMinTurnover5m: z.number(),
    liquidMinPc5mPct: z.number(),
    liquidMaxPc5mPct: z.number(),
    liquidMinVolume5mUsd: z.number(),
    liquidMinBuySellRatio5m: z.number(),
    liquidMinTurnover5m: z.number(),
    liquidMidPc5mLo: z.number(),
    liquidMidPc5mHi: z.number(),
    liquidMidMinBuySellRatio5m: z.number(),
    liquidMidMinTurnover5m: z.number(),
    earlyMinPc5mPct: z.number(),
    earlyMaxPc5mPct: z.number(),
    earlyMinVolume5mUsd: z.number(),
    earlyMinBuySellRatio5m: z.number(),
    earlyMinTurnover5m: z.number(),
    earlyMinMarketCapUsd: z.number(),
    rocketMinPc5mPct: z.number(),
    rocketMaxPc5mPct: z.number(),
    rocketMinVolume5mUsd: z.number(),
    rocketMinBuySellRatio5m: z.number(),
    rocketMinTurnover5m: z.number(),
    rocketMinMarketCapUsd: z.number(),
    extremePc5mPct: z.number(),
    extremeMinBuySellRatio5m: z.number(),
    liquidTapeMinLiquidityUsd: z.number(),
    liquidTapeMinPairAgeHours: z.number(),
    liquidTapeMinVolume5mUsd: z.number(),
    liquidTapeMinPc5mPct: z.number(),
    liquidTapeMaxPc5mPct: z.number(),
    liquidTapeMinBuySellRatio5m: z.number(),
    liquidTapeMinRingPc5mPct: z.number(),
    /** When true — ONLY 1m triple_green path (disable OR-paths in discover). */
    tripleGreenOnly: z.boolean().default(false),
    tripleSmallMinPc: z.number().default(2),
    tripleSmallMaxPc: z.number().default(12),
    tripleHugeMinPc: z.number().default(20),
    tripleHugeMinVolUsd: z.number().default(200),
    tripleMaxAgeAfterHugeMs: z.coerce.number().int().default(180_000),
    firstStrongMinPc: z.number().default(0),
    firstStrongMaxPriorPc: z.number().default(18),
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

  const entry: MildDipEntryGates = {
    minDipPct: envNum('MILD_DIP_MIN_DIP_PCT', -20),
    /** Inclusive upper bound — require dump depth (default −4 ⇒ pc5m ≤ −4%). */
    maxDipPct: envNum('MILD_DIP_MAX_DIP_PCT', -4),
    minVolume5mUsd: envNum('MILD_DIP_MIN_VOLUME_5M_USD', 1_500),
    /** 1.11.693 — default aligned with exec-friction canary (deeper pools). */
    minLiquidityUsd: envNum('MILD_DIP_MIN_LIQUIDITY_USD', 40_000),
    minMarketCapUsd: envNum('MILD_DIP_MIN_MCAP_USD', 15_000),
    maxMarketCapUsd: envNum('MILD_DIP_MAX_MCAP_USD', 300_000_000),
    minPairAgeHours: envNum('MILD_DIP_MIN_PAIR_AGE_HOURS', 0.25),
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
   * Oscar exit stack (ported for vol-green): mfeBank +8%×0.4 / +15%×0.4 /
   * sleeve −12%; never-arm bounce + time_red 15m/−5%; stale/dead/fade/maxHold off.
   */
  const exit: MildDipExitGates = {
    armPct: envNum('MILD_DIP_EXIT_ARM_PCT', 5),
    partialGivebackPct: envNum('MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT', 3),
    scaleOutFraction: envNum('MILD_DIP_EXIT_SCALE_OUT_FRACTION', 0.5),
    givebackPct: envNum('MILD_DIP_EXIT_GIVEBACK_PCT', 8),
    mfeBankEnabled: envBool('MILD_DIP_EXIT_MFE_BANK', true),
    mfeBank1Pct: envNum('MILD_DIP_EXIT_MFE_BANK1_PCT', 8),
    mfeBank1Fraction: envNum('MILD_DIP_EXIT_MFE_BANK1_FRACTION', 0.4),
    mfeBank2Pct: envNum('MILD_DIP_EXIT_MFE_BANK2_PCT', 15),
    mfeBank2Fraction: envNum('MILD_DIP_EXIT_MFE_BANK2_FRACTION', 0.4),
    mfeBankSleeveGivebackPct: envNum('MILD_DIP_EXIT_MFE_BANK_SLEEVE_GIVEBACK_PCT', 12),
    neverArmPatienceMs: envNum('MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS', 0),
    neverArmMaxHoldMs: envNum('MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS', 0),
    neverArmDeadMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS', 0),
    neverArmDeadPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT', 10),
    neverArmStaleMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS', 0),
    neverArmStaleMaxMfePct: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_MAX_MFE_PCT', 2),
    neverArmStalePnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_STALE_PNL_PCT', 5),
    neverArmVolFadeMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS', 0),
    neverArmVolFadeRatio: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO', 0.25),
    neverArmVolFadeFloorUsd: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD', 300),
    neverArmVolFadeSampleMs: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_SAMPLE_MS', 300_000),
    neverArmVolFadeWeakWindows: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_WEAK_WINDOWS', 3),
    cliffDumpPnlPct: envNum('MILD_DIP_EXIT_CLIFF_DUMP_PNL_PCT', 50),
    neverArmBounceMinDumpPct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_DUMP_PCT', 8),
    neverArmBouncePct: envNum('MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PCT', 8),
    neverArmBounceMinTroughAgeMs: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_TROUGH_AGE_MS',
      60_000,
    ),
    neverArmBounceRequireRedPct: envNum(
      'MILD_DIP_EXIT_NEVER_ARM_BOUNCE_REQUIRE_RED_PCT',
      3,
    ),
    neverArmFreefallPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_FREEFALL_PNL_PCT', 0),
    neverArmFreefallMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_FREEFALL_MIN_MS', 0),
    neverArmTimeRedMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MIN_MS', 900_000),
    neverArmTimeRedPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_TIME_RED_PNL_PCT', 5),
  };

  const entryModeRaw = (process.env.MILD_DIP_ENTRY_MODE ?? 'mild_dip').trim().toLowerCase();
  const entryMode =
    entryModeRaw === 'awakening'
      ? 'awakening'
      : entryModeRaw === 'green_tape' || entryModeRaw === 'green-tape'
        ? 'green_tape'
        : 'mild_dip';

  const greenTape = {
    // CHiHkQx: Dex liq null / ~$9–11k during the vertical; age ~0.09h.
    minLiquidityUsd: envNum('MILD_DIP_GREEN_MIN_LIQUIDITY_USD', 8_000),
    minMarketCapUsd: envNum('MILD_DIP_GREEN_MIN_MCAP_USD', 18_000),
    maxMarketCapUsd: envNum('MILD_DIP_GREEN_MAX_MCAP_USD', 300_000_000),
    minPairAgeHours: envNum('MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS', 0.01),
    maxPairAgeHours: envNum('MILD_DIP_GREEN_MAX_PAIR_AGE_HOURS', 0), // 0 = no ceiling
    allowedDexIds,
    // Impulse: ignore tiny greens; buy when 5m green is large enough (uncapped).
    impulseMinPc5mPct: envNum('MILD_DIP_GREEN_IMPULSE_MIN_PC5M_PCT', 0),
    impulseMaxPc5mPct: envNum('MILD_DIP_GREEN_IMPULSE_MAX_PC5M_PCT', 0),
    impulseMinVolume5mUsd: envNum('MILD_DIP_GREEN_IMPULSE_MIN_VOLUME_5M_USD', 2_500),
    impulseMinBuySellRatio5m: envNum('MILD_DIP_GREEN_IMPULSE_MIN_BUY_SELL_5M', 1),
    impulseMinTurnover5m: envNum('MILD_DIP_GREEN_IMPULSE_MIN_TURNOVER_5M', 0.05),
    // Fat / calm green — require >5% (0–5% was the loss zone in closed set; 2% is not a real impulse).
    liquidMinPc5mPct: envNum('MILD_DIP_GREEN_LIQUID_MIN_PC5M_PCT', 5),
    liquidMaxPc5mPct: envNum('MILD_DIP_GREEN_LIQUID_MAX_PC5M_PCT', 20),
    liquidMinVolume5mUsd: envNum('MILD_DIP_GREEN_LIQUID_MIN_VOLUME_5M_USD', 2_000),
    liquidMinBuySellRatio5m: envNum('MILD_DIP_GREEN_LIQUID_MIN_BUY_SELL_5M', 1),
    liquidMinTurnover5m: envNum('MILD_DIP_GREEN_LIQUID_MIN_TURNOVER_5M', 0.09),
    // Mid-band extras (0 bs = disabled). Vol-green sets lo/hi + stricter bs/turnover.
    liquidMidPc5mLo: envNum('MILD_DIP_GREEN_LIQUID_MID_PC5M_LO', 10),
    liquidMidPc5mHi: envNum('MILD_DIP_GREEN_LIQUID_MID_PC5M_HI', 25),
    liquidMidMinBuySellRatio5m: envNum('MILD_DIP_GREEN_LIQUID_MID_MIN_BUY_SELL_5M', 0),
    liquidMidMinTurnover5m: envNum('MILD_DIP_GREEN_LIQUID_MID_MIN_TURNOVER_5M', 0),
    // Early thin aggressive green (leader / Ef4E8v shape).
    earlyMinPc5mPct: envNum('MILD_DIP_GREEN_EARLY_MIN_PC5M_PCT', 5),
    earlyMaxPc5mPct: envNum('MILD_DIP_GREEN_EARLY_MAX_PC5M_PCT', 25),
    earlyMinVolume5mUsd: envNum('MILD_DIP_GREEN_EARLY_MIN_VOLUME_5M_USD', 400),
    earlyMinBuySellRatio5m: envNum('MILD_DIP_GREEN_EARLY_MIN_BUY_SELL_5M', 2),
    earlyMinTurnover5m: envNum('MILD_DIP_GREEN_EARLY_MIN_TURNOVER_5M', 0.02),
    earlyMinMarketCapUsd: envNum('MILD_DIP_GREEN_EARLY_MIN_MCAP_USD', 18_000),
    // Rocket — already-vertical 5m candle with extreme tape (goon / CHiHkQx).
    rocketMinPc5mPct: envNum('MILD_DIP_GREEN_ROCKET_MIN_PC5M_PCT', 15),
    rocketMaxPc5mPct: envNum('MILD_DIP_GREEN_ROCKET_MAX_PC5M_PCT', 0), // 0 = no upper cap
    rocketMinVolume5mUsd: envNum('MILD_DIP_GREEN_ROCKET_MIN_VOLUME_5M_USD', 8_000),
    rocketMinBuySellRatio5m: envNum('MILD_DIP_GREEN_ROCKET_MIN_BUY_SELL_5M', 1.15),
    // 0 = off when Dex omits liq (turnover unknown) but vol5m already rocket-tier.
    rocketMinTurnover5m: envNum('MILD_DIP_GREEN_ROCKET_MIN_TURNOVER_5M', 0),
    rocketMinMarketCapUsd: envNum('MILD_DIP_GREEN_ROCKET_MIN_MCAP_USD', 18_000),
    // Extreme chase: pc5m > N without buy pressure → reject (0 pc = off).
    extremePc5mPct: envNum('MILD_DIP_GREEN_EXTREME_PC5M_PCT', 0),
    extremeMinBuySellRatio5m: envNum('MILD_DIP_GREEN_EXTREME_MIN_BUY_SELL_5M', 1.35),
    // liquid_tape: high-liq aged + ring-green (0 liq = off).
    liquidTapeMinLiquidityUsd: envNum('MILD_DIP_GREEN_LIQUID_TAPE_MIN_LIQUIDITY_USD', 0),
    liquidTapeMinPairAgeHours: envNum('MILD_DIP_GREEN_LIQUID_TAPE_MIN_PAIR_AGE_HOURS', 1),
    liquidTapeMinVolume5mUsd: envNum('MILD_DIP_GREEN_LIQUID_TAPE_MIN_VOLUME_5M_USD', 1_200),
    liquidTapeMinPc5mPct: envNum('MILD_DIP_GREEN_LIQUID_TAPE_MIN_PC5M_PCT', -2),
    liquidTapeMaxPc5mPct: envNum('MILD_DIP_GREEN_LIQUID_TAPE_MAX_PC5M_PCT', 40),
    liquidTapeMinBuySellRatio5m: envNum('MILD_DIP_GREEN_LIQUID_TAPE_MIN_BUY_SELL_5M', 0.85),
    liquidTapeMinRingPc5mPct: envNum('MILD_DIP_GREEN_LIQUID_TAPE_MIN_RING_PC5M_PCT', 5),
    tripleGreenOnly: (() => {
      const v = process.env.MILD_DIP_GREEN_TRIPLE_ONLY?.trim().toLowerCase();
      if (!v) return false;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    tripleSmallMinPc: envNum('MILD_DIP_GREEN_TRIPLE_SMALL_MIN_PC', 1),
    tripleSmallMaxPc: envNum('MILD_DIP_GREEN_TRIPLE_SMALL_MAX_PC', 12),
    tripleHugeMinPc: envNum('MILD_DIP_GREEN_TRIPLE_HUGE_MIN_PC', 13),
    tripleHugeMinVolUsd: envNum('MILD_DIP_GREEN_TRIPLE_HUGE_MIN_VOL_USD', 150),
    tripleMaxAgeAfterHugeMs: envNum('MILD_DIP_GREEN_TRIPLE_MAX_AGE_AFTER_HUGE_MS', 180_000),
    // 8XjTbP / 5n4FsG: leader bought first +42% 1m; we waited for triple.
    firstStrongMinPc: envNum('MILD_DIP_GREEN_FIRST_STRONG_MIN_PC', 0),
    firstStrongMaxPriorPc: envNum('MILD_DIP_GREEN_FIRST_STRONG_MAX_PRIOR_PC', 18),
  };

  const raw = {
    executionMode: (process.env.MILD_DIP_EXECUTION_MODE?.trim() || 'live') as string,
    entryMode,
    rpcUrl,
    walletSecret: process.env.MILD_DIP_WALLET_SECRET?.trim() || undefined,
    walletPubkeyExpected: process.env.MILD_DIP_WALLET_PUBKEY?.trim() || undefined,
    journalPath:
      process.env.MILD_DIP_JOURNAL_PATH?.trim() || path.join('data', 'milddip', 'journal.jsonl'),
    statePath: process.env.MILD_DIP_STATE_PATH?.trim() || path.join('data', 'milddip', 'state.json'),
    positionUsd: process.env.MILD_DIP_POSITION_USD ?? 5,
    maxOpenPositions: process.env.MILD_DIP_MAX_OPEN_POSITIONS ?? 0,
    scanIntervalMs: process.env.MILD_DIP_SCAN_INTERVAL_MS ?? 5_000,
    markIntervalMs: process.env.MILD_DIP_MARK_INTERVAL_MS ?? 2_000,
    markCacheTtlMs: process.env.MILD_DIP_MARK_CACHE_TTL_MS ?? 2_000,
    markJournalMs: process.env.MILD_DIP_MARK_JOURNAL_MS ?? 30_000,
    markConcurrency: process.env.MILD_DIP_MARK_CONCURRENCY ?? 48,
    enrichConcurrency: process.env.MILD_DIP_ENRICH_CONCURRENCY ?? 12,
    maxEnrichPerScan: process.env.MILD_DIP_MAX_ENRICH ?? 20,
    probeEnrichMax: process.env.MILD_DIP_PROBE_ENRICH_MAX ?? 48,
    forceEnrichFirstSeenPerMin: process.env.MILD_DIP_FORCE_ENRICH_FIRST_SEEN_PER_MIN ?? 0,
    buyMintResolveMaxPerMin: process.env.MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN ?? 0,
    buyMintResolveConcurrency: process.env.MILD_DIP_BUY_MINT_RESOLVE_CONCURRENCY ?? 4,
    buyMintResolveQueueMax: process.env.MILD_DIP_BUY_MINT_RESOLVE_QUEUE_MAX ?? 0,
    greenTapeShortRedWindowMs: process.env.MILD_DIP_GREEN_SHORT_RED_WINDOW_MS ?? 60_000,
    enrichBudgetMs: process.env.MILD_DIP_ENRICH_BUDGET_MS ?? 40_000,
    streamImpulseOnly: (() => {
      const v = (
        process.env.MILD_DIP_STREAM_IMPULSE_ONLY ??
        process.env.VOL_GREEN_STREAM_IMPULSE_ONLY ??
        ''
      )
        .trim()
        .toLowerCase();
      if (!v) return false;
      return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    })(),
    sellConcurrency: process.env.MILD_DIP_SELL_CONCURRENCY ?? 6,
    journalEntrySkips: (() => {
      const v = process.env.MILD_DIP_JOURNAL_ENTRY_SKIPS?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    loadAlertEnabled: (() => {
      const v = process.env.MILD_DIP_LOAD_ALERT?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    loadAlertMarkPassMs: process.env.MILD_DIP_LOAD_ALERT_MARK_PASS_MS ?? 20_000,
    loadAlertOpenCount: process.env.MILD_DIP_LOAD_ALERT_OPEN_COUNT ?? 50,
    loadAlertNullRatio: process.env.MILD_DIP_LOAD_ALERT_NULL_RATIO ?? 0.4,
    loadAlertCooldownMs: process.env.MILD_DIP_LOAD_ALERT_COOLDOWN_MS ?? 1_800_000,
    mintCooldownMs: process.env.MILD_DIP_MINT_COOLDOWN_MS ?? 300_000,
    lossCooldownMs: process.env.MILD_DIP_LOSS_COOLDOWN_MS ?? 600_000,
    slippageBps: process.env.MILD_DIP_SLIPPAGE_BPS ?? 150,
    minFeeSolReserve: process.env.MILD_DIP_MIN_FEE_SOL_RESERVE ?? 0.02,
    discoverSources: process.env.MILD_DIP_DISCOVER_SOURCES ?? 'stream,boosts,profiles',
    seedMintsPath: process.env.MILD_DIP_SEED_MINTS_PATH?.trim() || undefined,
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
    maxChasePct: process.env.MILD_DIP_MAX_CHASE_PCT ?? 4,
    quotePremiumGuardPct: process.env.MILD_DIP_QUOTE_PREMIUM_GUARD_PCT ?? 0,
    maxCooldownBouncePct: process.env.MILD_DIP_MAX_COOLDOWN_BOUNCE_PCT ?? 6,
    cooldownBounceLookbackMs: process.env.MILD_DIP_COOLDOWN_BOUNCE_LOOKBACK_MS ?? 300_000,
    streamDipEntryEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM_DIP_ENTRY?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    streamPriceSampleEnabled: (() => {
      const v = process.env.MILD_DIP_STREAM_PRICE_SAMPLE?.trim().toLowerCase();
      if (!v) return true;
      return v === '1' || v === 'true' || v === 'yes';
    })(),
    streamPriceMinGapMs: process.env.MILD_DIP_STREAM_PRICE_MIN_GAP_MS ?? 2_000,
    streamPriceConcurrency: process.env.MILD_DIP_STREAM_PRICE_CONCURRENCY ?? 3,
    hotMintsPath:
      process.env.MILD_DIP_HOT_MINTS_PATH?.trim() || path.join('data', 'milddip', 'hot-mints.json'),
    priceRingPath:
      process.env.MILD_DIP_PRICE_RING_PATH?.trim() || path.join('data', 'milddip', 'price-ring.json'),
    entry,
    exit,
    greenTape,
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
  if (
    parsed.data.entryMode === 'mild_dip' &&
    !(parsed.data.entry.minDipPct < parsed.data.entry.maxDipPct)
  ) {
    throw new Error('mild-dip requires MILD_DIP_MIN_DIP_PCT < MILD_DIP_MAX_DIP_PCT');
  }

  return parsed.data;
}
