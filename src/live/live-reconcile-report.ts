/**
 * W8.0 Phase 7 — append-only `live_reconcile_report` JSONL row (`liveSchema: 2`).
 * Legacy name; payload is boot diagnostics + optional tx-anchor sample (SPL journal reconcile removed).
 */
import type { TxAnchorSampleResult } from './reconcile-tx-anchor-sample.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';

export type LiveReconcileReportRec = {
  mismatches?: Array<{ mint: string; expectedRaw: string; actualRaw: string; note?: string }>;
  walletSolLamports?: string | null;
  chainOnlyMints?: string[];
};

export function appendLiveReconcileReportJsonl(args: {
  reconcileStatus: 'ok' | 'mismatch' | 'rpc_fail' | 'skipped';
  ok: boolean;
  skipReason?: string;
  rec?: LiveReconcileReportRec | null;
  journalReplayTruncated?: boolean;
  txAnchorSample?: TxAnchorSampleResult;
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
