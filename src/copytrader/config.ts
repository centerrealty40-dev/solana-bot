import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import { assertCopyTraderIsolation } from './isolation.js';
import { parseCopyTraderExitMode, type CopyTraderExitMode } from './exit-mode.js';
import { parseCopyQuoteAsset } from './quote-mint.js';

const ExecutionModeSchema = z.enum(['paper', 'dry_run', 'live']);

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

const CopyTraderConfigSchema = z.object({
  targetWallet: z.string().min(32).max(64),
  rpcUrl: z.string().min(8),
  executionMode: ExecutionModeSchema,
  journalPath: z.string().min(1),
  statePath: z.string().min(1),
  pollIntervalMs: z.coerce.number().int().min(2000).max(120_000).default(12_000),
  signatureLimit: z.coerce.number().int().min(5).max(50).default(25),
  tickIntervalMs: z.coerce.number().int().min(500).max(30_000).default(2000),
  buyDelayMs: z.coerce.number().int().min(0).max(86_400_000).default(30_000),
  /** Probe / full entry: ms after leader buy before first attempt (default 0 = immediate). */
  entryProbeBuyDelayMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
  buyRetryWindowMs: z.coerce.number().int().min(0).max(86_400_000).default(7_200_000),
  buyRetryDeferLogMs: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  /** Spacing after a failed buy execution. 0 keeps the every-tick retry. */
  buyRetryIntervalMs: z.coerce.number().int().min(0).max(600_000).default(0),
  sellRetryWindowMs: z.coerce.number().int().min(0).max(86_400_000).default(7_200_000),
  sellRetryIntervalMs: z.coerce.number().int().min(1_000).max(600_000).default(6_000),
  sellRetryDeferLogMs: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),
  /** Min ms between sell executions on the same mint (Jupiter 429 mitigation). **0** = off. */
  minSellIntervalMs: z.coerce.number().int().min(0).max(600_000).default(0),
  /** Min ms between Jupiter dip eval quotes per pending buy (eval-only cache). **0** = off. */
  entryDipJupiterMinIntervalMs: z.coerce.number().int().min(0).max(600_000).default(0),
  /** `0` — dip gate uses DEX/PG price; Jupiter only on actual buy/sell swap. */
  entryDipUseJupiter: z.boolean().default(true),
  sellDelayMinMs: z.coerce.number().int().min(0).max(3_600_000).default(20_000),
  sellDelayMaxMs: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  /** Second on-chain zero read before leader-flat tail sweep (default 3s). */
  leaderFlatConfirmDelayMs: z.coerce.number().int().min(0).max(60_000).default(3_000),
  /** Leader wallet balance ≤ this raw amount counts as flat (post-exit dust). */
  leaderFlatDustRaw: z.coerce.bigint().min(0n).max(1_000_000_000_000n).default(10_000n),
  positionUsd: z.coerce.number().positive().max(100_000).default(600),
  /** Initial entry: mirror this fraction of leader buy USD (0 = fixed positionUsd). */
  initialMirrorRatio: z.coerce.number().min(0).max(1).default(0),
  addPositionUsd: z.coerce.number().positive().max(100_000).default(600),
  maxPositionUsd: z.coerce.number().min(0).max(500_000).default(0),
  maxAddsPerMint: z.coerce.number().int().min(0).max(999).default(0),
  minProportionalAddUsd: z.coerce.number().min(0).max(100_000).default(0),
  minProportionalSellFraction: z.coerce.number().min(0).max(1).default(0),
  buyPriceMaxPremiumPct: z.coerce.number().min(0).max(50).default(3),
  /** Mcap ≥ this → full `positionUsd` split (default $1M). Below → `entryMidPositionUsd` ($300+$300). */
  entryFullMcapUsd: z.coerce.number().min(0).max(1_000_000_000).default(1_000_000),
  /** Total staged entry when mcap ∈ [minMarketCapUsd, entryFullMcapUsd) (default $600). */
  entryMidPositionUsd: z.coerce.number().positive().max(100_000).default(600),
  /** Each probe/dip leg for mid mcap tier (default $300). */
  entryMidLegUsd: z.coerce.number().positive().max(100_000).default(300),
  /** Fraction of positionUsd for immediate probe buy at leader+premium (default 500/1000). */
  entryProbeFraction: z.coerce.number().min(0).max(1).default(500 / 1000),
  /** Remainder fills when price ≤ leader × (1 − discount/100) (default 10%). */
  entryDipDiscountPct: z.coerce.number().min(0).max(50).default(10),
  /** Dip leg: consecutive eval passes (Jupiter quote in live) before buy (default 2). */
  entryDipConfirmTicks: z.coerce.number().int().min(1).max(10).default(2),
  /** After probe fill: dip must be at least this % below our probe entry price (default 2). */
  entryDipVsProbePct: z.coerce.number().min(0).max(50).default(2),
  /** Proportional adds blocked until deployed ≥ positionUsd × this fraction (default 99%). */
  entryMinDeployFraction: z.coerce.number().min(0.5).max(1).default(0.99),
  /** Leader add mirror: max premium vs leader add price (0 = at or below leader only). */
  addPriceMaxPremiumPct: z.coerce.number().min(0).max(50).default(0),
  /** Enter when leader rebuys/averages into a mint we missed on first buy (default on). */
  allowLateEntryOnLeaderRebuy: z.boolean().default(true),
  minLeaderBuyUsd: z.coerce.number().min(0).max(1_000_000).default(50),
  minLiquidityUsd: z.coerce.number().min(0).max(1_000_000_000).default(15_000),
  minMarketCapUsd: z.coerce.number().min(0).max(1_000_000_000).default(500_000),
  maxMarketCapUsd: z.coerce.number().min(0).max(1_000_000_000_000).default(0),
  minPairAgeHours: z.coerce.number().min(0).max(8760).default(0),
  /** Selective copy gates from the leader audit (see entry-gates.ts). Off by default. */
  leaderGatesEnabled: z.boolean().default(false),
  /** Require this many closed leader round trips on the mint before copying. */
  minLeaderPriorSessions: z.coerce.number().int().min(0).max(1000).default(3),
  /** Leader's average return across those sessions must beat this, percent. */
  minLeaderPriorAvgPct: z.coerce.number().min(-100).max(1000).default(5),
  /** Pair must be at least this old — brand-new pairs are unreadable at our lag. */
  entryMinPairAgeHours: z.coerce.number().min(0).max(8760).default(1),
  /** …and no older than this; the leader's edge decays past ~3 days. **0** = no cap. */
  entryMaxPairAgeHours: z.coerce.number().min(0).max(8760).default(72),
  /** Minimum DexScreener 5m buys/sells ratio. **0** = off. */
  entryMinBuySellRatio5m: z.coerce.number().min(0).max(100).default(1.05),
  /** Skip entries after a 5m spike larger than this, percent. **0** = off. */
  entryMaxChase5mPct: z.coerce.number().min(0).max(1000).default(15),
  /** Forget leader mint history untouched for this long. */
  leaderHistoryTtlMs: z.coerce.number().int().min(3_600_000).max(31_536_000_000).default(2_592_000_000),
  /** trail_runner: arm the peak trail once the position is this far up, percent. */
  trailArmPct: z.coerce.number().min(0).max(1000).default(8),
  /** trail_runner: exit after giving back this much of the peak, percent. */
  trailGivebackPct: z.coerce.number().min(0).max(100).default(6),
  /** trail_runner: hard exit after this long in the position. **0** = off. */
  trailTimeCapMs: z.coerce.number().int().min(0).max(86_400_000).default(2_700_000),
  /** trail_runner: how often open positions are marked. */
  trailTickIntervalMs: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
  maxOpenPositions: z.coerce.number().int().min(0).max(100).default(0),
  /** Funding asset for swaps. `USDC` decouples sizing from the SOL price (see quote-mint.ts). */
  quoteAsset: z.enum(['SOL', 'USDC']).default('SOL'),
  /** USDC funding: keep this much SOL for fees/rent; below it, buys are skipped. */
  minFeeSolReserve: z.coerce.number().min(0).max(10).default(0.02),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(100),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
  /** Share live-oscar-micro wallet; track copy tokenRaw separately from oscar legs. */
  sharedOscarWallet: z.boolean().default(false),
  /**
   * Exit policy: `oscar_half8` — live-oscar wave_b half8_runner (+8% half, kill −50%);
   * `mirror` — proportional leader sell mirror (legacy);
   * `trail_runner` — self-managed peak trail + time cap, leader sell as backstop.
   */
  exitMode: z.enum(['oscar_half8', 'mirror', 'trail_runner']).default('oscar_half8'),
  /** Block copy buys when free SOL would starve live-oscar reserve + open committed. */
  spareCapitalGateEnabled: z.boolean().default(false),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
});

