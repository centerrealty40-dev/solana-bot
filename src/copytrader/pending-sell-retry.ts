import { isSlippageClassSimError } from '../live/phase4-execution.js';
import type { PendingSell } from './state.js';

export function isPendingSellExpired(pending: PendingSell, nowMs: number): boolean {
  return nowMs > pending.retryUntilTs;
}

/**
 * No venue will route this size right now — as opposed to a slippage rejection,
 * where the trade is routable and a moving price may let the next attempt fill.
 * Worth separating: retrying a missing route is pure waste, retrying slippage is not.
 */
export function isUnroutableSellError(reason: string | undefined): boolean {
  if (!reason) return false;
  const m = reason.toLowerCase();
  if (m.includes('jupiter_sell_quote_failed')) return true;
  if (m.startsWith('no_quote')) return true;
  if (m.startsWith('swap_build')) return true;
  if (m.includes('route_not_found')) return true;
  return false;
}

/** Attempt budget is separate from the time window — see `sellMaxAttempts`. */
export function isPendingSellExhausted(pending: PendingSell, maxAttempts: number): boolean {
  if (!(maxAttempts > 0)) return false;
  return (pending.attempts ?? 0) >= maxAttempts;
}

/**
 * Exponential backoff, capped. A venue that cannot quote a balance now will not
 * quote it 3 seconds later either; spacing attempts out keeps a stuck mint from
 * monopolising the sell loop.
 */
export function nextSellRetryDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  if (!(maxMs > 0)) return baseMs;
  const factor = 2 ** Math.max(0, Math.min(attempts - 1, 10));
  return Math.min(maxMs, Math.round(baseMs * factor));
}

export function shouldLogSellDefer(pending: PendingSell, nowMs: number, intervalMs: number): boolean {
  if (!(intervalMs > 0)) return true;
  const last = pending.lastDeferLogTs ?? 0;
  return nowMs - last >= intervalMs;
}

/** Transient sell failures: retry with same bps until window ends or fill confirms. */
export function isSellRetryableError(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason === 'no_token_balance') return false;
  if (isSlippageClassSimError(reason)) return true;
  // Align with live-oscar sell pipeline: all pre-broadcast sim/quote failures are retryable.
  if (reason.startsWith('sim_failed:') || reason.includes('InstructionError')) return true;
  if (reason.startsWith('quote_stale')) return true;
  if (reason === 'no_quote' || reason.startsWith('no_quote')) return true;
  if (reason === 'swap_build' || reason.startsWith('swap_build')) return true;
  const m = reason.toLowerCase();
  if (m.includes('confirm_timeout')) return true;
  if (m.includes('swap-http-429') || m.includes('swap_http_429')) return true;
  if (m.includes('send_failed') && (m.includes('429') || m.includes('timeout'))) return true;
  if (m.includes('jupiter_sell_quote_failed')) return true;
  // A throttled provider says "later", not "never" — dropping the sell here
  // leaves the exit unfilled until the policy happens to re-arm.
  if (m.includes('too many requests') || m.includes('rate limit')) return true;
  if (m.startsWith('qn_rate')) return true;
  return false;
}

export function findPendingSell(state: { pendingSells: PendingSell[] }, id: string): PendingSell | undefined {
  return state.pendingSells.find((p) => p.id === id);
}

export function removePendingSellById(
  state: { pendingSells: PendingSell[] },
  id: string,
): PendingSell | undefined {
  const idx = state.pendingSells.findIndex((p) => p.id === id);
  if (idx < 0) return undefined;
  const [removed] = state.pendingSells.splice(idx, 1);
  return removed;
}

export function cancelPendingSellsForMint(state: { pendingSells: PendingSell[] }, mint: string): PendingSell[] {
  const removed: PendingSell[] = [];
  state.pendingSells = state.pendingSells.filter((p) => {
    if (p.mint !== mint) return true;
    removed.push(p);
    return false;
  });
  return removed;
}
