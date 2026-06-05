import type { CopyTraderConfig } from './config.js';
import { appendCopyEvent } from './executor.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { isFullCloseFraction } from './proportional.js';
import { newId, type CopyTraderState, type PendingSell } from './state.js';
import type { CoalescedSell } from './exit-coalesce.js';

export function randomSellDelayMs(cfg: CopyTraderConfig): number {
  const min = Math.max(0, cfg.sellDelayMinMs);
  const max = Math.max(min, cfg.sellDelayMaxMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

export type ScheduleSellArgs = {
  cfg: CopyTraderConfig;
  state: CopyTraderState;
  mint: string;
  symbol: string;
  leaderSignature: string;
  leaderSellTs: number;
  fraction: number;
  leaderSellFraction: number;
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

  const delayMs = randomSellDelayMs(cfg);
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
    retryUntilTs: computeRetryUntilTs(dueTs, cfg.sellRetryWindowMs),
  };
  state.pendingSells.push(pending);

  appendCopyEvent(cfg, {
    kind: sweepReason ? 'leader_flat_sweep_scheduled' : 'leader_sell_scheduled',
    mint,
    symbol,
    leaderSignature,
    leaderSellFraction,
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
