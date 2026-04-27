import {
  type ExitSignal,
  type Hypothesis,
  type HypothesisPositionView,
  type HypothesisSignal,
  type MarketCtx,
  type NormalizedSwap,
} from './base.js';

/**
 * H5. Negative copy — "exit liquidity wallets" as a top-marker.
 *
 * Class: wallets with realized_pnl_30d < -100 USD AND tradeCount30d >= 10
 * (heuristic for "frequent loser").
 *
 * Spot use: a flood of these wallets buying the same token is a sign of local top.
 *
 * In our long-only paper architecture we do not actually short here. Instead, H5
 * acts as a *risk filter*: when triggered it forces an EXIT of any open positions on
 * the same mint owned by other hypotheses. This is implemented by emitting a
 * `sell` signal on the mint (the runner currently ignores sell signals at entry stage,
 * but it will be visible in the signals table for analysis).
 *
 * Once Stage 5 enables shorting (e.g. via Drift perps), this hypothesis can also enter.
 *
 * Exit logic for any positions it does open is symmetric to other hypotheses and
 * conservative — but in MVP it owns no positions of its own, so shouldExit is a no-op.
 */
export class H5NegativeCopy implements Hypothesis {
  id = 'h5';
  describe(): string {
    return 'Negative copy: emits SELL signal when 5+ losing wallets buy same token in 60 min (risk filter)';
  }

  private readonly windowMs = 60 * 60_000;

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    const myScore = ctx.scores.get(swap.wallet);
    if (!isLoser(myScore)) return null;

    const cutoff = swap.blockTime.getTime() - this.windowMs;
    const losers = new Set<string>([swap.wallet]);
    for (const s of ctx.recentSwaps) {
      if (s.signature === swap.signature) continue;
      if (s.side !== 'buy') continue;
      if (s.blockTime.getTime() < cutoff) continue;
      const sc = ctx.scores.get(s.wallet);
      if (isLoser(sc)) losers.add(s.wallet);
    }
    if (losers.size < 5) return null;

    return [
      {
        hypothesisId: this.id,
        ts: new Date(),
        baseMint: swap.baseMint,
        side: 'sell',
        sizeUsd: 0,
        reason: `${losers.size} losing wallets bought in ${(this.windowMs / 60_000).toFixed(0)}min - local top warning`,
        meta: { losers: Array.from(losers) },
      },
    ];
  }

  shouldExit(_pos: HypothesisPositionView, _ctx: MarketCtx): ExitSignal | null {
    // H5 doesn't open long positions in MVP.
    return null;
  }
}

function isLoser(
  score: ReturnType<MarketCtx['scores']['get']>,
): boolean {
  if (!score) return false;
  if (score.realizedPnl30d >= -100) return false;
  // we approximate "frequent" by holding_avg_minutes very low (<60) which signals chop trader
  if (score.holdingAvgMinutes > 60) return false;
  return true;
}
