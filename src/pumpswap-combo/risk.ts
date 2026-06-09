import type { PumpswapComboConfig } from './config.js';
import type { ComboState } from './state.js';
import type { ComboPosition } from './types.js';
import { investedUsd } from './state.js';
import { quoteExitPriceUsd, pnlPctVsAvgFill } from './pricing.js';
import { comboLiveBridge } from './live-bridge.js';

export type PortfolioSnap = {
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  openCount: number;
  halted: boolean;
};

export async function portfolioSnapshot(cfg: PumpswapComboConfig, state: ComboState): Promise<PortfolioSnap> {
  const liveCfg = comboLiveBridge(cfg);
  let unrealized = 0;
  for (const p of state.positions) {
    const q = await quoteExitPriceUsd(liveCfg, p.mint, p.poolAddress);
    if (q.priceUsd == null) continue;
    const inv = investedUsd(p);
    const pct = pnlPctVsAvgFill(p, q.priceUsd);
    unrealized += inv * (pct / 100);
  }
  const total = state.realizedPnlUsd + unrealized;
  return {
    realizedPnlUsd: state.realizedPnlUsd,
    unrealizedPnlUsd: unrealized,
    totalPnlUsd: total,
    openCount: state.positions.length,
    halted: state.halted,
  };
}

export function applyPortfolioHalt(cfg: PumpswapComboConfig, state: ComboState, totalPnlUsd: number): boolean {
  if (state.halted) return true;
  if (totalPnlUsd > -Math.abs(cfg.portfolioStopLossUsd)) return false;
  state.halted = true;
  state.haltReason = `portfolio_stop_${cfg.portfolioStopLossUsd}usd`;
  state.haltedAt = Date.now();
  return true;
}

export function recordRealizedPnl(state: ComboState, pnlUsd: number): void {
  state.realizedPnlUsd = +(state.realizedPnlUsd + pnlUsd).toFixed(6);
}

export function updateBotPeak(pos: ComboPosition, priceUsd: number): void {
  if (priceUsd > pos.botPeakUsd) pos.botPeakUsd = priceUsd;
}

export function dipFromPosPeakPct(pos: ComboPosition, priceUsd: number): number | null {
  if (!(pos.botPeakUsd > 0) || !(priceUsd > 0)) return null;
  return ((pos.botPeakUsd - priceUsd) / pos.botPeakUsd) * 100;
}
