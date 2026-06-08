import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import { assertPumpswapDipIsolation } from './isolation.js';

const ExecutionModeSchema = z.enum(['paper', 'dry_run', 'live']);

const ConfigSchema = z.object({
  strategyId: z.string().min(1).default('pumpswap-dip'),
  executionMode: ExecutionModeSchema,
  journalPath: z.string().min(1),
  statePath: z.string().min(1),
  rpcUrl: z.string().min(8),
  pollIntervalMs: z.coerce.number().int().min(1000).max(60_000).default(3000),
  heartbeatIntervalMs: z.coerce.number().int().min(10_000).max(600_000).default(30_000),
  watchlistMax: z.coerce.number().int().min(5).max(200).default(40),
  minLiquidityUsd: z.coerce.number().min(0).max(10_000_000).default(10_000),
  minMarketCapUsd: z.coerce.number().min(0).max(1_000_000_000).default(20_000),
  maxMarketCapUsd: z.coerce.number().min(0).max(1_000_000_000_000).default(5_000_000),
  minVolume5mUsd: z.coerce.number().min(0).max(10_000_000).default(500),
  rollingHighWindowMs: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
  dumpMinPct: z.coerce.number().min(1).max(80).default(10),
  dumpMaxPct: z.coerce.number().min(1).max(90).default(35),
  takeProfitPct: z.coerce.number().min(1).max(200).default(18),
  stopLossPct: z.coerce.number().min(0).max(90).default(25),
  positionUsd: z.coerce.number().positive().max(50_000).default(400),
  maxOpenPositions: z.coerce.number().int().min(1).max(50).default(5),
  maxBuysPerMintPerHour: z.coerce.number().int().min(1).max(20).default(2),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(600),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
});

export type PumpswapDipConfig = z.infer<typeof ConfigSchema>;

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

export function loadPumpswapDipConfig(): PumpswapDipConfig {
  const root = process.cwd();
  const journalPath =
    process.env.PUMPSWAP_DIP_JOURNAL_PATH?.trim() ||
    path.join(root, 'data/pumpswap-dip/journal.jsonl');
  const statePath =
    process.env.PUMPSWAP_DIP_STATE_PATH?.trim() ||
    path.join(root, 'data/pumpswap-dip/state.json');
  const rpcUrl =
    process.env.PUMPSWAP_DIP_RPC_URL?.trim() ||
    liveOscarRpcHttpUrlFromEnv() ||
    resolveSolanaRpcUrl() ||
    '';

  let executionMode = (process.env.PUMPSWAP_DIP_EXECUTION_MODE?.trim() || 'dry_run') as
    | 'paper'
    | 'dry_run'
    | 'live';
  const walletSecret = process.env.PUMPSWAP_DIP_WALLET_SECRET?.trim();
  if (executionMode === 'live' && !walletSecret) {
    console.warn('[pumpswap-dip] PUMPSWAP_DIP_EXECUTION_MODE=live but wallet secret missing — falling back to dry_run');
    executionMode = 'dry_run';
  }
  if (executionMode === 'live' && walletSecret && !fs.existsSync(walletSecret)) {
    throw new Error(`PUMPSWAP_DIP_WALLET_SECRET file not found: ${walletSecret}`);
  }

  const parsed = ConfigSchema.parse({
    strategyId: process.env.PUMPSWAP_DIP_STRATEGY_ID ?? 'pumpswap-dip',
    executionMode,
    journalPath,
    statePath,
    rpcUrl,
    pollIntervalMs: process.env.PUMPSWAP_DIP_POLL_MS,
    heartbeatIntervalMs: process.env.PUMPSWAP_DIP_HEARTBEAT_MS,
    watchlistMax: process.env.PUMPSWAP_DIP_WATCHLIST_MAX,
    minLiquidityUsd: process.env.PUMPSWAP_DIP_MIN_LIQ_USD,
    minMarketCapUsd: process.env.PUMPSWAP_DIP_MIN_MCAP_USD,
    maxMarketCapUsd: process.env.PUMPSWAP_DIP_MAX_MCAP_USD,
    minVolume5mUsd: process.env.PUMPSWAP_DIP_MIN_VOL_5M_USD,
    rollingHighWindowMs: process.env.PUMPSWAP_DIP_ROLLING_HIGH_MS,
    dumpMinPct: process.env.PUMPSWAP_DIP_DUMP_MIN_PCT,
    dumpMaxPct: process.env.PUMPSWAP_DIP_DUMP_MAX_PCT,
    takeProfitPct: process.env.PUMPSWAP_DIP_TP_PCT,
    stopLossPct: process.env.PUMPSWAP_DIP_SL_PCT,
    positionUsd: process.env.PUMPSWAP_DIP_POSITION_USD,
    maxOpenPositions: process.env.PUMPSWAP_DIP_MAX_OPEN,
    maxBuysPerMintPerHour: process.env.PUMPSWAP_DIP_MAX_BUYS_PER_MINT_H,
    slippageBps: process.env.PUMPSWAP_DIP_SLIPPAGE_BPS,
    walletSecret,
    walletPubkeyExpected: process.env.PUMPSWAP_DIP_WALLET_PUBKEY?.trim(),
  });

  if (envBool(process.env.PUMPSWAP_DIP_STRICT_ISOLATION, true)) {
    assertPumpswapDipIsolation(parsed);
  }

  return parsed;
}
