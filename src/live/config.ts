import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const ExecutionModeSchema = z.enum(['dry_run', 'simulate', 'live']);
const ProfileSchema = z.enum(['oscar']);

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

function optionalPositiveEnv(name: string): number | undefined {
  const s = process.env[name]?.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function optionalPositiveIntEnv(name: string): number | undefined {
  const s = process.env[name]?.trim();
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

const LiveOscarConfigSchema = z
  .object({
    strategyEnabled: z.boolean(),
    executionMode: ExecutionModeSchema,
    profile: ProfileSchema,
    /** SSOT live journal — must never equal paper Oscar path when both are set. */
    liveTradesPath: z.string().min(1),
    strategyId: z.string().min(1).default('live-oscar'),
    heartbeatIntervalMs: z.coerce.number().int().min(5000).max(3600_000).default(60_000),
    /** Optional; if set alongside `liveTradesPath`, paths must differ (collision guard). */
    parityPaperTradesPath: z.string().optional(),
    /** Required when enabled + simulate|live; never loaded by Phase 0 runtime unless enabled. */
    walletSecret: z.string().optional(),

    /** W8.0 Phase 2 — Jupiter lite-api (defaults match public lite-api hosts). */
    liveJupiterQuoteUrl: z.string().min(1).optional(),
    liveJupiterSwapUrl: z.string().min(1).optional(),
    liveJupiterQuoteTimeoutMs: z.coerce.number().int().min(500).max(30_000).default(5000),
    liveJupiterSwapTimeoutMs: z.coerce.number().int().min(500).max(60_000).default(8000),
    liveDefaultSlippageBps: z.coerce.number().int().min(10).max(5000).default(400),

    /** W8.0 Phase 3 — sign + simulateTransaction (qnCall feature sim). */
    liveSimEnabled: z.boolean(),
    liveSimTimeoutMs: z.coerce.number().int().min(2000).max(60_000),
    liveSimCreditsPerCall: z.coerce.number().int().min(10).max(200),
    liveSimReplaceRecentBlockhash: z.boolean().default(true),
    liveSimSigVerify: z.boolean().default(false),

    /** W8.0 Phase 5 — §3.3 risk / §3.4 capital (optional limits: unset ⇒ check skipped). */
    liveMaxPositionUsd: z.coerce.number().positive().optional(),
    liveMaxOpenPositions: z.coerce.number().int().min(1).optional(),
    liveMaxStrategyLossUsd: z.coerce.number().positive().optional(),
    /** 0 = disabled (CHANGELOG). */
    liveKillAfterConsecFail: z.coerce.number().int().min(0).default(0),
    liveHaltCloseAllOnMaxLoss: z.boolean().default(false),
    /** Minimum native SOL (whole SOL, not lamports) to allow new exposure. */
    liveMinWalletSol: z.coerce.number().positive().optional(),
    liveEntryNotionalUsd: z.coerce.number().positive().optional(),
    liveEntryMinFreeMult: z.coerce.number().positive().default(2),
    liveCapitalRotateCascade: z.boolean().default(false),
    /** Rent + fee cushion subtracted from getBalance lamports before free_usd (v1 SOL-only). */
    liveFreeSolBufferLamports: z.coerce.number().int().min(0).default(10_000_000),
  })
  .superRefine((data, ctx) => {
    if (data.strategyEnabled && data.executionMode === 'live') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'LIVE_EXECUTION_MODE=live is not supported until Phase 6 (send/confirm). Use dry_run or simulate.',
        path: ['executionMode'],
      });
    }
    if (data.strategyEnabled && (data.executionMode === 'simulate' || data.executionMode === 'live')) {
      const w = data.walletSecret?.trim();
      if (!w) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'LIVE_WALLET_SECRET is required when LIVE_STRATEGY_ENABLED=1 and LIVE_EXECUTION_MODE is simulate or live',
          path: ['walletSecret'],
        });
      }
    }
  });

export type LiveExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type LiveOscarProfile = z.infer<typeof ProfileSchema>;
export type LiveOscarConfig = z.infer<typeof LiveOscarConfigSchema>;

