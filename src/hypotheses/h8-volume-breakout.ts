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
 * H8 — Volume Spike Breakout
 *
 * Pure technical / momentum hypothesis. No wallet scoring, no watchlist.
 * Triggers when both happen on the same swap event:
 *   1. Buy-volume in the last 5 minutes is at least 4× the average per-5min of the
 *      preceding hour (i.e. the trailing 11 5-min buckets, excluding the current one).
 *   2. The current price is the highest seen in the last 60 minutes (new local ATH).
 *
 * This catches the moment a sleeping token wakes up — useful in any market regime.
 * Position: $50 (base), exits are tight (momentum dies fast).
 */
export class H8VolumeBreakout implements Hypothesis {
  id = 'h8';
  describe(): string {
    return 'Volume spike (4× baseline) + new 1h price high — pure momentum breakout';
  }

  private readonly POSITION_SIZE_USD = 50;
  private readonly SPIKE_MULT = 4;
  private readonly MIN_RECENT_BUYS = 5;
  private readonly MIN_BASELINE_BUYS = 10;
  private readonly COOLDOWN_MS = 4 * 3600_000;
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

    const cutoffNew = now - 5 * 60_000;
    const cutoffOld = now - 60 * 60_000;
    let recentBuyVol = 0;
    let recentBuys = 0;
    let baselineBuyVol = 0;
    let baselineBuys = 0;
    let maxPriceLastHour = 0;
    for (const s of ctx.recentSwaps) {
      const ts = s.blockTime.getTime();
      if (ts < cutoffOld) continue;
      if (s.priceUsd > maxPriceLastHour) maxPriceLastHour = s.priceUsd;
      if (s.side !== 'buy') continue;
      if (ts >= cutoffNew) {
        recentBuyVol += s.amountUsd;
        recentBuys += 1;
      } else {
        baselineBuyVol += s.amountUsd;
        baselineBuys += 1;
      }
    }
    if (recentBuys < this.MIN_RECENT_BUYS) return null;
    if (baselineBuys < this.MIN_BASELINE_BUYS) return null;
    // 11 baseline buckets of 5min => avg-per-5min = baselineBuyVol / 11
    const baselineAvgPer5min = baselineBuyVol / 11;
    if (baselineAvgPer5min <= 0) return null;
    const ratio = recentBuyVol / baselineAvgPer5min;
    if (ratio < this.SPIKE_MULT) return null;
    if (swap.priceUsd < maxPriceLastHour * 0.999) return null;

    this.lastEntered.set(mint, now);
    return [
      buildSignal(
        this.id,
        mint,
        'buy',
        this.POSITION_SIZE_USD,
        `vol spike ×${ratio.toFixed(1)} (5m=$${recentBuyVol.toFixed(0)} vs baseline avg $${baselineAvgPer5min.toFixed(0)}) at new 1h ATH`,
        { entryPrice: swap.priceUsd, hwmPrice: swap.priceUsd, triggerVolRatio: ratio },
      ),
    ];
  }

  shouldExit(pos: HypothesisPositionView): ExitSignal | null {
    const meta = pos.signalMeta as { hwmPrice?: number };
    const hwm = Math.max(meta.hwmPrice ?? pos.entryPriceUsd, pos.currentPriceUsd);
    meta.hwmPrice = hwm;
    const pnlPct = pos.currentPriceUsd / pos.entryPriceUsd - 1;
    const drawFromHwm = pos.currentPriceUsd / hwm - 1;
    const heldMs = Date.now() - pos.openedAt.getTime();

    if (pnlPct <= -0.10) return { reason: `hard stop ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    if (drawFromHwm <= -0.10 && hwm > pos.entryPriceUsd * 1.05) {
      return { reason: `trailing ${(drawFromHwm * 100).toFixed(1)}% from HWM`, fraction: 1 };
    }
    if (pos.exitsCount === 0 && pnlPct >= 0.20) {
      return { reason: `TP 50% at +${(pnlPct * 100).toFixed(1)}%`, fraction: 0.5 };
    }
    if (heldMs >= 4 * 3600_000) {
      return { reason: `timeout 4h`, fraction: 1 };
    }
    return null;
  }
}
