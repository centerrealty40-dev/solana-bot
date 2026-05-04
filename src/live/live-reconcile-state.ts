/**
 * W8.0 Phase 7 — process-global flag: when set, Phase 5 forbids new exposure (buy_open / DCA).
 * Used for strict notional parity; SPL journal reconcile no longer arms this flag.
 */
let reconcileBlocksNewExposure = false;
/** Wall-clock ms when `reconcileBlocksNewExposure` first became true this stint (null if clear). */
let reconcileBlockSetAtMs: number | null = null;

/** Last boot replay/reconcile outcome for heartbeat JSONL (dashboard / ops). */
export type LiveReconcileBootSnapshot = {
  status: 'ok' | 'mismatch' | 'rpc_fail' | 'skipped';
  skipReason?: string;
  divergentMints?: string[];
  /** Legacy field; SPL reconcile orphan path removed. */
  zeroBalanceMismatchMints?: string[];
  walletSolLamports?: string | null;
  chainOnlyMints?: string[];
  journalTruncated?: boolean;
  /** W8.0-p7.1 — mint prefixes quarantined at boot (ghost anchors). */
  quarantinedMints?: string[];
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
  reconcileBlockSetAtMs = null;
}

export function setLiveReconcileBlock(blocked: boolean): void {
  reconcileBlocksNewExposure = blocked;
  if (blocked) {
    if (reconcileBlockSetAtMs === null) reconcileBlockSetAtMs = Date.now();
  } else {
    reconcileBlockSetAtMs = null;
  }
}

export function liveReconcileBlocksNewExposure(): boolean {
  return reconcileBlocksNewExposure;
}

/** Seconds since exposure block was armed; null if not blocked. */
export function liveReconcileBlockAgeSec(): number | null {
  if (!reconcileBlocksNewExposure || reconcileBlockSetAtMs === null) return null;
  return (Date.now() - reconcileBlockSetAtMs) / 1000;
}
