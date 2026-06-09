import type { PumpswapComboFollowConfig } from './config.js';
import { paperInvestedRemainingUsd, paperPoolExitQuoteUsd, paperPnlPctVsAvg } from './paper-pricing.js';
import type { FollowState } from './state.js';

export type FollowPortfolioSnap = {
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  openCount: number;
  halted: boolean;
};

export async function followPaperPortfolioSnapshot(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<FollowPortfolioSnap> {
  let unrealized = 0;
  for (const pos of state.positions) {
    if (pos.remainingFrac <= 1e-6) continue;
    const q = await paperPoolExitQuoteUsd({ rpcUrl: cfg.rpcUrl, pos });
    if (q.priceUsd == null) continue;
    const inv = paperInvestedRemainingUsd(pos);
    const pct = paperPnlPctVsAvg(pos, q.priceUsd);
    unrealized += inv * (pct / 100);
  }
  const total = state.realizedPnlUsd + unrealized;
  return {
    realizedPnlUsd: state.realizedPnlUsd,
    unrealizedPnlUsd: unrealized,
    totalPnlUsd: total,
    openCount: state.positions.filter((p) => p.remainingFrac > 1e-6).length,
    halted: state.halted,
  };
}
