import type { TwapSide } from '../types.js';
import { coinSideKey } from './coin-side-ladder.js';

/**
 * Background live exchange worker — decouples long exec-slice chains from HypurrScan poll.
 * One batch at a time; poll keeps running every HL_TWAP_POLL_INTERVAL_MS.
 */
let liveExecInFlight = false;
const coinSideOpenInFlight = new Set<string>();

export type LiveExecKickResult = 'started' | 'skipped_busy';

/** Run exchange work off the poll loop. Skips if a prior batch is still running. */
export function kickLiveExecWorker(work: () => Promise<void>): LiveExecKickResult {
  if (liveExecInFlight) return 'skipped_busy';
  liveExecInFlight = true;
  void work()
    .catch((e) => {
      console.warn('[hl-twap-live] background exec failed', String(e));
    })
    .finally(() => {
      liveExecInFlight = false;
    });
  return 'started';
}

export function isLiveExecWorkerBusy(): boolean {
  return liveExecInFlight;
}

export function markCoinSideOpenInFlight(coin: string, side: TwapSide): void {
  coinSideOpenInFlight.add(coinSideKey(coin, side));
}

export function clearCoinSideOpenInFlight(coin: string, side: TwapSide): void {
  coinSideOpenInFlight.delete(coinSideKey(coin, side));
}

export function isCoinSideOpenInFlight(coin: string, side: TwapSide): boolean {
  return coinSideOpenInFlight.has(coinSideKey(coin, side));
}

/** Test helper — reset mutex between vitest cases. */
export function resetLiveExecWorkerForTests(): void {
  liveExecInFlight = false;
  coinSideOpenInFlight.clear();
}
