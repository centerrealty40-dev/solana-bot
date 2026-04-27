import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
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

interface H6Meta extends Record<string, unknown> {
  triggerWallet: string;
  enteredAtMs: number;
  highWaterMark?: number;
}

/**
 * H6. Snipe-then-hold detection.
 *
 * Trigger: a wallet that bought a token within the first 30s of token's first observed
 * swap on-chain AND held for >=10 minutes (didn't dump immediately) AND is now ADDING
 * to its position (any subsequent buy). This signals an insider/conviction trader.
 *
 * Position size: small (2% of cap). The trade is a copy of an asymmetric bet.
 *
 * Exit:
 *   - the trigger wallet sells -> close
 *   - +100% take profit half
 *   - hard stop -20%
 *   - trailing stop -25% from high
 *   - timeout 24h
 */
export class H6SnipeThenHold implements Hypothesis {
  id = 'h6';
  describe(): string {
    return 'Snipe-then-hold: wallet bought token in first 30s, held >=10min, now adding';
  }

  /** local cache: (mint -> first-seen ms) */
  private firstSeen = new Map<string, number>();
  /** cache: (wallet, mint) -> { firstBuyMs, lastBuyMs, sold } */
  private state = new Map<string, { firstBuyMs: number; lastBuyMs: number; sold: boolean }>();

  private key(w: string, m: string): string {
    return `${w}:${m}`;
  }

  private async getFirstSeen(mint: string): Promise<number> {
    if (this.firstSeen.has(mint)) return this.firstSeen.get(mint)!;
    try {
      const rows = await db.execute(dsql`
        SELECT EXTRACT(EPOCH FROM MIN(block_time)) * 1000 AS first_ms
        FROM swaps WHERE base_mint = ${mint}
      `);
      const ms = Number(((rows as unknown as Array<{ first_ms: number | string | null }>)[0]?.first_ms) ?? 0);
      this.firstSeen.set(mint, ms);
      return ms;
    } catch {
      // DB unavailable (tests, transient network) — return 0 so caller treats as unknown
      return 0;
    }
  }

  onSwap(swap: NormalizedSwap, _ctx: MarketCtx): HypothesisSignal[] | null {
    const k = this.key(swap.wallet, swap.baseMint);
    const cur = this.state.get(k);
    if (swap.side === 'sell') {
      if (cur) cur.sold = true;
      return null;
    }
    // buy
    if (!cur) {
      // first-ever buy by this wallet on this token
      this.state.set(k, {
        firstBuyMs: swap.blockTime.getTime(),
        lastBuyMs: swap.blockTime.getTime(),
        sold: false,
      });
      // we cannot await async DB lookup of token first-seen here, so this branch never fires;
      // we'll wait until the wallet ADDs to its position to evaluate the criterion below.
      // Trigger the cache fetch for next time.
      void this.getFirstSeen(swap.baseMint);
      return null;
    }
    // subsequent buy ("adding to position")
    const prevFirst = cur.firstBuyMs;
    cur.lastBuyMs = swap.blockTime.getTime();
    if (cur.sold) return null; // they exited at some point — disqualified
    const tokenFirst = this.firstSeen.get(swap.baseMint);
    if (!tokenFirst) {
      void this.getFirstSeen(swap.baseMint);
      return null;
    }
    const earliness = prevFirst - tokenFirst;
    if (earliness > 30_000) return null;
    const heldMs = swap.blockTime.getTime() - prevFirst;
    if (heldMs < 10 * 60_000) return null;

    const sizeUsd = Math.min(config.maxPositionUsd, 25);
    const meta: H6Meta = {
      triggerWallet: swap.wallet,
      enteredAtMs: Date.now(),
    };
    const reason = `wallet ${swap.wallet.slice(0, 6)} sniped within ${(earliness / 1000).toFixed(0)}s, held ${(heldMs / 60_000).toFixed(0)}min, now adding`;
    return [buildSignal(this.id, swap.baseMint, 'buy', sizeUsd, reason, meta)];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as H6Meta;
    const ageMs = ctx.now.getTime() - pos.openedAt.getTime();
    if (ageMs > 24 * 3600_000) return { reason: 'timeout 24h', fraction: 1 };
    const ratio = pos.currentPriceUsd / pos.entryPriceUsd;
    if (ratio <= 0.8) return { reason: 'hard stop -20%', fraction: 1 };
    const hwm = (meta.highWaterMark as number | undefined) ?? pos.entryPriceUsd;
    const newHwm = Math.max(hwm, pos.currentPriceUsd);
    if (newHwm !== hwm) meta.highWaterMark = newHwm;
    if (pos.currentPriceUsd <= newHwm * 0.75) {
      return { reason: 'trailing stop -25% from HWM', fraction: 1 };
    }
    if (ratio >= 2 && pos.exitsCount === 0) {
      return { reason: '+100% TP, half exit', fraction: 0.5 };
    }
    for (const s of ctx.recentSwaps) {
      if (s.side !== 'sell') continue;
      if (s.blockTime.getTime() < pos.openedAt.getTime()) continue;
      if (s.wallet === meta.triggerWallet) {
        return { reason: 'trigger wallet sold', fraction: 1 };
      }
    }
    return null;
  }
}
