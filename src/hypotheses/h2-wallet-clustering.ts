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

interface H2Meta extends Record<string, unknown> {
  clusterId: string;
  clusterWallets: string[];
  enteredAtMs: number;
  highWaterMark?: number;
}

/**
 * H2. Wallet clustering / entity detection.
 *
 * Trigger: a single cluster (entity) buys the same token from 3+ different wallets
 * within a 5-minute window. Cluster ids come from the scoring engine's Louvain pass.
 *
 * This is rare but high quality: an entity rarely advertises itself publicly.
 *
 * Position size: 5% of MAX_POSITION_USD (capped). Use slightly bigger than H1
 * since the signal is rarer.
 *
 * Exit:
 *   - any cluster wallet sells -> close
 *   - trailing stop -20% from high
 *   - hard stop -12%
 *   - timeout 6h
 */
export class H2WalletClustering implements Hypothesis {
  id = 'h2';
  describe(): string {
    return 'Entity buy: 3+ wallets from one Louvain cluster buying same token within 5 min';
  }

  private readonly windowMs = 5 * 60_000;

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    if (swap.amountUsd < 100) return null;
    const myScore = ctx.scores.get(swap.wallet);
    if (!myScore?.clusterId) return null;
    const clusterId = myScore.clusterId;

    const cutoff = swap.blockTime.getTime() - this.windowMs;
    const sameClusterWallets = new Set<string>([swap.wallet]);
    for (const s of ctx.recentSwaps) {
      if (s.signature === swap.signature) continue;
      if (s.side !== 'buy') continue;
      if (s.blockTime.getTime() < cutoff) continue;
      const sc = ctx.scores.get(s.wallet);
      if (sc?.clusterId === clusterId) sameClusterWallets.add(s.wallet);
    }
    if (sameClusterWallets.size < 3) return null;

    const sizeUsd = Math.min(config.maxPositionUsd, 75);
    const meta: H2Meta = {
      clusterId,
      clusterWallets: Array.from(sameClusterWallets),
      enteredAtMs: Date.now(),
    };
    const reason = `cluster=${clusterId} wallets=${sameClusterWallets.size} mint=${swap.baseMint}`;
    return [buildSignal(this.id, swap.baseMint, 'buy', sizeUsd, reason, meta)];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as H2Meta;
    const ageMs = ctx.now.getTime() - pos.openedAt.getTime();
    if (ageMs > 6 * 3600_000) return { reason: 'timeout 6h', fraction: 1 };
    const ratio = pos.currentPriceUsd / pos.entryPriceUsd;
    if (ratio <= 0.88) return { reason: 'hard stop -12%', fraction: 1 };
    const hwm = (meta.highWaterMark as number | undefined) ?? pos.entryPriceUsd;
    const newHwm = Math.max(hwm, pos.currentPriceUsd);
    if (newHwm !== hwm) meta.highWaterMark = newHwm;
    if (pos.currentPriceUsd <= newHwm * 0.8) {
      return { reason: 'trailing stop -20% from HWM', fraction: 1 };
    }
    // any cluster wallet sold? exit
    const cluster = new Set(meta.clusterWallets);
    for (const s of ctx.recentSwaps) {
      if (s.side !== 'sell') continue;
      if (s.blockTime.getTime() < pos.openedAt.getTime()) continue;
      if (cluster.has(s.wallet)) {
        return { reason: `cluster wallet ${s.wallet.slice(0, 6)} sold`, fraction: 1 };
      }
    }
    return null;
  }
}
