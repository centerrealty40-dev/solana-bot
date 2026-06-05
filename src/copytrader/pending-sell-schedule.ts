import type { CopyTraderConfig } from './config.js';
import { appendCopyEvent } from './executor.js';
import { randomMirrorActionDelayMs } from './mirror-delays.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { isFullCloseFraction } from './proportional.js';
import { newId, type CopyTraderState, type PendingSell } from './state.js';
import type { CoalescedSell } from './exit-coalesce.js';

export type ScheduleSellArgs = {
  cfg: CopyTraderConfig;
  state: CopyTraderState;
  mint: string;
  symbol: string;
  leaderSignature: string;
  leaderSellTs: number;
  fraction: number;
  leaderSellFraction: number;
  leaderPriceUsd: number;
  coalesce?: CoalescedSell;
  sweepReason?: string;
};

export function schedulePendingSell(args: ScheduleSellArgs): PendingSell {
  const {
    cfg,
    state,
    mint,
    symbol,
    leaderSignature,
    leaderSellTs,
    fraction,
    leaderSellFraction,
    leaderPriceUsd,
    coalesce,
    sweepReason,
  } = args;

  let cancelledCount = 0;
  if (coalesce?.coalesced || sweepReason) {
    const removed = cancelPendingSellsForMint(state, mint);
    cancelledCount = removed.length;
    if (cancelledCount > 0) {
      appendCopyEvent(cfg, {
        kind: 'sell_coalesced',
        mint,
        symbol,
        leaderSignature,
        cancelledPending: cancelledCount,
        reason: coalesce?.reason ?? sweepReason,
        ourSellFraction: 1,
      });
    }
  }

  const delayMs = randomMirrorActionDelayMs(cfg);
  const dueTs = Date.now() + delayMs;
  const pending: PendingSell = {
    id: newId('ps'),
    mint,
    symbol,
    leaderSignature,
    leaderSellTs,
    dueTs,
    fraction,
    leaderSellFraction,
    leaderPriceUsd: leaderPriceUsd > 0 ? leaderPriceUsd : undefined,
    retryUntilTs: computeRetryUntilTs(dueTs, cfg.sellRetryWindowMs),
  };
  state.pendingSells.push(pending);

  appendCopyEvent(cfg, {
    kind: sweepReason ? 'leader_flat_sweep_scheduled' : 'leader_sell_scheduled',
    mint,
    symbol,
    leaderSignature,
    leaderSellFraction,
    leaderPriceUsd: leaderPriceUsd > 0 ? leaderPriceUsd : null,
    ourSellFraction: fraction,
    sellDueTs: pending.dueTs,
    sellDelayMs: delayMs,
    coalesced: coalesce?.coalesced ?? Boolean(sweepReason),
    cancelledPending: cancelledCount > 0 ? cancelledCount : undefined,
    sweepReason,
  });

  return pending;
}

export function hasFullExitPending(state: CopyTraderState, mint: string): boolean {
  return state.pendingSells.some((p) => p.mint === mint && isFullCloseFraction(p.fraction));
}