function assertPathsDiffer(livePath: string, paperPath: string | undefined): void {
  if (!paperPath?.trim()) return;
  const a = path.resolve(livePath.trim());
  const b = path.resolve(paperPath.trim());
  if (a === b) {
    throw new Error(
      `LIVE_TRADES_PATH must differ from PAPER_TRADES_PATH / LIVE_PARITY_PAPER_TRADES_PATH (both resolved to ${a})`,
    );
  }
}

/**
 * W8.0 Phase 0 — load env for `live-oscar` process only (not used by papertrader).
 */
export function loadLiveOscarConfig(): LiveOscarConfig {
  const parityPaper =
    process.env.LIVE_PARITY_PAPER_TRADES_PATH?.trim() || process.env.PAPER_TRADES_PATH?.trim() || undefined;

  const parsed = LiveOscarConfigSchema.safeParse({
    strategyEnabled: envBool(process.env.LIVE_STRATEGY_ENABLED, false),
    executionMode: (process.env.LIVE_EXECUTION_MODE ?? 'dry_run').trim().toLowerCase(),
    profile: (process.env.LIVE_STRATEGY_PROFILE ?? 'oscar').trim().toLowerCase(),
    liveTradesPath: process.env.LIVE_TRADES_PATH,
    strategyId: process.env.LIVE_STRATEGY_ID,
    heartbeatIntervalMs: process.env.LIVE_HEARTBEAT_INTERVAL_MS,
    parityPaperTradesPath: parityPaper,
    walletSecret: process.env.LIVE_WALLET_SECRET,
    liveJupiterQuoteUrl: process.env.LIVE_JUPITER_QUOTE_URL?.trim() || undefined,
    liveJupiterSwapUrl: process.env.LIVE_JUPITER_SWAP_URL?.trim() || undefined,
    liveJupiterQuoteTimeoutMs: process.env.LIVE_JUPITER_QUOTE_TIMEOUT_MS,
    liveJupiterSwapTimeoutMs: process.env.LIVE_JUPITER_SWAP_TIMEOUT_MS,
    liveDefaultSlippageBps: process.env.LIVE_DEFAULT_SLIPPAGE_BPS,

    liveSimEnabled: envBool(process.env.LIVE_SIM_ENABLED, true),
    liveSimTimeoutMs: (() => {
      const s = process.env.LIVE_SIM_TIMEOUT_MS?.trim();
      if (!s) return 12_000;
      const n = Number(s);
      return Number.isFinite(n) ? n : 12_000;
    })(),
    liveSimCreditsPerCall: (() => {
      const s = process.env.LIVE_SIM_CREDITS_PER_CALL?.trim();
      if (!s) return 30;
      const n = Number(s);
      return Number.isFinite(n) ? n : 30;
    })(),
    liveSimReplaceRecentBlockhash: envBool(process.env.LIVE_SIM_REPLACE_RECENT_BLOCKHASH, true),
    liveSimSigVerify: envBool(process.env.LIVE_SIM_SIG_VERIFY, false),

    liveMaxPositionUsd: optionalPositiveEnv('LIVE_MAX_POSITION_USD'),
    liveMaxOpenPositions: optionalPositiveIntEnv('LIVE_MAX_OPEN_POSITIONS'),
    liveMaxStrategyLossUsd: optionalPositiveEnv('LIVE_MAX_STRATEGY_LOSS_USD'),
    liveKillAfterConsecFail: process.env.LIVE_KILL_AFTER_CONSEC_FAIL,
    liveHaltCloseAllOnMaxLoss: envBool(process.env.LIVE_HALT_CLOSE_ALL_ON_MAX_LOSS, false),
    liveMinWalletSol: optionalPositiveEnv('LIVE_MIN_WALLET_SOL'),
    liveEntryNotionalUsd: optionalPositiveEnv('LIVE_ENTRY_NOTIONAL_USD'),
    liveEntryMinFreeMult: process.env.LIVE_ENTRY_MIN_FREE_MULT,
    liveCapitalRotateCascade: envBool(process.env.LIVE_CAPITAL_ROTATE_CASCADE, false),
    liveFreeSolBufferLamports: process.env.LIVE_FREE_SOL_BUFFER_LAMPORTS,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid live-oscar env:\n${issues}`);
  }

  const cfg = parsed.data;
  assertPathsDiffer(cfg.liveTradesPath, cfg.parityPaperTradesPath);

  return cfg;
}
