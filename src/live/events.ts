/**
 * W8.0-p1 — validated live JSONL event bodies (`liveSchema` envelope added at write time).
 */
import { z } from 'zod';

export const LIVE_SCHEMA_V1 = 1 as const;

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
});

export const ExecutionAttemptSchema = z.object({
  kind: z.literal('execution_attempt'),
  intentId: IntentIdSchema,
  side: z.enum(['buy', 'sell']),
  mint: z.string().min(1).max(64),
  intendedUsd: z.number().nullable().optional(),
  intendedAmountAtomic: z.string().optional(),
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

export const LiveEventBodySchema = z.discriminatedUnion('kind', [
  LiveBootEventSchema,
  LiveShutdownEventSchema,
  HeartbeatEventSchema,
  ExecutionAttemptSchema,
  ExecutionResultSchema,
  ExecutionSkipSchema,
  RiskBlockSchema,
  CapitalSkipSchema,
  CapitalRotateCloseSchema,
  LivePositionOpenSchema,
  LivePositionDcaSchema,
  LivePositionPartialSellSchema,
  LivePositionCloseSchema,
]);

export type LiveEventBody = z.infer<typeof LiveEventBodySchema>;

export function parseLiveEventBody(data: unknown): LiveEventBody {
  return LiveEventBodySchema.parse(data);
}

export function safeParseLiveEventBody(data: unknown): z.SafeParseReturnType<unknown, LiveEventBody> {
  return LiveEventBodySchema.safeParse(data);
}
