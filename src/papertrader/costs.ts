import type { DexId, CloseCosts, OpenTrade } from './types.js';
import type { PaperTraderConfig } from './config.js';
import { feeBpsForDex, slipBaseBpsForDex } from './config.js';

/**
 * Dynamic slippage component.
 * (trade_usd / liquidity_usd) * SLIP_LIQUIDITY_COEF * 10000 → bps.
 * Returns 0 when liquidity is unknown / zero.
 */
export function dynamicSlipBps(
  cfg: PaperTraderConfig,
  tradeUsd: number,
  liquidityUsd: number | null | undefined,
): number {
  if (!liquidityUsd || liquidityUsd <= 0) return 0;
  return (tradeUsd / liquidityUsd) * cfg.slipLiquidityCoef * 10_000;
}

/**
 * Total spread bps for one side = base + dynamic.
 */
export function sideCostBps(
  cfg: PaperTraderConfig,
  dex: DexId,
  tradeUsd: number,
  liquidityUsd: number | null | undefined,
): { feeBps: number; slipBps: number; totalBps: number } {
  const feeBps = feeBpsForDex(cfg, dex);
  const slipBps = slipBaseBpsForDex(cfg, dex) + dynamicSlipBps(cfg, tradeUsd, liquidityUsd);
  return { feeBps, slipBps, totalBps: feeBps + slipBps };
}

/**
 * Effective BUY price = market * (1 + totalCost).
 */
export function applyEntryCosts(
  cfg: PaperTraderConfig,
  marketPrice: number,
  dex: DexId,
  tradeUsd: number,
  liquidityUsd: number | null | undefined,
): { effectivePrice: number; bps: { feeBps: number; slipBps: number; totalBps: number } } {
  const bps = sideCostBps(cfg, dex, tradeUsd, liquidityUsd);
  const effectivePrice = marketPrice * (1 + bps.totalBps / 10_000);
  return { effectivePrice, bps };
}

/**
 * Effective SELL price = market * (1 - totalCost).
 */
export function applyExitCosts(
  cfg: PaperTraderConfig,
  marketPrice: number,
  dex: DexId,
  tradeUsd: number,
  liquidityUsd: number | null | undefined,
): { effectivePrice: number; bps: { feeBps: number; slipBps: number; totalBps: number } } {
  const bps = sideCostBps(cfg, dex, tradeUsd, liquidityUsd);
  const effectivePrice = marketPrice * (1 - bps.totalBps / 10_000);
  return { effectivePrice, bps };
}

/**
 * Decide whether a TX simulates as failed (PAPER_FILL_RATE_PCT < 100).
 * Default fillRatePct = 100 → always true. Used by W6.3c executor to model failed buys.
 */
export function simulateFill(cfg: PaperTraderConfig): boolean {
  if (cfg.fillRatePct >= 100) return true;
  if (cfg.fillRatePct <= 0) return false;
  return Math.random() * 100 < cfg.fillRatePct;
}

/**
 * Build the cost-breakdown object for the JSONL `close` event.
 * Aggregates all per-leg / per-sell costs into one structure that lab can re-simulate.
 */
export function buildCloseCosts(args: {
  cfg: PaperTraderConfig;
  trade: OpenTrade;
  exit: { effectivePrice: number; marketPrice: number };
  networkFeeUsdTotal: number;
  slipDynamicBpsEntry: number;
  slipDynamicBpsExit: number;
  netPnlUsd: number;
  grossPnlUsd: number;
}): CloseCosts {
  const { cfg, trade, networkFeeUsdTotal, slipDynamicBpsEntry, slipDynamicBpsExit, netPnlUsd, grossPnlUsd } =
    args;
  const dex = trade.dex;
  return {
    dex,
    fee_bps_per_side: feeBpsForDex(cfg, dex),
    slip_base_bps_per_side: slipBaseBpsForDex(cfg, dex),
    slip_dynamic_bps_entry: +slipDynamicBpsEntry.toFixed(2),
    slip_dynamic_bps_exit: +slipDynamicBpsExit.toFixed(2),
    network_fee_usd_total: +networkFeeUsdTotal.toFixed(4),
    gross_pnl_usd: +grossPnlUsd.toFixed(4),
    fee_cost_usd: +(grossPnlUsd - netPnlUsd - networkFeeUsdTotal).toFixed(4),
    slippage_cost_usd: 0,
    network_cost_usd: +networkFeeUsdTotal.toFixed(4),
    net_pnl_usd: +netPnlUsd.toFixed(4),
  };
}
