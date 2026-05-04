import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const ExecutionModeSchema = z.enum(['dry_run', 'simulate', 'live']);
const ProfileSchema = z.enum(['oscar']);
const LiveConfirmCommitmentSchema = z.enum(['processed', 'confirmed', 'finalized']);
export type LiveConfirmCommitmentLevel = z.infer<typeof LiveConfirmCommitmentSchema>;

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

function parseLiveConfirmCommitment(raw: string | undefined): 'processed' | 'confirmed' | 'finalized' | undefined {
  const s = raw?.trim().toLowerCase();
  if (s === 'processed' || s === 'confirmed' || s === 'finalized') return s;
  return undefined;
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
    /**
     * Optional: expected base58 pubkey for the key loaded from `walletSecret`.
     * When set, live-oscar verifies at boot so the wrong keypair file cannot sign swaps.
     */
    liveWalletPubkeyExpected: z.string().min(32).max(64).optional(),

    /** W8.0 Phase 2 — Jupiter lite-api (defaults match public lite-api hosts). */
    liveJupiterQuoteUrl: z.string().min(1).optional(),
    liveJupiterSwapUrl: z.string().min(1).optional(),
    liveJupiterQuoteTimeoutMs: z.coerce.number().int().min(500).max(30_000).default(5000),
    liveJupiterSwapTimeoutMs: z.coerce.number().int().min(500).max(60_000).default(8000),
    liveDefaultSlippageBps: z.coerce.number().int().min(10).max(5000).default(400),
    /**
     * Optional: max prioritization lamports passed to Jupiter `/swap/v1/swap` as `priorityLevelWithMaxLamports.maxLamports`.
     * Unset ⇒ omit field (Jupiter default). Example: **0.0001 SOL** = `100_000` lamports via **`LIVE_JUPITER_PRIORITY_MAX_SOL`**.
     */
    liveJupiterPriorityMaxLamports: z.number().int().min(1).max(50_000_000).optional(),
    /** Hint level paired with `liveJupiterPriorityMaxLamports` (Jupiter API spelling). */
    liveJupiterSwapPriorityLevel: z.enum(['medium', 'high', 'veryHigh']).default('medium'),
    /**
     * Phase 4 blocks swap if `quoteSnapshot.quoteAgeMs` exceeds this (ms).
     * Default **8000** when env unset (loader); **`LIVE_QUOTE_MAX_AGE_MS=0`** disables the gate.
     */
    liveQuoteMaxAgeMs: z.number().int().min(1).max(600_000).optional(),

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
    /**
     * **Live-only**, **buy_open only** (новый mint): require `native_SOL × SOL/USD ≥ this` before swap.
     * DCA adds use `isNewPosition: false` and skip this gate. Optional; complements `liveMinWalletSol` when both set (both must pass).
     */
    liveMinWalletSolEquityUsd: z.coerce.number().positive().optional(),

    /** Live-only: block **new** buys when Binance BTC context is fresh and drawdown exceeds thresholds below. */
    liveBtcGateEnabled: z.boolean().default(true),
    /** Skip BTC gate if `getBtcContext().updated_ts` older than this (ms). */
    liveBtcGateMaxStaleMs: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
    /** Block when `ret1h_pct ≤ −this` (percent points). ~2–3% catches sharp hourly dumps without noise. */
    liveBtcBlockNewBuys1hDrawdownPct: z.coerce.number().min(0).max(50).default(2.5),
    /** Block when `ret4h_pct ≤ −this` (percent points). ~5% aligns with risk-off sessions. */
    liveBtcBlockNewBuys4hDrawdownPct: z.coerce.number().min(0).max(50).default(5),
    liveEntryNotionalUsd: z.coerce.number().positive().optional(),
    liveEntryMinFreeMult: z.coerce.number().positive().default(2),
    liveCapitalRotateCascade: z.boolean().default(false),
    /** Rent + fee cushion subtracted from getBalance lamports before free_usd (v1 SOL-only). */
    liveFreeSolBufferLamports: z.coerce.number().int().min(0).default(10_000_000),

    /** W8.0 Phase 6 — send + confirm (live). */
    liveConfirmCommitment: LiveConfirmCommitmentSchema.default('confirmed'),
    liveConfirmTimeoutMs: z.coerce.number().int().min(3000).max(600_000).default(60_000),
    liveSendSkipPreflight: z.boolean().default(false),
    liveSimBeforeSend: z.boolean().default(true),
    liveSendMaxRetries: z.coerce.number().int().min(0).max(10).default(2),
    liveSendRetryBaseMs: z.coerce.number().int().min(100).max(30_000).default(500),
    liveSendCreditsPerCall: z.coerce.number().int().min(10).max(200).default(30),
    liveSendRpcTimeoutMs: z.coerce.number().int().min(3000).max(120_000).default(25_000),
    /** When set, send + confirm use this URL instead of SA_RPC_HTTP_URL (simulate may still use SA_RPC_HTTP_URL). */
    liveRpcHttpUrl: z.string().min(1).optional(),

    /** W8.0 Phase 7 — replay `live_position_*` from LIVE_TRADES_PATH before Oscar loop. */
    liveReplayOnBoot: z.boolean(),
    liveReplayTailLines: z.coerce.number().int().min(1).optional(),
    liveReplaySinceTs: z.coerce.number().finite().optional(),
    /** Beyond this size (bytes) only the trailing chunk of `LIVE_TRADES_PATH` is scanned for replay. */
    liveReplayMaxFileBytes: z.coerce.number().int().min(65_536).max(512 * 1024 * 1024).default(26_214_400),
    /** 0 = off. Sample-verify last N confirmed `execution_result` rows via getTransaction (Phase 7 tail). */
    liveReconcileTxSampleN: z.coerce.number().int().min(0).max(50).default(0),

    /** W8.0-p7.1 — replay keeps legacy rows without `entryLegSignatures` when true (dangerous). */
    liveReplayTrustGhostPositions: z.boolean().default(false),
    /** W8.0-p7.1 — enforce `PAPER_POSITION_USD` vs live entry/max limits at boot (live mode). */
    liveStrictNotionalParity: z.boolean().default(true),
    /** W8.0-p7.1 — after replay, verify each `entryLegSignatures` tx via RPC (live mode). */
    liveAnchorVerifyOnBoot: z.boolean().default(true),
    /**
     * 0 = off. When notional parity arms exposure block for longer than this (ms), clear it and emit `risk_note`
     * `exposure_block_ttl_cleared` (emergency; ops must fix root cause).
     */
    liveReconcileBlockMaxMs: z.coerce.number().int().min(0).max(86_400_000).default(0),

    /** 0 = off. Else interval (ms) for periodic tail sweep + stuck-open force exit (live only). */
    livePeriodicSelfHealMs: z.coerce.number().int().min(0).max(86_400_000).default(1_800_000),
    /** Skip chain-only tail sweep below this estimated USD (spam / dust). */
    livePeriodicSweepMinUsd: z.coerce.number().min(0).max(1_000_000).default(0.25),
    /**
     * When false (default), tail sweep only runs for mints that appear in this process's `closed[]` history.
     * When true, any non-open SPL balance above min USD is sold (airdrops / unknown tokens — higher risk).
     */
    livePeriodicSweepUnknownChainOnly: z.boolean().default(false),
    /** Hours beyond `timeoutHours` before forcing PERIODIC_HEAL on an open with on-chain balance. */
    livePeriodicStuckGraceHours: z.coerce.number().min(0).max(168).default(0.5),

    /**
     * 0 = off. In **live** `buy_open` only: skip swap if wallet already holds this mint worth ≥ this USD
     * (chain balance × snapshot/Jupiter price). Does not replace full reconcile; avoids duplicate buys when journal lags.
     */
    liveSkipBuyOpenIfWalletMintMinUsd: z.coerce.number().min(0).max(1_000_000).default(0),

    /**
     * 0 = off. After **`live_position_close`** in **live**, wait this many ms then if SPL balance for that mint
     * remains on the wallet, run **`sell_full`** (chain-sized) to clear dust tails.
     */
    livePostCloseTailSweepDelayMs: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
    /** Floor USD notional hint for Jupiter when estimating microscopic tails (actual sell uses on-chain raw). */
    livePostCloseTailSweepMinUsd: z.coerce.number().min(0).max(1000).default(0.05),

    /**
     * Двухногий вход: после первого `buy_open` трекер докупает `(1 − PAPER_ENTRY_FIRST_LEG_FRACTION)×positionUsd`,
     * если Jupiter implied цена в коридоре к якорю первой ноги: до +`liveEntryScaleInCorridorUpPct` % и до −`liveEntryScaleInCorridorDownPct` %.
     * Если заданы только `LIVE_ENTRY_SCALE_IN_CORRIDOR_PCT`, оба направления берут это значение (симметрично).
     */
    liveEntryScaleInEnabled: z.boolean().default(false),
    liveEntryScaleInDelayMs: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    /** Симметричный fallback, когда не заданы UP/DOWN env. */
    liveEntryScaleInCorridorPct: z.coerce.number().min(0.1).max(50).default(3),
    liveEntryScaleInCorridorUpPct: z.coerce.number().min(0.01).max(50).default(3),
    liveEntryScaleInCorridorDownPct: z.coerce.number().min(0.01).max(50).default(3),
    liveEntryScaleInMaxSwapAttempts: z.coerce.number().int().min(1).max(50).default(5),
    liveEntryScaleInRetryBackoffMs: z.coerce.number().int().min(200).max(120_000).default(2000),
  })
  .superRefine((data, ctx) => {
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

  const symCorridorPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_PCT?.trim();
    if (!s) return 3;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.1 ? Math.min(n, 50) : 3;
  })();
  const corridorUpPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT?.trim();
    if (!s) return symCorridorPct;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.01 ? Math.min(n, 50) : symCorridorPct;
  })();
  const corridorDownPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT?.trim();
    if (!s) return symCorridorPct;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.01 ? Math.min(n, 50) : symCorridorPct;
  })();

  const parsed = LiveOscarConfigSchema.safeParse({
    strategyEnabled: envBool(process.env.LIVE_STRATEGY_ENABLED, false),
    executionMode: (process.env.LIVE_EXECUTION_MODE ?? 'dry_run').trim().toLowerCase(),
    profile: (process.env.LIVE_STRATEGY_PROFILE ?? 'oscar').trim().toLowerCase(),
    liveTradesPath: process.env.LIVE_TRADES_PATH,
    strategyId: process.env.LIVE_STRATEGY_ID,
    heartbeatIntervalMs: process.env.LIVE_HEARTBEAT_INTERVAL_MS,
    parityPaperTradesPath: parityPaper,
    walletSecret: process.env.LIVE_WALLET_SECRET,
    liveWalletPubkeyExpected: process.env.LIVE_WALLET_PUBKEY?.trim() || undefined,
    liveJupiterQuoteUrl: process.env.LIVE_JUPITER_QUOTE_URL?.trim() || undefined,
    liveJupiterSwapUrl: process.env.LIVE_JUPITER_SWAP_URL?.trim() || undefined,
    liveJupiterQuoteTimeoutMs: process.env.LIVE_JUPITER_QUOTE_TIMEOUT_MS,
    liveJupiterSwapTimeoutMs: process.env.LIVE_JUPITER_SWAP_TIMEOUT_MS,
    liveDefaultSlippageBps: process.env.LIVE_DEFAULT_SLIPPAGE_BPS,
    liveQuoteMaxAgeMs: (() => {
      const s = process.env.LIVE_QUOTE_MAX_AGE_MS?.trim();
      if (s === '0') return undefined;
      if (!s) return 8000;
      const n = Number.parseInt(s, 10);
      if (!Number.isFinite(n) || n < 1) return 8000;
      return Math.min(n, 600_000);
    })(),

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
    liveMinWalletSolEquityUsd: optionalPositiveEnv('LIVE_MIN_WALLET_SOL_EQUITY_USD'),
    liveBtcGateEnabled: envBool(process.env.LIVE_BTC_GATE_ENABLED, true),
    liveBtcGateMaxStaleMs: (() => {
      const s = process.env.LIVE_BTC_GATE_MAX_STALE_MS?.trim();
      if (!s) return 900_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 60_000 ? Math.min(n, 3_600_000) : 900_000;
    })(),
    liveBtcBlockNewBuys1hDrawdownPct: (() => {
      const s = process.env.LIVE_BTC_BLOCK_1H_DRAWDOWN_PCT?.trim();
      if (!s) return 2.5;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 2.5;
    })(),
    liveBtcBlockNewBuys4hDrawdownPct: (() => {
      const s = process.env.LIVE_BTC_BLOCK_4H_DRAWDOWN_PCT?.trim();
      if (!s) return 5;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 5;
    })(),
    liveEntryNotionalUsd: optionalPositiveEnv('LIVE_ENTRY_NOTIONAL_USD'),
    liveEntryMinFreeMult: process.env.LIVE_ENTRY_MIN_FREE_MULT,
    liveCapitalRotateCascade: envBool(process.env.LIVE_CAPITAL_ROTATE_CASCADE, false),
    liveFreeSolBufferLamports: process.env.LIVE_FREE_SOL_BUFFER_LAMPORTS,

    liveConfirmCommitment: parseLiveConfirmCommitment(process.env.LIVE_CONFIRM_COMMITMENT),
    liveConfirmTimeoutMs: process.env.LIVE_CONFIRM_TIMEOUT_MS,
    liveSendSkipPreflight: envBool(process.env.LIVE_SEND_SKIP_PREFLIGHT, false),
    liveSimBeforeSend: envBool(process.env.LIVE_SIM_BEFORE_SEND, true),
    liveSendMaxRetries: process.env.LIVE_SEND_MAX_RETRIES,
    liveSendRetryBaseMs: process.env.LIVE_SEND_RETRY_BASE_MS,
    liveSendCreditsPerCall: process.env.LIVE_SEND_CREDITS_PER_CALL,
    liveSendRpcTimeoutMs: process.env.LIVE_SEND_RPC_TIMEOUT_MS,
    liveRpcHttpUrl: process.env.LIVE_RPC_HTTP_URL?.trim() || undefined,

    liveReplayOnBoot: envBool(process.env.LIVE_REPLAY_ON_BOOT, true),
    liveReplayTailLines: optionalPositiveIntEnv('LIVE_REPLAY_TAIL_LINES'),
    liveReplaySinceTs: (() => {
      const s = process.env.LIVE_REPLAY_SINCE_TS?.trim();
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    })(),
    liveReplayMaxFileBytes: process.env.LIVE_REPLAY_MAX_FILE_BYTES,
    liveReconcileTxSampleN: (() => {
      const s = process.env.LIVE_RECONCILE_TX_SAMPLE_N?.trim();
      if (!s) return 0;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 0;
    })(),
    liveReplayTrustGhostPositions: envBool(process.env.LIVE_REPLAY_TRUST_GHOST_POSITIONS, false),
    liveStrictNotionalParity: envBool(process.env.LIVE_STRICT_NOTIONAL_PARITY, true),
    liveAnchorVerifyOnBoot: envBool(process.env.LIVE_ANCHOR_VERIFY_ON_BOOT, true),

    liveReconcileBlockMaxMs: (() => {
      const s = process.env.LIVE_RECONCILE_BLOCK_MAX_MS?.trim();
      if (!s || s === '0') return 0;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 86_400_000) : 0;
    })(),

    livePeriodicSelfHealMs: (() => {
      const s = process.env.LIVE_PERIODIC_SELF_HEAL_MS?.trim();
      if (s === '0') return 0;
      if (!s) return 1_800_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 86_400_000) : 1_800_000;
    })(),
    livePeriodicSweepMinUsd: (() => {
      const s = process.env.LIVE_PERIODIC_SWEEP_MIN_USD?.trim();
      if (!s) return 0.25;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : 0.25;
    })(),
    livePeriodicSweepUnknownChainOnly: envBool(process.env.LIVE_PERIODIC_SWEEP_UNKNOWN_CHAIN_ONLY, false),
    livePeriodicStuckGraceHours: (() => {
      const s = process.env.LIVE_PERIODIC_STUCK_GRACE_HOURS?.trim();
      if (!s) return 0.5;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 168) : 0.5;
    })(),
    liveSkipBuyOpenIfWalletMintMinUsd: (() => {
      const s = process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD?.trim();
      if (!s || s === '0') return 0;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 0;
    })(),
    livePostCloseTailSweepDelayMs: (() => {
      const s = process.env.LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS?.trim();
      if (!s) return 60_000;
      if (s === '0') return 0;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 3_600_000) : 60_000;
    })(),
    livePostCloseTailSweepMinUsd: (() => {
      const s = process.env.LIVE_POST_CLOSE_TAIL_SWEEP_MIN_USD?.trim();
      if (!s) return 0.05;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : 0.05;
    })(),

    liveEntryScaleInEnabled: envBool(process.env.LIVE_ENTRY_SCALE_IN_ENABLED, false),
    liveEntryScaleInDelayMs: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_DELAY_MS?.trim();
      if (!s) return 30_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 1000 ? Math.min(n, 600_000) : 30_000;
    })(),
    liveEntryScaleInCorridorPct: symCorridorPct,
    liveEntryScaleInCorridorUpPct: corridorUpPct,
    liveEntryScaleInCorridorDownPct: corridorDownPct,
    liveEntryScaleInMaxSwapAttempts: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS?.trim();
      if (!s) return 5;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : 5;
    })(),
    liveEntryScaleInRetryBackoffMs: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS?.trim();
      if (!s) return 2000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 200 ? Math.min(n, 120_000) : 2000;
    })(),
    liveJupiterPriorityMaxLamports: (() => {
      const sol = process.env.LIVE_JUPITER_PRIORITY_MAX_SOL?.trim();
      if (sol) {
        const n = Number(sol);
        if (Number.isFinite(n) && n > 0) {
          const lam = Math.round(n * 1e9);
          if (lam >= 1 && lam <= 50_000_000) return lam;
        }
      }
      const lamEnv = process.env.LIVE_JUPITER_PRIORITY_MAX_LAMPORTS?.trim();
      if (!lamEnv) return undefined;
      const n = Number.parseInt(lamEnv, 10);
      if (!Number.isFinite(n) || n < 1) return undefined;
      return Math.min(n, 50_000_000);
    })(),
    liveJupiterSwapPriorityLevel: (() => {
      const s = (process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL ?? 'medium').trim().toLowerCase();
      if (s === 'high') return 'high';
      if (s === 'veryhigh' || s === 'very_high') return 'veryHigh';
      return 'medium';
    })(),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid live-oscar env:\n${issues}`);
  }

  const cfg = parsed.data;
  assertPathsDiffer(cfg.liveTradesPath, cfg.parityPaperTradesPath);

  return cfg;
}
