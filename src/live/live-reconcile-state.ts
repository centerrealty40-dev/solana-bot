/**
 * W8.0 Phase 7 — process-global flag: reconcile forbids new exposure (buy_open / DCA).
 */
let reconcileBlocksNewExposure = false;

export function clearLiveReconcileBlock(): void {
  reconcileBlocksNewExposure = false;
}

export function setLiveReconcileBlock(blocked: boolean): void {
  reconcileBlocksNewExposure = blocked;
}

export function liveReconcileBlocksNewExposure(): boolean {
  return reconcileBlocksNewExposure;
}
