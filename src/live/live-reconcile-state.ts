/**
 * W8.0 Phase 7 — process-global flag: reconcile forbids new exposure (buy_open / DCA).
 */
let reconcileBlocksNewExposure = false;

/** Last boot replay/reconcile outcome for heartbeat JSONL (dashboard / ops). */
export type LiveReconcileBootSnapshot = {
  status: 'ok' | 'mismatch' | 'rpc_fail' | 'skipped';
  skipReason?: string;
  divergentMints?: string[];
  walletSolLamports?: string | null;
  chainOnlyMints?: string[];
  journalTruncated?: boolean;
};

let bootSnapshot: LiveReconcileBootSnapshot | null = null;

export function setLiveReconcileBootSnapshot(s: LiveReconcileBootSnapshot | null): void {
  bootSnapshot = s;
}

export function getLiveReconcileBootSnapshot(): LiveReconcileBootSnapshot | null {
  return bootSnapshot;
}

export function clearLiveReconcileBlock(): void {
  reconcileBlocksNewExposure = false;
}

export function setLiveReconcileBlock(blocked: boolean): void {
  reconcileBlocksNewExposure = blocked;
}

export function liveReconcileBlocksNewExposure(): boolean {
  return reconcileBlocksNewExposure;
}
