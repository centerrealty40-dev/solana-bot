import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import { assertCopyTraderIsolation } from './isolation.js';

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
  buyRetryWindowMs: z.coerce.number().int().min(0).max(86_400_000).default(7_200_000),
  buyRetryDeferLogMs: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  sellRetryWindowMs: z.coerce.number().int().min(0).max(86_400_000).default(7_200_000),
  sellRetryIntervalMs: z.coerce.number().int().min(1_000).max(600_000).default(6_000),
  sellRetryDeferLogMs: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),
  sellDelayMinMs: z.coerce.number().int().min(0).max(3_600_000).default(20_000),
  sellDelayMaxMs: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  /** Second on-chain zero read before leader-flat tail sweep (default 3s). */
  leaderFlatConfirmDelayMs: z.coerce.number().int().min(0).max(60_000).default(3_000),
  /** Leader wallet balance ≤ this raw amount counts as flat (post-exit dust). */
  leaderFlatDustRaw: z.coerce.bigint().min(0n).max(1_000_000_000_000n).default(10_000n),
  positionUsd: z.coerce.number().positive().max(100_000).default(600),
  addPositionUsd: z.coerce.number().positive().max(100_000).default(600),
  maxPositionUsd: z.coerce.number().min(0).max(500_000).default(0),
  maxAddsPerMint: z.coerce.number().int().min(0).max(999).default(0),
  minProportionalAddUsd: z.coerce.number().min(0).max(100_000).default(0),
  minProportionalSellFraction: z.coerce.number().min(0).max(1).default(0),
  buyPriceMaxPremiumPct: z.coerce.number().min(0).max(50).default(3),
  /** Fraction of positionUsd for immediate probe buy at leader+premium (default 300/1000). */
  entryProbeFraction: z.coerce.number().min(0).max(1).default(300 / 1000),
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
  minLeaderBuyUsd: z.coerce.number().min(0).max(1_000_000).default(50),
  minLiquidityUsd: z.coerce.number().min(0).max(1_000_000_000).default(15_000),
  minMarketCapUsd: z.coerce.number().min(0).max(1_000_000_000).default(1_000_000),
  maxMarketCapUsd: z.coerce.number().min(0).max(1_000_000_000_000).default(0),
  minPairAgeHours: z.coerce.number().min(0).max(8760).default(0),
  maxOpenPositions: z.coerce.number().int().min(0).max(100).default(0),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(400),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
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
    buyRetryWindowMs: process.env.COPY_TRADER_BUY_RETRY_WINDOW_MS,
    buyRetryDeferLogMs: process.env.COPY_TRADER_BUY_RETRY_DEFER_LOG_MS,
    sellRetryWindowMs: process.env.COPY_TRADER_SELL_RETRY_WINDOW_MS,
    sellRetryIntervalMs: process.env.COPY_TRADER_SELL_RETRY_INTERVAL_MS,
    sellRetryDeferLogMs: process.env.COPY_TRADER_SELL_RETRY_DEFER_LOG_MS,
    sellDelayMinMs,
    sellDelayMaxMs,
    leaderFlatConfirmDelayMs: process.env.COPY_TRADER_LEADER_FLAT_CONFIRM_DELAY_MS,
    leaderFlatDustRaw: process.env.COPY_TRADER_LEADER_FLAT_DUST_RAW,
    positionUsd: process.env.COPY_TRADER_POSITION_USD,
    addPositionUsd: process.env.COPY_TRADER_ADD_POSITION_USD,
    maxPositionUsd: process.env.COPY_TRADER_MAX_POSITION_USD,
    maxAddsPerMint: process.env.COPY_TRADER_MAX_ADDS_PER_MINT,
    minProportionalAddUsd: process.env.COPY_TRADER_MIN_PROPORTIONAL_ADD_USD,
    minProportionalSellFraction: process.env.COPY_TRADER_MIN_PROPORTIONAL_SELL_FRACTION,
    buyPriceMaxPremiumPct: process.env.COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT,
    entryProbeFraction: process.env.COPY_TRADER_ENTRY_PROBE_FRACTION,
    entryDipDiscountPct: process.env.COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT,
    entryDipConfirmTicks: process.env.COPY_TRADER_ENTRY_DIP_CONFIRM_TICKS,
    entryDipVsProbePct: process.env.COPY_TRADER_ENTRY_DIP_VS_PROBE_PCT,
    entryMinDeployFraction: process.env.COPY_TRADER_ENTRY_MIN_DEPLOY_FRACTION,
    addPriceMaxPremiumPct: process.env.COPY_TRADER_ADD_PRICE_MAX_PREMIUM_PCT,
    minLeaderBuyUsd: process.env.COPY_TRADER_MIN_LEADER_BUY_USD,
    minLiquidityUsd: process.env.COPY_TRADER_MIN_LIQUIDITY_USD,
    minMarketCapUsd: process.env.COPY_TRADER_MIN_MCAP_USD,
    maxMarketCapUsd: process.env.COPY_TRADER_MAX_MCAP_USD,
    minPairAgeHours: process.env.COPY_TRADER_MIN_PAIR_AGE_HOURS,
    maxOpenPositions: process.env.COPY_TRADER_MAX_OPEN_POSITIONS,
    slippageBps: process.env.COPY_TRADER_SLIPPAGE_BPS,
    walletSecret: process.env.COPY_TRADER_WALLET_SECRET?.trim(),
    walletPubkeyExpected: process.env.COPY_TRADER_WALLET_PUBKEY?.trim() || undefined,
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

  return parsed.data;
}

export function copyTraderTelegramEnabled(cfg: CopyTraderConfig): boolean {
  return envBool(process.env.COPY_TRADER_TELEGRAM_ENABLED, true) && Boolean(cfg.telegramBotToken && cfg.telegramChatId);
}
