/**
 * W8.0-p1 — validated live JSONL event bodies (`liveSchema` envelope added at write time).
 */
import { z } from 'zod';

export const LIVE_SCHEMA_V1 = 1 as const;
/** New JSONL kinds introduced after W8.0-p1 (Phase 7 report row). */
export const LIVE_SCHEMA_V2 = 2 as const;

const ExecutionModeSchema = z.enum(['dry_run', 'simulate', 'live']);

/** Lowercase UUID v4 with hyphens (W8.0-p1 §3.3). */
export const IntentIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'intentId must be UUID v4 (lowercase)',
  );

export const LiveBootEventSchema = z.object({
  kind: z.literal('live_boot'),
  liveStrategyEnabled: z.boolean(),
  executionMode: ExecutionModeSchema,
  phase: z.string().optional(),
  profile: z.literal('oscar').optional(),
});

export const LiveShutdownEventSchema = z.object({
  kind: z.literal('live_shutdown'),
  sig: z.string().min(1),
});

export const HeartbeatEventSchema = z.object({
  kind: z.literal('heartbeat'),
  uptimeSec: z.number().int().nonnegative(),
  openPositions: z.number().int().nonnegative(),
  closedTotal: z.number().int().nonnegative(),
  liveStrategyEnabled: z.boolean(),
  executionMode: ExecutionModeSchema,
  note: z.string().optional(),
  /** W8.0 Phase 7 — boot reconcile outcome (optional; omitted on legacy writers). */
  reconcileBootStatus: z.enum(['ok', 'mismatch', 'rpc_fail', 'skipped']).optional(),
  reconcileBootSkipReason: z.string().max(160).optional(),
  reconcileMintsDivergent: z.array(z.string()).optional(),
  reconcileWalletSolLamports: z.string().optional(),
  reconcileChainOnlyMints: z.array(z.string()).optional(),
  journalReplayTruncated: z.boolean().optional(),
  /** W8.0-p7.1 — mint prefixes dropped from replay as ghost / quarantined at boot. */
  quarantinedMints: z.array(z.string()).optional(),
  /** True when Phase 5 forbids new exposure (strict notional parity / legacy flag name). */
  reconcileBlocksNewExposure: z.boolean().optional(),
  /** Seconds since exposure block was first armed (same stint); omitted when not blocked. */
  reconcileBlockAgeSec: z.number().finite().nonnegative().optional(),
});

