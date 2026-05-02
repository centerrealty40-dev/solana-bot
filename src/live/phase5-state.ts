/**
 * W8.0 Phase 5 — mutable counters shared with Phase 4 execution (simulate consec failures).
 */

let consecSimFail = 0;

/** Terminal sim_err after execution_attempt (buy/sell). */
export function notifyLiveExecutionSimErr(): void {
  consecSimFail += 1;
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
