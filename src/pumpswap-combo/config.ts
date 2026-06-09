import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';

const ConfigSchema = z.object({
  strategyId: z.string().min(1).default('pumpswap-combo'),
  journalPath: z.string().min(1),
  statePath: z.string().min(1),
  rpcUrl: z.string().min(8),
  pollIntervalMs: z.coerce.number().int().min(2000).max(60_000).default(5000),
  heartbeatIntervalMs: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  watchlistMax: z.coerce.number().int().min(5).max(80).default(30),
  /** PG signal filters — жёстче reference bots, меньше кандидатов. */
  minLiquidityUsd: z.coerce.number().min(0).default(40_000),
  minVolume5mUsd: z.coerce.number().min(0).default(3_000),
  minMarketCapUsd: z.coerce.number().min(0).default(100_000),
  maxMarketCapUsd: z.coerce.number().min(0).default(3_000_000),
  rollingHighWindowMs: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
  /** Current dump from rolling high to spot (hnu5 live ~−5…−10%, forensic cluster −10…−20%). */
  dumpMinPct: z.coerce.number().min(1).max(80).default(5),
  dumpMaxPct: z.coerce.number().min(1).max(90).default(22),
  /** Reject stale dumps: window low must be within this many ms of now. */
  dumpFreshnessMs: z.coerce.number().int().min(30_000).max(900_000).default(180_000),
  /** Probe: первый buy около local peak (med 0%). */
  probeMaxDipFromPeakPct: z.coerce.number().min(0).max(30).default(7),
  /** DCA add: med −29% от bot peak на mint. */
  addDipMinPct: z.coerce.number().min(5).max(60).default(25),
  addDipMaxPct: z.coerce.number().min(5).max(70).default(32),
  maxBuyLegs: z.coerce.number().int().min(1).max(5).default(3),
  addMinGapMs: z.coerce.number().int().min(60_000).default(600_000),
  legUsd: z.coerce.number().positive().max(500).default(3),
  /** Forensic TP ladder (hnu5/FYX5): ~70% @ +13%, rest @ +25%. */
  tp1Pct: z.coerce.number().min(1).max(100).default(13),
  tp1SellFrac: z.coerce.number().min(0.1).max(1).default(0.7),
  tp2Pct: z.coerce.number().min(1).max(200).default(25),
  /** SL: −20% single leg, −22% после DCA (forensic p25 last sell). */
  slSingleLegPct: z.coerce.number().min(1).max(90).default(20),
  slMultiLegPct: z.coerce.number().min(1).max(90).default(22),
  portfolioStopLossUsd: z.coerce.number().positive().default(50),
  lossCooldownMs: z.coerce.number().int().min(0).default(600_000),
  lossAlertUsd: z.coerce.number().positive().default(5),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(300),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
});

export type PumpswapComboConfig = z.infer<typeof ConfigSchema>;

export function loadPumpswapComboConfig(): PumpswapComboConfig {
  const root = process.cwd();
  const journalPath =
    process.env.PUMPSWAP_COMBO_JOURNAL_PATH?.trim() ||
    path.join(root, 'data/pumpswap-combo/journal.jsonl');
  const statePath =
    process.env.PUMPSWAP_COMBO_STATE_PATH?.trim() ||
    path.join(root, 'data/pumpswap-combo/state.json');
  const rpcUrl =
    process.env.PUMPSWAP_COMBO_RPC_URL?.trim() ||
    liveOscarRpcHttpUrlFromEnv() ||
    resolveSolanaRpcUrl() ||
    '';

  const walletSecret = process.env.PUMPSWAP_COMBO_WALLET_SECRET?.trim();
  if (!walletSecret || !fs.existsSync(walletSecret)) {
    throw new Error(
      `PUMPSWAP_COMBO_WALLET_SECRET missing or file not found (${walletSecret ?? 'unset'}) — live-only bot`,
    );
  }

  return ConfigSchema.parse({
    strategyId: process.env.PUMPSWAP_COMBO_STRATEGY_ID ?? 'pumpswap-combo',
    journalPath,
    statePath,
    rpcUrl,
    pollIntervalMs: process.env.PUMPSWAP_COMBO_POLL_MS,
    heartbeatIntervalMs: process.env.PUMPSWAP_COMBO_HEARTBEAT_MS,
    watchlistMax: process.env.PUMPSWAP_COMBO_WATCHLIST_MAX,
    minLiquidityUsd: process.env.PUMPSWAP_COMBO_MIN_LIQ_USD,
    minVolume5mUsd: process.env.PUMPSWAP_COMBO_MIN_VOL_5M_USD,
    minMarketCapUsd: process.env.PUMPSWAP_COMBO_MIN_MCAP_USD,
    maxMarketCapUsd: process.env.PUMPSWAP_COMBO_MAX_MCAP_USD,
    rollingHighWindowMs: process.env.PUMPSWAP_COMBO_ROLLING_HIGH_MS,
    dumpMinPct: process.env.PUMPSWAP_COMBO_DUMP_MIN_PCT,
    dumpMaxPct: process.env.PUMPSWAP_COMBO_DUMP_MAX_PCT,
    dumpFreshnessMs: process.env.PUMPSWAP_COMBO_DUMP_FRESHNESS_MS,
    probeMaxDipFromPeakPct: process.env.PUMPSWAP_COMBO_PROBE_MAX_DIP_PCT,
    addDipMinPct: process.env.PUMPSWAP_COMBO_ADD_DIP_MIN_PCT,
    addDipMaxPct: process.env.PUMPSWAP_COMBO_ADD_DIP_MAX_PCT,
    maxBuyLegs: process.env.PUMPSWAP_COMBO_MAX_BUY_LEGS,
    addMinGapMs: process.env.PUMPSWAP_COMBO_ADD_MIN_GAP_MS,
    legUsd: process.env.PUMPSWAP_COMBO_LEG_USD,
    tp1Pct: process.env.PUMPSWAP_COMBO_TP1_PCT,
    tp1SellFrac: process.env.PUMPSWAP_COMBO_TP1_SELL_FRAC,
    tp2Pct: process.env.PUMPSWAP_COMBO_TP2_PCT,
    slSingleLegPct: process.env.PUMPSWAP_COMBO_SL_SINGLE_PCT,
    slMultiLegPct: process.env.PUMPSWAP_COMBO_SL_MULTI_PCT,
    portfolioStopLossUsd: process.env.PUMPSWAP_COMBO_PORTFOLIO_STOP_LOSS_USD,
    lossCooldownMs: process.env.PUMPSWAP_COMBO_LOSS_COOLDOWN_MS,
    lossAlertUsd: process.env.PUMPSWAP_COMBO_LOSS_ALERT_USD,
    slippageBps: process.env.PUMPSWAP_COMBO_SLIPPAGE_BPS,
    walletSecret,
    walletPubkeyExpected: process.env.PUMPSWAP_COMBO_WALLET_PUBKEY?.trim(),
  });
}
