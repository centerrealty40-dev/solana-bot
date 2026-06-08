import { isSlippageClassSimError } from '../live/phase4-execution.js';
import type { PendingSell } from './state.js';

export function isPendingSellExpired(pending: PendingSell, nowMs: number): boolean {
  return nowMs > pending.retryUntilTs;
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
