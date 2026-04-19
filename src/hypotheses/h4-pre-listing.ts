import { config } from '../core/config.js';
import {
  type ExitSignal,
  type Hypothesis,
  type HypothesisPositionView,
  type HypothesisSignal,
  type MarketCtx,
  type NormalizedSwap,
  buildSignal,
} from './base.js';

interface H4Meta extends Record<string, unknown> {
  accumulators: string[];
  enteredAtMs: number;
  highWaterMark?: number;
}

/**
 * H4. Pre-listing accumulation.
 *
 * Trigger: a token sees >=5 wallets with positive `early_entry_score` quietly
 * accumulating in small chunks (each buy 100..2000 USD) within the last 24h, with
 * total volume of those buys < 5% of token's 24h volume (i.e. NO visible price impact yet),
 * and price has moved less than 10% in the same window.
 *
 * Position size: small (3% of cap) since this is speculative.
 *
 * Exit:
 *   - any trigger wallet sells -> 50% exit
 *   - second one sells -> close
 *   - +50% take profit half
 *   - hard stop -15%
 *   - timeout 72h
 */
export class H4PreListing implements Hypothesis {
  id = 'h4';
  describe(): string {
    return 'Pre-listing quiet accumulation by 5+ early-entry wallets in 24h with <10% price move';
  }

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    if (swap.amountUsd < 100 || swap.amountUsd > 2000) return null;
    const myScore = ctx.scores.get(swap.wallet);
    if (!myScore || myScore.earlyEntryScore < 1) return null;

    const dayAgo = swap.blockTime.getTime() - 24 * 3600_000;
    const accumulators = new Set<string>([swap.wallet]);
    let totalAccUsd = swap.amountUsd;
    let allBuysUsd = swap.amountUsd;
    let allSellsUsd = 0;
    let oldestPrice = swap.priceUsd;
    let newestPrice = swap.priceUsd;
    let oldestTime = swap.blockTime.getTime();
    for (const s of ctx.recentSwaps) {
      if (s.signature === swap.signature) continue;
      if (s.blockTime.getTime() < dayAgo) continue;
      if (s.side === 'buy') {
        allBuysUsd += s.amountUsd;
        if (s.amountUsd >= 100 && s.amountUsd <= 2000) {
          const sc = ctx.scores.get(s.wallet);
          if (sc && sc.earlyEntryScore >= 1) {
            accumulators.add(s.wallet);
            totalAccUsd += s.amountUsd;
          }
        }
      } else {
        allSellsUsd += s.amountUsd;
      }
      if (s.blockTime.getTime() < oldestTime) {
        oldestTime = s.blockTime.getTime();
        oldestPrice = s.priceUsd;
      }
      if (s.blockTime.getTime() > swap.blockTime.getTime()) {
        newestPrice = s.priceUsd;
      }
    }
    if (accumulators.size < 5) return null;
    const volume24h = allBuysUsd + allSellsUsd;
    if (volume24h <= 0) return null;
    if (totalAccUsd / volume24h > 0.05) return null;
    const priceMove = Math.abs(newestPrice / Math.max(oldestPrice, 1e-12) - 1);
    if (priceMove > 0.1) return null;

    const sizeUsd = Math.min(config.maxPositionUsd, 30);
    const meta: H4Meta = {
      accumulators: Array.from(accumulators),
      enteredAtMs: Date.now(),
    };
    const reason = `accum=${accumulators.size} totalAcc=${totalAccUsd.toFixed(0)}usd vol24h=${volume24h.toFixed(0)} priceMove=${(priceMove * 100).toFixed(1)}%`;
    return [buildSignal(this.id, swap.baseMint, 'buy', sizeUsd, reason, meta)];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as H4Meta;
    const ageMs = ctx.now.getTime() - pos.openedAt.getTime();
    if (ageMs > 72 * 3600_000) return { reason: 'timeout 72h', fraction: 1 };
    const ratio = pos.currentPriceUsd / pos.entryPriceUsd;
    if (ratio <= 0.85) return { reason: 'hard stop -15%', fraction: 1 };
    const hwm = (meta.highWaterMark as number | undefined) ?? pos.entryPriceUsd;
    const newHwm = Math.max(hwm, pos.currentPriceUsd);
    if (newHwm !== hwm) meta.highWaterMark = newHwm;
    if (ratio >= 1.5 && pos.exitsCount === 0) {
      return { reason: '+50% TP, half exit', fraction: 0.5 };
    }
    // count accumulator sells
    const accSet = new Set(meta.accumulators);
    let sellsByAcc = 0;
    for (const s of ctx.recentSwaps) {
      if (s.side !== 'sell') continue;
      if (s.blockTime.getTime() < pos.openedAt.getTime()) continue;
      if (accSet.has(s.wallet)) sellsByAcc += 1;
    }
    if (sellsByAcc >= 2) return { reason: '2 accumulators sold', fraction: 1 };
    if (sellsByAcc === 1 && pos.exitsCount === 0) {
      return { reason: '1 accumulator sold, half exit', fraction: 0.5 };
    }
    return null;
  }
}
