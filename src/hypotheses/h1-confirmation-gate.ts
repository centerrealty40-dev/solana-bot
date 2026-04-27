import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { getWatchlistWallets } from '../core/db/repository.js';
import {
  type ExitSignal,
  type Hypothesis,
  type HypothesisPositionView,
  type HypothesisSignal,
  type MarketCtx,
  type NormalizedSwap,
  buildSignal,
} from './base.js';

const log = child('h1-confirmation-gate');

interface H1Meta extends Record<string, unknown> {
  triggerWallets: string[];
  windowMs: number;
  /** when we entered, in ms epoch */
  enteredAtMs: number;
  /** trailing stop high-water mark for the position */
  highWaterMark?: number;
}

/**
 * H1. Confirmation gate copy.
 *
 * Trigger: 2+ wallets from our watchlist BUY the same token within a 10-minute
 * window, AND at least one of them has realized 30d PnL >= $50k.
 *
 * Position size: 5% of MAX_POSITION_USD (i.e. capped by config).
 *
 * Exit:
 *   - trailing stop: drop 15% from high-water mark since entry -> close
 *   - hard stop:     -10% from entry -> close
 *   - one of the triggering wallets sells -> close immediately
 *   - timeout: 24h -> close
 */
export class H1ConfirmationGate implements Hypothesis {
  id = 'h1';
  describe(): string {
    return 'Confirmation gate copy: 2+ watchlist wallets buying same token within 10 min, with one >$50k realized PnL';
  }

  private watchlist: Set<string> = new Set();
  private readonly windowMs = 10 * 60_000;

  async init(): Promise<void> {
    const list = await getWatchlistWallets();
    this.watchlist = new Set(list);
    log.info({ size: this.watchlist.size }, 'watchlist loaded');
  }

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    if (!this.watchlist.has(swap.wallet)) return null;
    if (swap.amountUsd < 100) return null; // ignore dust from watchlist

    // Find other watchlist BUYs on the same token within window
    const cutoff = swap.blockTime.getTime() - this.windowMs;
    const cohort = new Set<string>([swap.wallet]);
    let bigPnlPresent = false;
    const myScore = ctx.scores.get(swap.wallet);
    if (myScore && myScore.realizedPnl30d >= 50_000) bigPnlPresent = true;
    for (const s of ctx.recentSwaps) {
      if (s.signature === swap.signature) continue;
      if (s.side !== 'buy') continue;
      if (s.blockTime.getTime() < cutoff) continue;
      if (!this.watchlist.has(s.wallet)) continue;
      cohort.add(s.wallet);
      const sc = ctx.scores.get(s.wallet);
      if (sc && sc.realizedPnl30d >= 50_000) bigPnlPresent = true;
    }

    if (cohort.size < 2 || !bigPnlPresent) return null;

    const sizeUsd = Math.min(config.maxPositionUsd, 50);
    const meta: H1Meta = {
      triggerWallets: Array.from(cohort),
      windowMs: this.windowMs,
      enteredAtMs: Date.now(),
    };
    const reason = `cohort=${cohort.size}, bigPnL present, mint=${swap.baseMint}`;
    return [buildSignal(this.id, swap.baseMint, 'buy', sizeUsd, reason, meta)];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as H1Meta;
    const now = ctx.now.getTime();
    const ageMs = now - pos.openedAt.getTime();

    // 24h timeout
    if (ageMs > 24 * 3600_000) {
      return { reason: 'timeout 24h', fraction: 1 };
    }
    // hard stop
    const ratio = pos.currentPriceUsd / pos.entryPriceUsd;
    if (ratio <= 0.9) {
      return { reason: 'hard stop -10%', fraction: 1 };
    }
    // trailing stop: track high-water mark in meta
    const hwm = (meta.highWaterMark as number | undefined) ?? pos.entryPriceUsd;
    const newHwm = Math.max(hwm, pos.currentPriceUsd);
    if (newHwm !== hwm) meta.highWaterMark = newHwm;
    if (pos.currentPriceUsd <= newHwm * 0.85) {
      return { reason: 'trailing stop -15% from HWM', fraction: 1 };
    }
    // any trigger wallet sold -> exit
    const triggerSet = new Set(meta.triggerWallets);
    for (const s of ctx.recentSwaps) {
      if (s.side !== 'sell') continue;
      if (s.blockTime.getTime() < pos.openedAt.getTime()) continue;
      if (triggerSet.has(s.wallet)) {
        return { reason: `trigger wallet ${s.wallet.slice(0, 6)} sold`, fraction: 1 };
      }
    }
    return null;
  }
}
