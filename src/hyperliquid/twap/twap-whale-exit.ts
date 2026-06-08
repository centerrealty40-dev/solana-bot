import type { TwapWatchState } from './detect.js';
import type { NormalizedTwapSignal, TwapSide } from './types.js';
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

/**
 * Whale cancelled then started a new TWAP on the same coin (same side) — keep position, drop delayed exit.
 * Returns cleared position hashes.
 */
export function abortWhaleExitOnRestart(
  state: TwapWatchState,
  newSig: Pick<NormalizedTwapSignal, 'user' | 'coin' | 'displaySymbol'>,
  opens: Array<{ hash: string; whaleUser: string; coin: string; side: TwapSide }>,
  ourEntrySide: TwapSide,
): string[] {
  const whale = newSig.user.toLowerCase();
  const cleared: string[] = [];
  for (const pos of opens) {
    if (pos.coin !== newSig.coin) continue;
    if (pos.whaleUser.toLowerCase() !== whale) continue;
    if (pos.side !== ourEntrySide) continue;
    if (!state.pendingWhaleExitByHash.has(pos.hash)) continue;
    clearWhaleExitPending(state, pos.hash);
    cleared.push(pos.hash);
  }
  return cleared;
}
