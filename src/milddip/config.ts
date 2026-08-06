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

const MildDipConfigSchema = z.object({
  executionMode: ExecutionModeSchema,
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
  /** Parallel Jupiter sells — sole consumer can push higher. */
  sellConcurrency: z.coerce.number().int().min(1).max(8).default(6),
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
    /** Armed: sell scaleOutFraction at this giveback % (0=off). */
    partialGivebackPct: z.coerce.number().min(0).max(100).default(3),
    /** Fraction sold on partial giveback (default 0.5). */
    scaleOutFraction: z.coerce.number().min(0).max(1).default(0.5),
    /** W9.1: full exit when giveback from peak ≤ −givebackPct. */
    givebackPct: z.number(),
    /** Never-armed soft giveback after this many ms (0=off). Default off. */
    neverArmPatienceMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
    /** Never-armed: force exit after this many ms (0=off). Hard ceiling. */
    neverArmMaxHoldMs: z.coerce.number().int().min(0).max(86_400_000).default(2_400_000),
    /** Never-armed deep-loss cut min hold (0=off). Default 15m. */
    neverArmDeadMinMs: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
    /** Never-armed deep-loss cut: exit if pnl ≤ −this % (0=off). Default 15. */
    neverArmDeadPnlPct: z.coerce.number().min(0).max(100).default(15),
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
    /** 1.11.702 — wider knife floor (default −25 ⇒ pc5m > −25%). */
    minDipPct: envNum('MILD_DIP_MIN_DIP_PCT', -25),
    /** Inclusive upper bound — require dump depth (default −5 ⇒ pc5m ≤ −5%). */
    maxDipPct: envNum('MILD_DIP_MAX_DIP_PCT', -5),
    /** 1.11.701 — default $500 (was $1500). */
    minVolume5mUsd: envNum('MILD_DIP_MIN_VOLUME_5M_USD', 500),
    /** 1.11.700 — default $10k (canary $40k was too tight for mild dips). */
    minLiquidityUsd: envNum('MILD_DIP_MIN_LIQUIDITY_USD', 10_000),
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
    /** 1.11.699 — arm earlier so NV2RYH-style +5.5% MFE is not invisible. */
    armPct: envNum('MILD_DIP_EXIT_ARM_PCT', 5),
    /** Scale-out half at −3% from peak; full remainder at givebackPct. */
    partialGivebackPct: envNum('MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT', 3),
    scaleOutFraction: envNum('MILD_DIP_EXIT_SCALE_OUT_FRACTION', 0.5),
    givebackPct: envNum('MILD_DIP_EXIT_GIVEBACK_PCT', 8),
    /** 0 = disable never_arm_giveback (early −6% cuts were the grind loss). */
    neverArmPatienceMs: envNum('MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS', 0),
    neverArmMaxHoldMs: envNum('MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS', 2_400_000),
    /** Deep-loss cut before max-hold (rugs); not the early 5m knife. */
    neverArmDeadMinMs: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS', 900_000),
    neverArmDeadPnlPct: envNum('MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT', 15),
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
  };

  const raw = {
    executionMode: (process.env.MILD_DIP_EXECUTION_MODE?.trim() || 'live') as string,
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

  return parsed.data;
}
