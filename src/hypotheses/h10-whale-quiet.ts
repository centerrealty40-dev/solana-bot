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
 * H10 — Whale Quiet Accumulation
 *
 * Triggers when a single buy is >= $5,000 from a wallet that:
 *   - has positive realized PnL over last 30d (i.e. has actually made money before)
 *   - is not a known sniper-flipper (holding_avg_minutes > 30 OR unscored / null)
 *   - has not bought this same mint in the previous 1h (so it's a fresh entry)
 *
 * Different from H6: H6 fires on tokens in their first minutes of life. H10 catches
 * mid-life tokens where someone with money quietly takes a chunk.
 *
 * If THIS triggering wallet sells, we exit immediately.
 */
export class H10WhaleQuiet implements Hypothesis {
  id = 'h10';
  describe(): string {
    return 'Single $5k+ buy from PnL-positive wallet on mid-life token, no flip pattern';
  }

  private readonly MIN_BUY_USD = 5_000;
  private readonly POSITION_SIZE_USD = 50;
  private readonly COOLDOWN_MS = 6 * 3600_000;

  private lastEntered = new Map<string, number>();

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    if (swap.amountUsd < this.MIN_BUY_USD) return null;
    const now = Date.now();
    if (now - (this.lastEntered.get(swap.baseMint) ?? 0) < this.COOLDOWN_MS) return null;

    const score = ctx.scores.get(swap.wallet);
    // We require known-good wallet (skip unknowns to avoid wash-trading bots)
    if (!score) return null;
    if (score.realizedPnl30d <= 0) return null;
    if (score.holdingAvgMinutes !== null && score.holdingAvgMinutes < 30) return null;

    // Wallet must NOT have bought this mint in the previous 1h (fresh entry)
    const sameWalletRecent = ctx.recentSwaps.some(
      (s) => s.wallet === swap.wallet && s.signature !== swap.signature,
    );
    if (sameWalletRecent) return null;

    this.lastEntered.set(swap.baseMint, now);
    return [
      buildSignal(
        this.id,
        swap.baseMint,
        'buy',
        this.POSITION_SIZE_USD,
        `whale buy $${swap.amountUsd.toFixed(0)} from wallet pnl=$${score.realizedPnl30d.toFixed(0)}, holdAvg=${score.holdingAvgMinutes ?? 'n/a'}m`,
        {
          triggerWallet: swap.wallet,
          triggerSizeUsd: swap.amountUsd,
          entryPrice: swap.priceUsd,
          hwmPrice: swap.priceUsd,
        },
      ),
    ];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as { hwmPrice?: number; triggerWallet?: string };
    const hwm = Math.max(meta.hwmPrice ?? pos.entryPriceUsd, pos.currentPriceUsd);
    meta.hwmPrice = hwm;
    const pnlPct = pos.currentPriceUsd / pos.entryPriceUsd - 1;
    const drawFromHwm = pos.currentPriceUsd / hwm - 1;
    const heldMs = Date.now() - pos.openedAt.getTime();

    // Trigger wallet exiting → emergency close
    if (meta.triggerWallet) {
      const sold = ctx.recentSwaps.some(
        (s) =>
          s.wallet === meta.triggerWallet &&
          s.side === 'sell' &&
          s.blockTime.getTime() > pos.openedAt.getTime(),
      );
      if (sold) return { reason: `trigger whale exited`, fraction: 1 };
    }

    if (pnlPct <= -0.12) return { reason: `hard stop ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    if (drawFromHwm <= -0.15 && hwm > pos.entryPriceUsd * 1.05) {
      return { reason: `trailing ${(drawFromHwm * 100).toFixed(1)}% from HWM`, fraction: 1 };
    }
    if (pos.exitsCount === 0 && pnlPct >= 0.25) {
      return { reason: `TP1 50% at +${(pnlPct * 100).toFixed(1)}%`, fraction: 0.5 };
    }
    if (pos.exitsCount === 1 && pnlPct >= 0.50) {
      return { reason: `TP2 close at +${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    }
    if (heldMs >= 36 * 3600_000) {
      return { reason: `timeout 36h at ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    }
    return null;
  }
}
