import 'dotenv/config';
import { z } from 'zod';
import type { DexId } from './types.js';

const StrategyKindSchema = z.enum(['fresh', 'dip', 'smart_lottery', 'fresh_validated']);

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

const ConfigSchema = z.object({
  strategyId: z.string().default('paper_v1'),
  strategyKind: StrategyKindSchema.default('fresh'),
  storePath: z.string().default('/tmp/paper-trades.jsonl'),
  discoveryIntervalMs: z.coerce.number().int().positive().default(10_000),
  trackIntervalMs: z.coerce.number().int().positive().default(30_000),
  followupTickMs: z.coerce.number().int().positive().default(30_000),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(10_000),
  solPriceRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  btcContextRefreshMs: z.coerce.number().int().positive().default(5 * 60_000),
  positionUsd: z.coerce.number().positive().default(100),
  btcMints: z
    .string()
    .default(
      '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E,3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh,7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    )
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  feeBpsPumpfun: z.coerce.number().nonnegative().default(100),
  feeBpsPumpswap: z.coerce.number().nonnegative().default(30),
  feeBpsRaydium: z.coerce.number().nonnegative().default(25),
  feeBpsOrca: z.coerce.number().nonnegative().default(10),
  feeBpsMeteora: z.coerce.number().nonnegative().default(20),
  feeBpsMoonshot: z.coerce.number().nonnegative().default(100),
  slipBaseBpsPumpfun: z.coerce.number().nonnegative().default(200),
  slipBaseBpsPumpswap: z.coerce.number().nonnegative().default(50),
  slipBaseBpsRaydium: z.coerce.number().nonnegative().default(50),
  slipBaseBpsOrca: z.coerce.number().nonnegative().default(50),
  slipBaseBpsMeteora: z.coerce.number().nonnegative().default(50),
  slipBaseBpsMoonshot: z.coerce.number().nonnegative().default(150),
  slipLiquidityCoef: z.coerce.number().nonnegative().default(1.0),
  networkFeeUsd: z.coerce.number().nonnegative().default(0.05),
  fillRatePct: z.coerce.number().min(0).max(100).default(100),
  feeBpsPerSide: z.coerce.number().nonnegative().default(100),
  slippageBpsPerSide: z.coerce.number().nonnegative().default(200),
  dryRun: z.boolean().default(false),
});

export type PaperTraderConfig = z.infer<typeof ConfigSchema>;

export function loadPaperTraderConfig(): PaperTraderConfig {
  const parsed = ConfigSchema.safeParse({
    strategyId: process.env.PAPER_STRATEGY_ID,
    strategyKind: process.env.PAPER_STRATEGY_KIND,
    storePath: process.env.PAPER_TRADES_PATH,
    discoveryIntervalMs: process.env.PAPER_DISCOVERY_INTERVAL_MS,
    trackIntervalMs: process.env.PAPER_TRACK_INTERVAL_MS,
    followupTickMs: process.env.PAPER_FOLLOWUP_TICK_MS,
    heartbeatIntervalMs: process.env.PAPER_HEARTBEAT_INTERVAL_MS,
    solPriceRefreshMs: process.env.PAPER_SOL_PRICE_REFRESH_MS,
    btcContextRefreshMs: process.env.PAPER_BTC_CONTEXT_REFRESH_MS,
    positionUsd: process.env.PAPER_POSITION_USD,
    btcMints: process.env.PAPER_BTC_MINTS,
    feeBpsPumpfun: process.env.PAPER_FEE_BPS_PUMPFUN,
    feeBpsPumpswap: process.env.PAPER_FEE_BPS_PUMPSWAP,
    feeBpsRaydium: process.env.PAPER_FEE_BPS_RAYDIUM,
    feeBpsOrca: process.env.PAPER_FEE_BPS_ORCA,
    feeBpsMeteora: process.env.PAPER_FEE_BPS_METEORA,
    feeBpsMoonshot: process.env.PAPER_FEE_BPS_MOONSHOT,
    slipBaseBpsPumpfun: process.env.PAPER_SLIP_BASE_BPS_PUMPFUN,
    slipBaseBpsPumpswap: process.env.PAPER_SLIP_BASE_BPS_PUMPSWAP,
    slipBaseBpsRaydium: process.env.PAPER_SLIP_BASE_BPS_RAYDIUM,
    slipBaseBpsOrca: process.env.PAPER_SLIP_BASE_BPS_ORCA,
    slipBaseBpsMeteora: process.env.PAPER_SLIP_BASE_BPS_METEORA,
    slipBaseBpsMoonshot: process.env.PAPER_SLIP_BASE_BPS_MOONSHOT,
    slipLiquidityCoef: process.env.PAPER_SLIP_LIQUIDITY_COEF,
    networkFeeUsd: process.env.PAPER_NETWORK_FEE_USD,
    fillRatePct: process.env.PAPER_FILL_RATE_PCT,
    feeBpsPerSide: process.env.PAPER_FEE_BPS_PER_SIDE,
    slippageBpsPerSide: process.env.PAPER_SLIPPAGE_BPS_PER_SIDE,
    dryRun: envBool(process.env.PAPER_DRY_RUN, false),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid paper-trader env configuration:\n${issues}`);
  }
  return parsed.data;
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function feeBpsForDex(cfg: PaperTraderConfig, dex: DexId): number {
  switch (dex) {
    case 'pumpfun':
      return cfg.feeBpsPumpfun;
    case 'pumpswap':
      return cfg.feeBpsPumpswap;
    case 'raydium':
      return cfg.feeBpsRaydium;
    case 'orca':
      return cfg.feeBpsOrca;
    case 'meteora':
      return cfg.feeBpsMeteora;
    case 'moonshot':
      return cfg.feeBpsMoonshot;
  }
}

export function slipBaseBpsForDex(cfg: PaperTraderConfig, dex: DexId): number {
  switch (dex) {
    case 'pumpfun':
      return cfg.slipBaseBpsPumpfun;
    case 'pumpswap':
      return cfg.slipBaseBpsPumpswap;
    case 'raydium':
      return cfg.slipBaseBpsRaydium;
    case 'orca':
      return cfg.slipBaseBpsOrca;
    case 'meteora':
      return cfg.slipBaseBpsMeteora;
    case 'moonshot':
      return cfg.slipBaseBpsMoonshot;
  }
}
