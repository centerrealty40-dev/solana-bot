import type { TwapWatchState } from './detect.js';
import { twapCancelExitDelayMinutes } from './twap-duration.js';

export type PendingWhaleExit = { exitAtMs: number; reason: string };

/** Schedule delayed close after whale TWAP cancel (not normal finish). Returns false → caller closes now. */
export function scheduleWhaleExitDelay(
  state: TwapWatchState,
  hash: string,
  reason: string,
  now = Date.now(),
): boolean {
  const delayMin = twapCancelExitDelayMinutes();
  if (delayMin <= 0) return false;

  const existing = state.pendingWhaleExitByHash.get(hash);
  if (existing) {
    if (existing.reason === 'twap_ended_feed' && reason !== 'twap_ended_feed') {
      existing.reason = reason;
    }
    return true;
  }

  state.pendingWhaleExitByHash.set(hash, {
    exitAtMs: now + delayMin * 60_000,
    reason,
  });
  return true;
}

export function clearWhaleExitPending(state: TwapWatchState, hash: string): void {
  state.pendingWhaleExitByHash.delete(hash);
}

/** Returns exit reason when delay elapsed; otherwise null. */
export function takeDueWhaleExit(
  state: TwapWatchState,
  hash: string,
  now = Date.now(),
): string | null {
  const pending = state.pendingWhaleExitByHash.get(hash);
  if (!pending || now < pending.exitAtMs) return null;
  state.pendingWhaleExitByHash.delete(hash);
  return pending.reason;
}

export function pendingWhaleExitMs(state: TwapWatchState, hash: string, now = Date.now()): number | null {
  const pending = state.pendingWhaleExitByHash.get(hash);
  if (!pending) return null;
  return Math.max(0, pending.exitAtMs - now);
}
