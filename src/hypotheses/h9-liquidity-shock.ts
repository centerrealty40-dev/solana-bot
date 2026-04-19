import {
  buildSignal,
  type Hypothesis,
  type HypothesisPositionView,
  type HypothesisSignal,
  type MarketCtx,
  type NormalizedSwap,
  type ExitSignal,
} from './base.js';

/**
 * H9 — Liquidity Shock dip-buy
 *
 * The original "buy a sharp dip on a reliable runner and scalp the bounce" thesis.
 *
 * Triggers when ALL hold:
 *   1. Token is "liquid" — at least 50 swaps in the last hour AND last-hour total
 *      volume >= $10,000 (proxy for a real running token, no zero-volume garbage)
 *   2. Price has fallen >= 20% in the last 10 minutes
 *   3. Sell-side USD volume in last 10 min is >= 4× buy-side USD volume in same window
 *      (true panic selling, not balanced trading)
 *
 * This is a fast scalp — exits are tight and timeout is short. The strategy bets that
 * the dump is forced (margin call / liquidation cascade / rumor) and a partial bounce
 * follows within ~30 minutes as buyers step in.
 */
export class H9LiquidityShock implements Hypothesis {
  id = 'h9';
  describe(): string {
    return 'Sharp dip (-20% in 10m) on liquid token with sell pressure ≥4× buy → scalp the bounce';
  }

  private readonly POSITION_SIZE_USD = 50;
  private readonly DROP_THRESHOLD = -0.20;
  private readonly SELL_PRESSURE_MULT = 4;
  private readonly MIN_HOURLY_SWAPS = 50;
  private readonly MIN_HOURLY_VOL = 10_000;
  private readonly COOLDOWN_MS = 2 * 3600_000;
  private readonly THROTTLE_MS = 30_000;

  private lastChecked = new Map<string, number>();
  private lastEntered = new Map<string, number>();

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    const mint = swap.baseMint;
    const now = Date.now();
    if (now - (this.lastChecked.get(mint) ?? 0) < this.THROTTLE_MS) return null;
    this.lastChecked.set(mint, now);
    if (now - (this.lastEntered.get(mint) ?? 0) < this.COOLDOWN_MS) return null;

    if (ctx.recentSwaps.length < this.MIN_HOURLY_SWAPS) return null;
    let hourlyVol = 0;
    for (const s of ctx.recentSwaps) hourlyVol += s.amountUsd;
    if (hourlyVol < this.MIN_HOURLY_VOL) return null;

    const cutoff10m = now - 10 * 60_000;
    let sellVol = 0;
    let buyVol = 0;
    let priceMax10m = 0;
    let priceMin10m = Number.POSITIVE_INFINITY;
    for (const s of ctx.recentSwaps) {
      if (s.blockTime.getTime() < cutoff10m) continue;
      if (s.priceUsd > priceMax10m) priceMax10m = s.priceUsd;
      if (s.priceUsd < priceMin10m) priceMin10m = s.priceUsd;
      if (s.side === 'sell') sellVol += s.amountUsd;
      else buyVol += s.amountUsd;
    }
    if (priceMax10m <= 0 || priceMin10m === Number.POSITIVE_INFINITY) return null;
    const drawdown = swap.priceUsd / priceMax10m - 1;
    if (drawdown > this.DROP_THRESHOLD) return null;
    if (buyVol <= 0) return null;
    const pressure = sellVol / buyVol;
    if (pressure < this.SELL_PRESSURE_MULT) return null;
    // Confirm we're near the local low (within 15% of priceMin10m), not a knife mid-air
    if (swap.priceUsd > priceMin10m * 1.15) return null;

    this.lastEntered.set(mint, now);
    return [
      buildSignal(
        this.id,
        mint,
        'buy',
        this.POSITION_SIZE_USD,
        `dip ${(drawdown * 100).toFixed(1)}% in 10m, sell/buy ratio ×${pressure.toFixed(1)}, hourly vol $${hourlyVol.toFixed(0)}`,
        {
          entryPrice: swap.priceUsd,
          dipFromPrice: priceMax10m,
          drawdown,
          pressure,
        },
      ),
    ];
  }

  shouldExit(pos: HypothesisPositionView): ExitSignal | null {
    const pnlPct = pos.currentPriceUsd / pos.entryPriceUsd - 1;
    const heldMs = Date.now() - pos.openedAt.getTime();

    // Aggressive scalp: hard stop and quick takes
    if (pnlPct <= -0.08) return { reason: `hard stop ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    if (pos.exitsCount === 0 && pnlPct >= 0.05) {
      return { reason: `TP1 50% at +${(pnlPct * 100).toFixed(1)}%`, fraction: 0.5 };
    }
    if (pos.exitsCount === 1 && pnlPct >= 0.10) {
      return { reason: `TP2 close at +${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    }
    if (heldMs >= 30 * 60_000) {
      return { reason: `timeout 30m at ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    }
    return null;
  }
}
