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
  maxOpenPositions: z.coerce.number().int().min(1).max(20).default(2),
  scanIntervalMs: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  markIntervalMs: z.coerce.number().int().min(2_000).max(120_000).default(10_000),
  mintCooldownMs: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(150),
  minFeeSolReserve: z.coerce.number().min(0).max(10).default(0.02),
  /** Candidate mint sources: comma list — stream,boosts,profiles,seed */
  discoverSources: z.string().default('stream,boosts,profiles'),
  seedMintsPath: z.string().optional(),
  /** Helius/RPC logsSubscribe on pump programs → hot mint universe. */
  streamEnabled: z.boolean().default(true),
  streamWsUrl: z.string().optional(),
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
    tpGainPct: z.number(),
    timeStopMs: z.number(),
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
    maxDipPct: envNum('MILD_DIP_MAX_DIP_PCT', 0),
    minVolume5mUsd: envNum('MILD_DIP_MIN_VOLUME_5M_USD', 8_000),
    minLiquidityUsd: envNum('MILD_DIP_MIN_LIQUIDITY_USD', 15_000),
    minMarketCapUsd: envNum('MILD_DIP_MIN_MCAP_USD', 50_000),
    maxMarketCapUsd: envNum('MILD_DIP_MAX_MCAP_USD', 5_000_000),
    minPairAgeHours: envNum('MILD_DIP_MIN_PAIR_AGE_HOURS', 0.25),
    maxPairAgeHours: envNum('MILD_DIP_MAX_PAIR_AGE_HOURS', 72),
    allowedDexIds,
  };

  const exit: MildDipExitGates = {
    tpGainPct: envNum('MILD_DIP_TP_GAIN_PCT', 10),
    timeStopMs: Math.floor(envNum('MILD_DIP_TIME_STOP_MS', 360_000)),
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
    maxOpenPositions: process.env.MILD_DIP_MAX_OPEN_POSITIONS ?? 2,
    scanIntervalMs: process.env.MILD_DIP_SCAN_INTERVAL_MS ?? 30_000,
    markIntervalMs: process.env.MILD_DIP_MARK_INTERVAL_MS ?? 10_000,
    mintCooldownMs: process.env.MILD_DIP_MINT_COOLDOWN_MS ?? 3_600_000,
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