/** Ops / diagnostics row (non-fatal); used for orphan verify deferral, reconcile TTL clear, etc. */
export const RiskNoteSchema = z.object({
  kind: z.literal('risk_note'),
  reason: z.string().min(1).max(160),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const ExecutionAttemptSchema = z.object({
  kind: z.literal('execution_attempt'),
  intentId: IntentIdSchema,
  side: z.enum(['buy', 'sell']),
  mint: z.string().min(1).max(64),
  intendedUsd: z.number().nullable().optional(),
  intendedAmountAtomic: z.string().optional(),
  sellAmountSource: z.enum(['usd_math', 'chain_full_balance', 'usd_capped_by_chain']).optional(),
  executionMode: ExecutionModeSchema,
  quoteSnapshot: z.record(z.string(), z.unknown()).optional(),
  targetPriceUsd: z.number().nullable().optional(),
});

export const ExecutionResultStatusSchema = z.enum(['sim_ok', 'sim_err', 'sent', 'confirmed', 'failed']);

export const ExecutionResultSchema = z.object({
  kind: z.literal('execution_result'),
  intentId: IntentIdSchema,
  status: ExecutionResultStatusSchema,
  txSignature: z.string().nullable().optional(),
  simulated: z.boolean().optional(),
  unitsConsumed: z.number().nullable().optional(),
  /** W8.0 Phase 6 — confirmation slot when status is confirmed. */
  slot: z.number().int().nonnegative().nullable().optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
  executedPriceUsd: z.number().nullable().optional(),
});

export const ExecutionSkipSchema = z.object({
  kind: z.literal('execution_skip'),
  intentId: IntentIdSchema.optional(),
  reason: z.string().min(1),
  detail: z.string().max(500).optional(),
});

export const RiskBlockSchema = z.object({
  kind: z.literal('risk_block'),
  limit: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const CapitalSkipSchema = z.object({
  kind: z.literal('capital_skip'),
  reason: z.string().min(1),
  freeUsdEstimate: z.number().nullable().optional(),
  requiredFreeUsd: z.number().nullable().optional(),
  /** max(0, requiredFreeUsd - freeUsdEstimate) when both are finite numbers. */
  shortfallUsd: z.number().finite().nonnegative().optional(),
});

export const CapitalRotateCloseSchema = z.object({
  kind: z.literal('capital_rotate_close'),
  mint: z.string().min(1).max(64),
  unrealizedPnlUsd: z.number().optional(),
  txSignature: z.string().nullable().optional(),
});

/** W8.0 Phase 7 — mirror of in-memory `OpenTrade` after confirmed live entry / mutations (replay). */
export const LivePositionOpenSchema = z.object({
  kind: z.literal('live_position_open'),
  mint: z.string().min(1).max(64),
  openTrade: z.record(z.string(), z.unknown()),
  /** Явная подпись для таймлайна дашборда (двухногий вход). */
  timelineOpenLabelRu: z.string().max(200).optional(),
  liveScaleInParams: z.record(z.string(), z.unknown()).optional(),
});

export const LivePositionScaleInSchema = z.object({
  kind: z.literal('live_position_scale_in'),
  mint: z.string().min(1).max(64),
  openTrade: z.record(z.string(), z.unknown()),
});

export const LivePositionDcaSchema = z.object({
  kind: z.literal('live_position_dca'),
  mint: z.string().min(1).max(64),
  openTrade: z.record(z.string(), z.unknown()),
});

export const LivePositionPartialSellSchema = z.object({
  kind: z.literal('live_position_partial_sell'),
  mint: z.string().min(1).max(64),
  openTrade: z.record(z.string(), z.unknown()),
});

export const LivePositionCloseSchema = z.object({
  kind: z.literal('live_position_close'),
  mint: z.string().min(1).max(64),
  closedTrade: z.record(z.string(), z.unknown()),
});

/** Phase 7 structured boot diagnostic row (`liveSchema: 2` at write time). Legacy rows may include `mode`. */
export const LiveReconcileReportSchema = z.object({
  kind: z.literal('live_reconcile_report'),
  ok: z.boolean(),
  reconcileStatus: z.enum(['ok', 'mismatch', 'rpc_fail', 'skipped']),
  mode: z.enum(['report', 'block_new', 'trust_chain']).optional(),
  skipReason: z.string().max(160).optional(),
  mismatches: z
    .array(
      z.object({
        mint: z.string(),
        expectedRaw: z.string(),
        actualRaw: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  walletSolLamports: z.string().nullable().optional(),
  chainOnlyMints: z.array(z.string()).optional(),
  journalReplayTruncated: z.boolean().optional(),
  txAnchorSample: z
    .object({
      checked: z.number().int().nonnegative(),
      notFound: z.array(z.string()),
      rpcErrors: z.number().int().nonnegative(),
    })
    .optional(),
  quarantinedMints: z.array(z.string()).optional(),
  anchorRpcPendingMints: z.array(z.string()).optional(),
});

/** W8.0-p7.1 — diagnostic row when replay anchor verification rejects a mint. */
export const LiveReconcileQuarantineSchema = z.object({
  kind: z.literal('live_reconcile_quarantine'),
  mint: z.string().min(1).max(64),
  reason: z.string().min(1).max(120),
  journalLineHint: z.string().max(200).optional(),
  suggestedAction: z.string().max(200).optional(),
});

/** Pre-exit Jupiter verify deferred (paper JSONL noop in live) or escalated for TIMEOUT after N defers. */
export const LiveExitVerifyDeferSchema = z.object({
  kind: z.literal('live_exit_verify_defer'),
  mint: z.string().min(1).max(64),
  context: z.enum(['partial_sell', 'close']),
  phase: z.enum(['defer', 'escalate_proceed']),
  consecutiveDefers: z.number().int().min(0),
  verdictSummary: z.string().max(240),
  exitReason: z
    .enum([
      'TP',
      'SL',
      'TRAIL',
      'TIMEOUT',
      'NO_DATA',
      'KILLSTOP',
      'LIQ_DRAIN',
      'RECONCILE_ORPHAN',
      'PERIODIC_HEAL',
      'CAPITAL_ROTATE',
    ])
    .optional(),
});

/** Periodic tail sweep + stuck-open hygiene (live-oscar). `reconcileOk` kept for dashboard compat (always true). */
export const LivePeriodicSelfHealReportSchema = z.object({
  kind: z.literal('live_periodic_self_heal'),
  ok: z.boolean(),
  reconcileOk: z.boolean(),
  staleOpensForced: z.number().int().nonnegative(),
  tailSweepsAttempted: z.number().int().nonnegative(),
  tailSweepsOk: z.number().int().nonnegative(),
  divergentMints: z.array(z.string()).optional(),
  chainOnlyMints: z.array(z.string()).optional(),
  note: z.string().max(500).optional(),
});

/** One-shot delayed dust sell after `live_position_close` (live-oscar). */
export const LivePostCloseTailSchema = z.object({
  kind: z.literal('live_post_close_tail'),
  mint: z.string().min(1).max(64),
  ok: z.boolean(),
  note: z.string().max(240).optional(),
  rawAtoms: z.string().max(64).optional(),
  estUsd: z.number().finite().optional(),
});

export const LiveEventBodySchema = z.discriminatedUnion('kind', [
  LiveBootEventSchema,
  LiveShutdownEventSchema,
  HeartbeatEventSchema,
  ExecutionAttemptSchema,
  ExecutionResultSchema,
  ExecutionSkipSchema,
  RiskBlockSchema,
  RiskNoteSchema,
  CapitalSkipSchema,
  CapitalRotateCloseSchema,
  LivePositionOpenSchema,
  LivePositionScaleInSchema,
  LivePositionDcaSchema,
  LivePositionPartialSellSchema,
  LivePositionCloseSchema,
  LiveReconcileReportSchema,
  LiveReconcileQuarantineSchema,
  LiveExitVerifyDeferSchema,
  LivePeriodicSelfHealReportSchema,
  LivePostCloseTailSchema,
]);

export type LiveEventBody = z.infer<typeof LiveEventBodySchema>;

export function parseLiveEventBody(data: unknown): LiveEventBody {
  return LiveEventBodySchema.parse(data);
}

export function safeParseLiveEventBody(data: unknown): z.SafeParseReturnType<unknown, LiveEventBody> {
  return LiveEventBodySchema.safeParse(data);
}