export type CopyTraderConfig = z.infer<typeof CopyTraderConfigSchema>;

function readTargetWalletFromFile(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      return t.split(/\s+/)[0] ?? '';
    }
  } catch {
    // missing file
  }
  return '';
}

export function loadCopyTraderConfig(): CopyTraderConfig {
  let targetWallet = process.env.COPY_TRADER_TARGET_WALLET?.trim() ?? '';
  if (!targetWallet) {
    const targetPath =
      process.env.COPY_TRADER_TARGET_WALLET_PATH?.trim() ||
      path.join('data', 'copytrader', 'target-wallet.txt');
    targetWallet = readTargetWalletFromFile(targetPath);
  }
  const rpcUrl =
    process.env.COPY_TRADER_RPC_URL?.trim() ||
    liveOscarRpcHttpUrlFromEnv() ||
    resolveSolanaRpcUrl() ||
    '';

  const sellMin = Number(process.env.COPY_TRADER_SELL_DELAY_MIN_MS ?? 20_000);
  const sellMax = Number(process.env.COPY_TRADER_SELL_DELAY_MAX_MS ?? 30_000);
  const sellDelayMinMs = Number.isFinite(sellMin) ? Math.max(0, Math.floor(sellMin)) : 20_000;
  const sellDelayMaxMs = Number.isFinite(sellMax)
    ? Math.max(sellDelayMinMs, Math.floor(sellMax))
    : Math.max(sellDelayMinMs, 30_000);

  const raw = {
    targetWallet,
    rpcUrl,
    executionMode: process.env.COPY_TRADER_EXECUTION_MODE?.trim() || 'paper',
    journalPath:
      process.env.COPY_TRADER_JOURNAL_PATH?.trim() ||
      path.join('data', 'copytrader', 'journal.jsonl'),
    statePath:
      process.env.COPY_TRADER_STATE_PATH?.trim() ||
      path.join('data', 'copytrader', 'state.json'),
    pollIntervalMs: process.env.COPY_TRADER_POLL_INTERVAL_MS,
    signatureLimit: process.env.COPY_TRADER_SIGNATURE_LIMIT,
    tickIntervalMs: process.env.COPY_TRADER_TICK_INTERVAL_MS,
    buyDelayMs: process.env.COPY_TRADER_BUY_DELAY_MS,
    entryProbeBuyDelayMs: process.env.COPY_TRADER_ENTRY_PROBE_BUY_DELAY_MS,
    buyRetryWindowMs: process.env.COPY_TRADER_BUY_RETRY_WINDOW_MS,
    buyRetryDeferLogMs: process.env.COPY_TRADER_BUY_RETRY_DEFER_LOG_MS,
    buyRetryIntervalMs: process.env.COPY_TRADER_BUY_RETRY_INTERVAL_MS,
    sellRetryWindowMs: process.env.COPY_TRADER_SELL_RETRY_WINDOW_MS,
    sellRetryIntervalMs: process.env.COPY_TRADER_SELL_RETRY_INTERVAL_MS,
    sellRetryDeferLogMs: process.env.COPY_TRADER_SELL_RETRY_DEFER_LOG_MS,
    minSellIntervalMs: process.env.COPY_TRADER_MIN_SELL_INTERVAL_MS,
    entryDipJupiterMinIntervalMs: process.env.COPY_TRADER_ENTRY_DIP_JUPITER_MIN_INTERVAL_MS,
    entryDipUseJupiter: process.env.COPY_TRADER_ENTRY_DIP_USE_JUPITER !== '0',
    sellDelayMinMs,
    sellDelayMaxMs,
    leaderFlatConfirmDelayMs: process.env.COPY_TRADER_LEADER_FLAT_CONFIRM_DELAY_MS,
    leaderFlatDustRaw: process.env.COPY_TRADER_LEADER_FLAT_DUST_RAW,
    positionUsd: process.env.COPY_TRADER_POSITION_USD,
    initialMirrorRatio: process.env.COPY_TRADER_INITIAL_MIRROR_RATIO,
    addPositionUsd: process.env.COPY_TRADER_ADD_POSITION_USD,
    maxPositionUsd: process.env.COPY_TRADER_MAX_POSITION_USD,
    maxAddsPerMint: process.env.COPY_TRADER_MAX_ADDS_PER_MINT,
    minProportionalAddUsd: process.env.COPY_TRADER_MIN_PROPORTIONAL_ADD_USD,
    minProportionalSellFraction: process.env.COPY_TRADER_MIN_PROPORTIONAL_SELL_FRACTION,
    buyPriceMaxPremiumPct: process.env.COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT,
    entryFullMcapUsd: process.env.COPY_TRADER_ENTRY_FULL_MCAP_USD,
    entryMidPositionUsd: process.env.COPY_TRADER_ENTRY_MID_POSITION_USD,
    entryMidLegUsd: process.env.COPY_TRADER_ENTRY_MID_LEG_USD,
    entryProbeFraction: process.env.COPY_TRADER_ENTRY_PROBE_FRACTION,
    entryDipDiscountPct: process.env.COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT,
    entryDipConfirmTicks: process.env.COPY_TRADER_ENTRY_DIP_CONFIRM_TICKS,
    entryDipVsProbePct: process.env.COPY_TRADER_ENTRY_DIP_VS_PROBE_PCT,
    entryMinDeployFraction: process.env.COPY_TRADER_ENTRY_MIN_DEPLOY_FRACTION,
    addPriceMaxPremiumPct: process.env.COPY_TRADER_ADD_PRICE_MAX_PREMIUM_PCT,
    allowLateEntryOnLeaderRebuy: envBool(
      process.env.COPY_TRADER_ALLOW_LATE_ENTRY_ON_LEADER_REBUY,
      true,
    ),
    minLeaderBuyUsd: process.env.COPY_TRADER_MIN_LEADER_BUY_USD,
    minLiquidityUsd: process.env.COPY_TRADER_MIN_LIQUIDITY_USD,
    minMarketCapUsd: process.env.COPY_TRADER_MIN_MCAP_USD,
    maxMarketCapUsd: process.env.COPY_TRADER_MAX_MCAP_USD,
    minPairAgeHours: process.env.COPY_TRADER_MIN_PAIR_AGE_HOURS,
    leaderGatesEnabled: envBool(process.env.COPY_TRADER_LEADER_GATES, false),
    minLeaderPriorSessions: process.env.COPY_TRADER_MIN_LEADER_PRIOR_SESSIONS,
    minLeaderPriorAvgPct: process.env.COPY_TRADER_MIN_LEADER_PRIOR_AVG_PCT,
    entryMinPairAgeHours: process.env.COPY_TRADER_ENTRY_MIN_PAIR_AGE_HOURS,
    entryMaxPairAgeHours: process.env.COPY_TRADER_ENTRY_MAX_PAIR_AGE_HOURS,
    entryMinBuySellRatio5m: process.env.COPY_TRADER_ENTRY_MIN_BUY_SELL_5M,
    entryMaxChase5mPct: process.env.COPY_TRADER_ENTRY_MAX_CHASE_5M_PCT,
    leaderHistoryTtlMs: process.env.COPY_TRADER_LEADER_HISTORY_TTL_MS,
    trailArmPct: process.env.COPY_TRADER_TRAIL_ARM_PCT,
    trailGivebackPct: process.env.COPY_TRADER_TRAIL_GIVEBACK_PCT,
    trailTimeCapMs: process.env.COPY_TRADER_TRAIL_TIME_CAP_MS,
    trailTickIntervalMs: process.env.COPY_TRADER_TRAIL_TICK_INTERVAL_MS,
    maxOpenPositions: process.env.COPY_TRADER_MAX_OPEN_POSITIONS,
    quoteAsset: parseCopyQuoteAsset(process.env.COPY_TRADER_QUOTE_MINT).asset,
    minFeeSolReserve: process.env.COPY_TRADER_MIN_FEE_SOL_RESERVE,
    slippageBps: process.env.COPY_TRADER_SLIPPAGE_BPS,
    walletSecret: process.env.COPY_TRADER_WALLET_SECRET?.trim(),
    walletPubkeyExpected: process.env.COPY_TRADER_WALLET_PUBKEY?.trim() || undefined,
    sharedOscarWallet: envBool(process.env.COPY_TRADER_SHARED_OSCAR_WALLET, false),
    exitMode: parseCopyTraderExitMode(process.env.COPY_TRADER_EXIT_MODE),
    spareCapitalGateEnabled: envBool(process.env.COPY_TRADER_SPARE_CAPITAL_GATE, false),
    telegramBotToken:
      process.env.COPY_TRADER_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim(),
    telegramChatId:
      process.env.COPY_TRADER_TELEGRAM_CHAT_ID?.trim() || process.env.TELEGRAM_CHAT_ID?.trim(),
  };

  const parsed = CopyTraderConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`copy-trader config invalid: ${msg}`);
  }

  if (parsed.data.executionMode === 'live' && !parsed.data.walletSecret) {
    throw new Error('copy-trader live mode requires COPY_TRADER_WALLET_SECRET (never LIVE_WALLET_SECRET)');
  }

  if (!parsed.data.targetWallet) {
    throw new Error(
      'copy-trader requires COPY_TRADER_TARGET_WALLET or data/copytrader/target-wallet.txt (leader wallet to copy)',
    );
  }

  if (envBool(process.env.COPY_TRADER_STRICT_ISOLATION, true)) {
    assertCopyTraderIsolation(parsed.data);
  }

  if (parsed.data.exitMode === 'oscar_half8' && !parsed.data.sharedOscarWallet) {
    console.warn(
      '[copy-trader] COPY_TRADER_EXIT_MODE=oscar_half8 requires COPY_TRADER_SHARED_OSCAR_WALLET=1 — falling back to mirror exits',
    );
    (parsed.data as { exitMode: CopyTraderExitMode }).exitMode = 'mirror';
  }

  return parsed.data;
}

export function copyTraderTelegramEnabled(cfg: CopyTraderConfig): boolean {
  return envBool(process.env.COPY_TRADER_TELEGRAM_ENABLED, true) && Boolean(cfg.telegramBotToken && cfg.telegramChatId);
}
