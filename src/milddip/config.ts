import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import type { MildDipEntryGates, MildDipExitGates } from './gates.js';
import type { GreenTapeGates } from '../volgreen/green-tape-gates.js';

const ExecutionModeSchema = z.enum(['paper', 'dry_run', 'live']);

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
  scanIntervalMs: z.coerce.number().int().min(5_000).max(600_000).default(5_000),
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
  /** Hard wall-clock budget for one enrich pass (ms). */
  enrichBudgetMs: z.coerce.number().int().min(3_000).max(180_000).default(40_000),
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
  exit: z.object({
    /** W9.1: arm when MFE ≥ armPct. */
    armPct: z.number(),
    /** W9.1: exit when giveback from peak ≤ −givebackPct. */
    givebackPct: z.number(),
    /** Never-armed soft giveback after this many ms (0=off). Default off. */
    neverArmPatienceMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
    /** Never-armed: force exit after this many ms (0=off). Hard ceiling. */
    neverArmMaxHoldMs: z.coerce.number().int().min(0).max(86_400_000).default(2_400_000),
    /** Never-armed deep-loss cut min hold (0=off). Default 15m. */
    neverArmDeadMinMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
    /** Never-armed deep-loss cut: exit if pnl ≤ −this % (0=off). Default 15. */
    neverArmDeadPnlPct: z.coerce.number().min(0).max(100).default(15),
    /** Never-armed activity fade: min hold before the vol check (0=off). Default 10m. */
    neverArmVolFadeMinMs: z.coerce.number().int().min(0).max(86_400_000).default(600_000),
    /** Exit when vol5m ≤ ratio × entry vol5m (0=off). Default 0.35. */
    neverArmVolFadeRatio: z.coerce.number().min(0).max(10).default(0.35),
    /** Exit when vol5m ≤ this USD floor (0=off). Default 500. */
    neverArmVolFadeFloorUsd: z.coerce.number().min(0).default(500),
  }),
  /** Leader-like green candle gates (`entryMode=green_tape`) — liquid OR early path. */
  greenTape: z.object({
    minLiquidityUsd: z.number(),
    minMarketCapUsd: z.number(),
    maxMarketCapUsd: z.number(),
    minPairAgeHours: z.number(),
    maxPairAgeHours: z.number(),
    allowedDexIds: z.array(z.string()),
    liquidMinPc5mPct: z.number(),
    liquidMaxPc5mPct: z.number(),
    liquidMinVolume5mUsd: z.number(),
    liquidMinBuySellRatio5m: z.number(),
    liquidMinTurnover5m: z.number(),
    earlyMinPc5mPct: z.number(),
    earlyMaxPc5mPct: z.number(),
    earlyMinVolume5mUsd: z.number(),
    earlyMinBuySellRatio5m: z.number(),
    earlyMinTurnover5m: z.number(),
    earlyMinMarketCapUsd: z.number(),
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
   * W9.1 peak-giveback + never-armed finite exits (no infinite hold).
   * No SL% from entry / hard TP on the armed path.
   */
  const exit: MildDipExitGates = {
    armPct: envNum('MILD_DIP_EXIT_ARM_PCT', 8),
    givebackPct: envNum('MILD_DIP_EXIT_GIVEBACK_PCT', 6),
    /** 0 = disable never_arm_giveback (early −6% cuts were the grind loss). */
    neverArmPatienceMs: envNum('MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS', 0),
    neverArmMaxHoldMs: envNum('MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS', 2_400_000),
    /** Deep-loss cut before max-hold (rugs); not the early 5m knife. */
    neverArmDeadMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS', 900_000),
    neverArmDeadPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT', 15),
    /** Activity fade — leave when the tape dies, not on a clock. */
    neverArmVolFadeMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS', 600_000),
    neverArmVolFadeRatio: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO', 0.35),
    neverArmVolFadeFloorUsd: envNum('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD', 500),
  };

  const entryModeRaw = (process.env.MILD_DIP_ENTRY_MODE ?? 'mild_dip').trim().toLowerCase();
  const entryMode =
    entryModeRaw === 'awakening'
      ? 'awakening'
      : entryModeRaw === 'green_tape' || entryModeRaw === 'green-tape'
        ? 'green_tape'
        : 'mild_dip';

  const greenTape: GreenTapeGates = {
    minLiquidityUsd: envNum('MILD_DIP_GREEN_MIN_LIQUIDITY_USD', 12_000),
    minMarketCapUsd: envNum('MILD_DIP_GREEN_MIN_MCAP_USD', 40_000),
    maxMarketCapUsd: envNum('MILD_DIP_GREEN_MAX_MCAP_USD', 300_000_000),
    minPairAgeHours: envNum('MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS', 0.1),
    maxPairAgeHours: envNum('MILD_DIP_GREEN_MAX_PAIR_AGE_HOURS', 72),
    allowedDexIds,
    // Fat / calm green — require >5% (0–5% was the loss zone in closed set; 2% is not a real impulse).
    liquidMinPc5mPct: envNum('MILD_DIP_GREEN_LIQUID_MIN_PC5M_PCT', 5),
    liquidMaxPc5mPct: envNum('MILD_DIP_GREEN_LIQUID_MAX_PC5M_PCT', 20),
    liquidMinVolume5mUsd: envNum('MILD_DIP_GREEN_LIQUID_MIN_VOLUME_5M_USD', 2_000),
    liquidMinBuySellRatio5m: envNum('MILD_DIP_GREEN_LIQUID_MIN_BUY_SELL_5M', 1),
    liquidMinTurnover5m: envNum('MILD_DIP_GREEN_LIQUID_MIN_TURNOVER_5M', 0.09),
    // Early thin aggressive green (leader / Ef4E8v shape).
    earlyMinPc5mPct: envNum('MILD_DIP_GREEN_EARLY_MIN_PC5M_PCT', 5),
    earlyMaxPc5mPct: envNum('MILD_DIP_GREEN_EARLY_MAX_PC5M_PCT', 25),
    earlyMinVolume5mUsd: envNum('MILD_DIP_GREEN_EARLY_MIN_VOLUME_5M_USD', 400),
    earlyMinBuySellRatio5m: envNum('MILD_DIP_GREEN_EARLY_MIN_BUY_SELL_5M', 2),
    earlyMinTurnover5m: envNum('MILD_DIP_GREEN_EARLY_MIN_TURNOVER_5M', 0.02),
    earlyMinMarketCapUsd: envNum('MILD_DIP_GREEN_EARLY_MIN_MCAP_USD', 35_000),
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
    enrichBudgetMs: process.env.MILD_DIP_ENRICH_BUDGET_MS ?? 40_000,
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
