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

/** Transient sell failures: retry with bumped slippage until window ends or fill confirms. */
export function isSellRetryableError(reason: string | undefined): boolean {
  if (!reason) return false;
  if (isSlippageClassSimError(reason)) return true;
  const m = reason.toLowerCase();
  if (m.includes('confirm_timeout')) return true;
  if (m.includes('send_failed') && (m.includes('429') || m.includes('timeout'))) return true;
  if (m.includes('sim_failed') || m.includes('sim_err')) return true;
  if (m.includes('rpc_error') && m.includes('simulation failed')) return true;
  if (m.includes('custom":6024') || m.includes('custom\':6024')) return true;
  return false;
}

export function nextSellSlippageBps(args: {
  baseBps: number;
  currentBps: number | undefined;
  bumpBps: number;
  maxBps: number;
}): number {
  const { baseBps, currentBps, bumpBps, maxBps } = args;
  const next = (currentBps ?? baseBps) + bumpBps;
  return Math.min(maxBps, Math.max(baseBps, next));
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
