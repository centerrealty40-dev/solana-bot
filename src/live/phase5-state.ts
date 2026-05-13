/**
 * W8.0 Phase 5 — mutable counters shared with Phase 4 execution (simulate consec failures).
 */

let consecSimFail = 0;

/** Terminal sim_err after execution_attempt (buy/sell). */
export function notifyLiveExecutionSimErr(): void {
  consecSimFail += 1;
}

/**
 * Transient quote / route misses must not trip `LIVE_KILL_AFTER_CONSEC_FAIL` (global new-buy block).
 * Only count failures that indicate a broken or rejected on-chain simulation path.
 */
export function notifyLiveExecutionSimErrForTerminal(message?: string): void {
  const m = String(message ?? '').trim();
  if (m === 'no_quote') return;
  if (m.startsWith('quote_stale')) return;
  notifyLiveExecutionSimErr();
}

export function notifyLiveExecutionSimOk(): void {
  consecSimFail = 0;
}

export function liveConsecSimFailCount(): number {
  return consecSimFail;
}

/** Vitest only — resets module counter. */
export function resetLivePhase5Counters(): void {
  consecSimFail = 0;
}
