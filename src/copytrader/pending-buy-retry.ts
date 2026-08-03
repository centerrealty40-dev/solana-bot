import type { PendingBuy } from './state.js';

/** Eval / exec failed but we keep retrying until retryUntilTs. */
export function isPendingBuyExpired(pending: PendingBuy, nowMs: number): boolean {
  return nowMs > pending.retryUntilTs;
}

/**
 * Failures that must not be retried inside the buy window.
 *
 * A Jupiter quote already above the premium cap will not get cheaper because we
 * wait — it gets worse as the pump runs. Retrying turns the guard into a chase
 * that fills the dump (HgU5fJ88: 14 blocked quotes, then a late fill into −20%
 * while the leader closed +23% two minutes earlier).
 */
export function isBuyTerminalError(reason: string | undefined): boolean {
  if (!reason) return false;
  const m = reason.toLowerCase();
  if (m.includes('quote_premium_too_high')) return true;
  if (m.includes('buy_quote_premium_blocked')) return true;
  return false;
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
