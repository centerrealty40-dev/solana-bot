import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  heliusApiKey: z.string().optional().default(''),
  heliusRpcUrl: z.string().optional().default(''),
  heliusWebhookUrl: z.string().optional().default(''),
  heliusWebhookAuth: z.string().optional().default(''),
  /**
   * Master kill-switch for ALL Helius API access.
   *   - 'off'      : do not touch Helius at all (default after 2026-04 incident)
   *   - 'wallets'  : only register webhook on a watchlist of specific wallets,
   *                  history backfill allowed within budget
   *   - 'unsafe'   : allow program-level subscriptions; only use if you know
   *                  exactly what you are doing and have a paid plan
   */
  heliusMode: z.enum(['off', 'wallets', 'unsafe']).default('off'),
  /** Hard daily ceiling on Helius credits (estimated). Guard short-circuits beyond. */
  heliusDailyBudget: z.coerce.number().int().positive().default(30_000),
  /** Hard monthly ceiling on Helius credits (estimated). */
  heliusMonthlyBudget: z.coerce.number().int().positive().default(800_000),
  /**
   * Maximum number of wallet addresses we will ever pass to a Helius webhook.
   * Set well below the practical "OK we know what we are doing" threshold.
   */
  heliusMaxWatchlistSize: z.coerce.number().int().positive().default(500),
  birdeyeApiKey: z.string().optional().default(''),
  apiHost: z.string().default('0.0.0.0'),
  apiPort: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  walletKeypairPath: z.string().optional().default(''),
  maxPositionUsd: z.coerce.number().positive().default(50),
  /** Higher cap for high-conviction meta-hypotheses (H7 confluence gate). */
  maxPositionUsdHighConviction: z.coerce.number().positive().default(150),
  dailyLossLimitPct: z.coerce.number().positive().default(5),
  telegramBotToken: z.string().optional().default(''),
  telegramChatId: z.string().optional().default(''),
  executorMode: z.enum(['paper', 'live']).default('paper'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse({
    databaseUrl: process.env.SA_PG_DSN || process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    heliusApiKey: process.env.HELIUS_API_KEY,
    heliusRpcUrl: process.env.HELIUS_RPC_URL,
    heliusWebhookUrl: process.env.HELIUS_WEBHOOK_URL,
    heliusWebhookAuth: process.env.HELIUS_WEBHOOK_AUTH,
    heliusMode: process.env.HELIUS_MODE,
    heliusDailyBudget: process.env.HELIUS_DAILY_BUDGET,
    heliusMonthlyBudget: process.env.HELIUS_MONTHLY_BUDGET,
    heliusMaxWatchlistSize: process.env.HELIUS_MAX_WATCHLIST_SIZE,
    birdeyeApiKey: process.env.BIRDEYE_API_KEY,
    apiHost: process.env.API_HOST,
    apiPort: process.env.API_PORT,
    logLevel: process.env.LOG_LEVEL,
    walletKeypairPath: process.env.WALLET_KEYPAIR_PATH,
    maxPositionUsd: process.env.MAX_POSITION_USD,
    maxPositionUsdHighConviction: process.env.MAX_POSITION_USD_HIGH_CONVICTION,
    dailyLossLimitPct: process.env.DAILY_LOSS_LIMIT_PCT,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    executorMode: process.env.EXECUTOR_MODE,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

export const config: AppConfig = loadConfig();
