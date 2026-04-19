import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
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

interface H3Meta extends Record<string, unknown> {
  devWallet: string;
  enteredAtMs: number;
  highWaterMark?: number;
}

/**
 * H3. Dev signal detection.
 *
 * Trigger ENTRY: dev wallet of a token (recorded in tokens.dev_wallet) BUYS its own
 * token in size > $1k after a period of inactivity (>= 24h since dev's last buy).
 * This often precedes promotional pushes / liquidity adds.
 *
 * Trigger EXIT (for any open H3 position):
 *   - dev sells >5% of dev's own balance -> close immediately (red flag)
 *   - hard stop -12%
 *   - trailing stop -18% from high
 *   - timeout 12h
 */
export class H3DevSignal implements Hypothesis {
  id = 'h3';
  describe(): string {
    return 'Dev wallet buys own token >$1k after >=24h inactivity; exits on dev sell or stops';
  }

  /** local cache: mint -> dev wallet (refreshed on demand) */
  private devCache = new Map<string, string | null>();
  /** local cache: dev -> last buy ts (ms epoch) so we can throttle */
  private devLastBuy = new Map<string, number>();

  private async getDevForMint(mint: string): Promise<string | null> {
    if (this.devCache.has(mint)) return this.devCache.get(mint) ?? null;
    const row = await db
      .select({ dev: schema.tokens.devWallet })
      .from(schema.tokens)
      .where(dsql`${schema.tokens.mint} = ${mint}`)
      .limit(1);
    const dev = row[0]?.dev ?? null;
    this.devCache.set(mint, dev);
    return dev;
  }

  onSwap(swap: NormalizedSwap, _ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    if (swap.amountUsd < 1000) return null;
    // Note: getDevForMint is async — we kick it off but cannot await here.
    // To keep onSwap synchronous (per the interface), we use a fire-and-forget pattern
    // and only emit signals from the cached dev mapping. First-time tokens skip.
    const cachedDev = this.devCache.get(swap.baseMint);
    if (cachedDev === undefined) {
      void this.getDevForMint(swap.baseMint);
      return null;
    }
    if (!cachedDev || cachedDev !== swap.wallet) return null;
    const last = this.devLastBuy.get(swap.wallet) ?? 0;
    const since = swap.blockTime.getTime() - last;
    if (since < 24 * 3600_000) return null;
    this.devLastBuy.set(swap.wallet, swap.blockTime.getTime());

    const sizeUsd = Math.min(config.maxPositionUsd, 50);
    const meta: H3Meta = {
      devWallet: swap.wallet,
      enteredAtMs: Date.now(),
    };
    const reason = `dev ${swap.wallet.slice(0, 6)} bought ${swap.amountUsd.toFixed(0)}usd of own token after ${(since / 3600_000).toFixed(1)}h`;
    return [buildSignal(this.id, swap.baseMint, 'buy', sizeUsd, reason, meta)];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as H3Meta;
    const ageMs = ctx.now.getTime() - pos.openedAt.getTime();
    if (ageMs > 12 * 3600_000) return { reason: 'timeout 12h', fraction: 1 };
    const ratio = pos.currentPriceUsd / pos.entryPriceUsd;
    if (ratio <= 0.88) return { reason: 'hard stop -12%', fraction: 1 };
    const hwm = (meta.highWaterMark as number | undefined) ?? pos.entryPriceUsd;
    const newHwm = Math.max(hwm, pos.currentPriceUsd);
    if (newHwm !== hwm) meta.highWaterMark = newHwm;
    if (pos.currentPriceUsd <= newHwm * 0.82) {
      return { reason: 'trailing stop -18% from HWM', fraction: 1 };
    }
    // dev sell since open?
    for (const s of ctx.recentSwaps) {
      if (s.side !== 'sell') continue;
      if (s.blockTime.getTime() < pos.openedAt.getTime()) continue;
      if (s.wallet === meta.devWallet) {
        return { reason: 'dev sold', fraction: 1 };
      }
    }
    return null;
  }
}
