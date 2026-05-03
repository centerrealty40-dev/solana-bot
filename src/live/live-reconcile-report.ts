/**
 * W8.0 Phase 7 — append-only `live_reconcile_report` JSONL row (`liveSchema: 2`).
 */
import type { LiveOscarConfig } from './config.js';
import type { ReconcileLiveWalletResult } from './reconcile-live.js';
import type { TxAnchorSampleResult } from './reconcile-tx-anchor-sample.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';

export function appendLiveReconcileReportJsonl(args: {
  liveCfg: LiveOscarConfig;
  reconcileStatus: 'ok' | 'mismatch' | 'rpc_fail' | 'skipped';
  /** SPL reconcile ok (true when skipped paths did not detect divergence). */
  ok: boolean;
  skipReason?: string;
  rec?: ReconcileLiveWalletResult | null;
  journalReplayTruncated?: boolean;
  txAnchorSample?: TxAnchorSampleResult;
  /** W8.0-p7.1 — mint prefixes excluded as ghost anchors at boot. */
  quarantinedMints?: string[];
  anchorRpcPendingMints?: string[];
}): void {
  const mismatches = args.rec?.mismatches?.length
    ? args.rec.mismatches.map((m) => ({
        mint: m.mint,
        expectedRaw: m.expectedRaw,
        actualRaw: m.actualRaw,
        ...(m.note ? { note: m.note } : {}),
      }))
    : undefined;

  appendLiveJsonlEvent({
    kind: 'live_reconcile_report',
    ok: args.ok,
    reconcileStatus: args.reconcileStatus,
    mode: args.liveCfg.liveReconcileMode,
    ...(args.skipReason ? { skipReason: args.skipReason } : {}),
    ...(mismatches ? { mismatches } : {}),
    walletSolLamports: args.rec?.walletSolLamports ?? undefined,
    chainOnlyMints: args.rec?.chainOnlyMints,
    journalReplayTruncated: args.journalReplayTruncated,
    ...(args.txAnchorSample ? { txAnchorSample: args.txAnchorSample } : {}),
    ...(args.quarantinedMints?.length ? { quarantinedMints: args.quarantinedMints } : {}),
    ...(args.anchorRpcPendingMints?.length ? { anchorRpcPendingMints: args.anchorRpcPendingMints } : {}),
  });
}
