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
 * H11 — Holder Velocity Surge
 *
 * Triggers when a token has 25+ DISTINCT buyer wallets in the last 10 minutes,
 * average buy size between $50 and $1,000 (organic retail discovery, not whale-driven),
 * and no single wallet accounts for >40% of total buy volume in the window
 * (filters out one-wallet pump manipulation).
 *
 * The thesis: organic retail attention is rare and signals real virality. Even if
 * the move is short-lived, the velocity itself is monetizable via a quick momentum
 * trade.
 */
export class H11HolderVelocity implements Hypothesis {
  id = 'h11';
  describe(): string {
    return '25+ distinct buyers in 10m, organic retail size, no single-wallet dominance';
  }

  private readonly POSITION_SIZE_USD = 50;
  private readonly MIN_DISTINCT_BUYERS = 25;
  private readonly MIN_AVG_BUY = 50;
  private readonly MAX_AVG_BUY = 1_000;
  private readonly MAX_SINGLE_WALLET_SHARE = 0.40;
  private readonly COOLDOWN_MS = 4 * 3600_000;
  private readonly THROTTLE_MS = 60_000;

  private lastChecked = new Map<string, number>();
  private lastEntered = new Map<string, number>();

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    const mint = swap.baseMint;
    const now = Date.now();
    if (now - (this.lastChecked.get(mint) ?? 0) < this.THROTTLE_MS) return null;
    this.lastChecked.set(mint, now);
    if (now - (this.lastEntered.get(mint) ?? 0) < this.COOLDOWN_MS) return null;

    const cutoff = now - 10 * 60_000;
    const buyersVol = new Map<string, number>();
    let totalBuyVol = 0;
    let totalBuyCount = 0;
    for (const s of ctx.recentSwaps) {
      if (s.side !== 'buy') continue;
      if (s.blockTime.getTime() < cutoff) continue;
      buyersVol.set(s.wallet, (buyersVol.get(s.wallet) ?? 0) + s.amountUsd);
      totalBuyVol += s.amountUsd;
      totalBuyCount += 1;
    }
    if (buyersVol.size < this.MIN_DISTINCT_BUYERS) return null;
    if (totalBuyCount === 0) return null;
    const avgBuy = totalBuyVol / totalBuyCount;
    if (avgBuy < this.MIN_AVG_BUY || avgBuy > this.MAX_AVG_BUY) return null;
    let topShare = 0;
    for (const v of buyersVol.values()) {
      const share = v / totalBuyVol;
      if (share > topShare) topShare = share;
    }
    if (topShare > this.MAX_SINGLE_WALLET_SHARE) return null;

    this.lastEntered.set(mint, now);
    return [
      buildSignal(
        this.id,
        mint,
        'buy',
        this.POSITION_SIZE_USD,
        `${buyersVol.size} unique buyers / 10m, avg $${avgBuy.toFixed(0)}, top wallet share ${(topShare * 100).toFixed(0)}%`,
        {
          entryPrice: swap.priceUsd,
          hwmPrice: swap.priceUsd,
          triggerBuyers: buyersVol.size,
          triggerAvgBuy: avgBuy,
        },
      ),
    ];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as { hwmPrice?: number; triggerBuyers?: number };
    const hwm = Math.max(meta.hwmPrice ?? pos.entryPriceUsd, pos.currentPriceUsd);
    meta.hwmPrice = hwm;
    const pnlPct = pos.currentPriceUsd / pos.entryPriceUsd - 1;
    const drawFromHwm = pos.currentPriceUsd / hwm - 1;
    const heldMs = Date.now() - pos.openedAt.getTime();

    // Velocity dropped to <30% of trigger level → momentum dying, take half off
    if (pos.exitsCount === 0 && meta.triggerBuyers && meta.triggerBuyers > 0) {
      const cutoff = Date.now() - 10 * 60_000;
      const buyers = new Set<string>();
      for (const s of ctx.recentSwaps) {
        if (s.side === 'buy' && s.blockTime.getTime() >= cutoff) buyers.add(s.wallet);
      }
      if (buyers.size < meta.triggerBuyers * 0.3 && pnlPct >= 0.05) {
        return { reason: `velocity decay (${buyers.size} vs trigger ${meta.triggerBuyers})`, fraction: 0.5 };
      }
    }

    if (pnlPct <= -0.10) return { reason: `hard stop ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    if (drawFromHwm <= -0.12 && hwm > pos.entryPriceUsd * 1.05) {
      return { reason: `trailing ${(drawFromHwm * 100).toFixed(1)}% from HWM`, fraction: 1 };
    }
    if (pos.exitsCount === 0 && pnlPct >= 0.30) {
      return { reason: `TP 50% at +${(pnlPct * 100).toFixed(1)}%`, fraction: 0.5 };
    }
    if (heldMs >= 8 * 3600_000) {
      return { reason: `timeout 8h at ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    }
    return null;
  }
}
