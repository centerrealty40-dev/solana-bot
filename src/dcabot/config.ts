/**
 * dca_frontrun (paper) — configuration.
 *
 * Product: dca_frontrun. Env prefix: DCABOT_. PG tables: dcabot_*. PM2: salpha-dcabot.
 * Paper-only: this module NEVER signs or moves funds. It simulates fills against live
 * market prices and records everything to Postgres for later analysis.
 *
 * The trading spec (agreed with the owner):
 *   - virtual bank: $1,000 (no hard position / stop-loss limits in paper mode)
 *   - enter AFTER cycle 1 executes, only if estimated price gain >= MIN_GAIN_PCT
 *   - average down: every -AVG_DOWN_STEP_PCT from avg entry, buy AVG_DOWN_USD
 *   - take profit: every +TP_STEP_PCT from avg entry, sell TP_SELL_FRACTION of the position
 *   - exit before the DCA bots: sell 50% EXIT_FIRST_CYCLES_BEFORE before the planned end,
 *     the rest EXIT_SECOND_CYCLES_BEFORE before the end — UNLESS per-cycle size
 *     > BIG_CYCLE_HOLD_USD, in which case hold fully to the end
 *   - operator early-cancel: if in profit sell 100% now; if in loss sell 50% now and
 *     50% after EARLY_CANCEL_DELAY_MIN minutes
 *   - legitimacy: score every coin (stored + shown) but DO NOT block buys yet
 */

function num(env: string | undefined, def: number): number {
  const n = Number(env);
  return Number.isFinite(n) ? n : def;
}

function str(env: string | undefined, def: string): string {
  return env && env.trim() ? env.trim() : def;
}

export const dcabotConfig = {
  /** Postgres DSN (shared Neon instance with the watcher). */
  databaseUrl: process.env.SA_PG_DSN || process.env.DATABASE_URL || '',
  /** Solana RPC for vault liveness / cadence checks (Helius primary, QuickNode fallback). */
  rpcUrl: str(process.env.DCABOT_RPC_URL, process.env.SA_RPC_HTTP_URL || process.env.HELIUS_RPC_URL || ''),
  rpcFallbackUrl: str(process.env.DCABOT_RPC_FALLBACK_URL, process.env.SA_RPC_FALLBACK_URL || ''),

  /** Paper bank in USD. */
  bankUsd: num(process.env.DCABOT_BANK_USD, 1000),

  /** Entry gate: minimum estimated total price increase from the DCA's own buying. */
  minGainPct: num(process.env.DCABOT_MIN_GAIN_PCT, 3),
  /** Base position size on first entry (after cycle 1). */
  baseEntryUsd: num(process.env.DCABOT_BASE_ENTRY_USD, 300),

  /** Average-down: each -5% from avg entry, buy $300. No cap by default (paper). */
  avgDownStepPct: num(process.env.DCABOT_AVG_DOWN_STEP_PCT, 5),
  avgDownUsd: num(process.env.DCABOT_AVG_DOWN_USD, 300),
  /** Optional ceiling on number of average-down adds (0 = unlimited). */
  avgDownMaxAdds: num(process.env.DCABOT_AVG_DOWN_MAX_ADDS, 0),

  /** Take-profit: each +5% from avg entry, sell 20% of the current position. */
  tpStepPct: num(process.env.DCABOT_TP_STEP_PCT, 5),
  tpSellFraction: num(process.env.DCABOT_TP_SELL_FRACTION, 0.2),

  /** Pre-exit ahead of the DCA bots, expressed in cycles-before-end. */
  exitFirstCyclesBefore: num(process.env.DCABOT_EXIT_FIRST_CYCLES_BEFORE, 2),
  exitSecondCyclesBefore: num(process.env.DCABOT_EXIT_SECOND_CYCLES_BEFORE, 1),
  exitFirstFraction: num(process.env.DCABOT_EXIT_FIRST_FRACTION, 0.5),
  /** If per-cycle size exceeds this, do NOT pre-exit — ride the full order. */
  bigCycleHoldUsd: num(process.env.DCABOT_BIG_CYCLE_HOLD_USD, 10000),

  /** Operator early-cancel handling. */
  earlyCancelLossFirstFraction: num(process.env.DCABOT_EARLY_CANCEL_LOSS_FIRST_FRACTION, 0.5),
  earlyCancelDelayMin: num(process.env.DCABOT_EARLY_CANCEL_DELAY_MIN, 10),

  /** Loop + dashboard. */
  tickMs: num(process.env.DCABOT_TICK_MS, 15000),
  signalSource: str(process.env.DCABOT_SIGNAL_SOURCE, 'swap_exec_dca'),
  signalLookbackMin: num(process.env.DCABOT_SIGNAL_LOOKBACK_MIN, 240),
  dashHost: str(process.env.DCABOT_DASH_HOST, '127.0.0.1'),
  dashPort: num(process.env.DCABOT_DASH_PORT, 8645),
  enabled: process.env.DCABOT_ENABLED !== '0',
} as const;

export type DcabotConfig = typeof dcabotConfig;
