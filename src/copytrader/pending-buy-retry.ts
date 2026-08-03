import type { PendingBuy } from './state.js';

/** Eval / exec failed but we keep retrying until retryUntilTs. */
export function isPendingBuyExpired(pending: PendingBuy, nowMs: number): boolean {
  return nowMs > pending.retryUntilTs;
}

export function shouldLogBuyDefer(pending: PendingBuy, nowMs: number, intervalMs: number): boolean {
  if (!(intervalMs > 0)) return true;
  const last = pending.lastDeferLogTs ?? 0;
  return nowMs - last >= intervalMs;
}

export function computeRetryUntilTs(dueTs: number, retryWindowMs: number): number {
  return dueTs + Math.max(0, retryWindowMs);
}

export function findPendingBuy(state: { pendingBuys: PendingBuy[] }, id: string): PendingBuy | undefined {
  return state.pendingBuys.find((p) => p.id === id);
}

export function removePendingBuyById(state: { pendingBuys: PendingBuy[] }, id: string): PendingBuy | undefined {
  const idx = state.pendingBuys.findIndex((p) => p.id === id);
  if (idx < 0) return undefined;
  const [removed] = state.pendingBuys.splice(idx, 1);
  return removed;
}

export function cancelPendingBuysForMint(
  state: { pendingBuys: PendingBuy[] },
  mint: string,
  kind: 'entry' | 'add' | 'any',
): PendingBuy[] {
  const removed: PendingBuy[] = [];
  state.pendingBuys = state.pendingBuys.filter((p) => {
    if (p.mint !== mint) return true;
    if (kind !== 'any' && p.kind !== kind) return true;
    removed.push(p);
    return false;
  });
  return removed;
}

/** Leader sold (partial or full) since we queued the buy. */
export function leaderHoldingsShrunkSinceSignal(signalRaw: bigint, ledgerNow: bigint): boolean {
  return signalRaw > 0n && ledgerNow < signalRaw;
}
