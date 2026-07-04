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
  /** Сколько mint прошли базовые гейты, но ещё не в подходящем дипе (см. `near-ready-dip-watch.ts`). */
  nearReadyDipWaitCount: z.number().int().nonnegative().optional(),
  /** Новые такие mint с прошлого HEALTH-pulse (Telegram). */
  nearReadyDipNewSinceLastHb: z.number().int().nonnegative().optional(),
  /** Phase 5 — подряд «жёстких» sim/send сбоев (см. `LIVE_KILL_AFTER_CONSEC_FAIL`, `phase5-state`). */
  consecSimFailStreak: z.number().int().nonnegative().optional(),
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

export const ExecutionResultStatusSchema = z.enum([
  'sim_ok',
  'sim_err',
  'sent',
  'confirmed',
  'failed',
  /** Pre-broadcast gate (SPL=0, bad price, dry_run) — paired with `execution_skip` for audit. */
  'skipped',
]);

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
  timelineOpenLabelRu: z.string().max(512).optional(),
  liveScaleInParams: z.record(z.string(), z.unknown()).optional(),
  /** 1.11.232: какой discovery-путь привёл к открытию (dip_windows/impulse_pg_snap/runner). */
  entryPath: z.union([z.string(), z.null()]).optional(),
  /** 1.11.232: runner features snapshot (если entryPath='runner'). */
  runnerFeatures: z.unknown().nullable().optional(),
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
  timelineLabelRu: z.string().max(512).optional(),
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
      'BREAKEVEN_EXIT',
      'LIQ_DRAIN',
      'FLASH_CRASH_KILL',
      'RECONCILE_ORPHAN',
      'PERIODIC_HEAL',
      'CAPITAL_ROTATE',
      'WAVE_B_POST_TP1_SCRATCH',
    ])
    .optional(),
});

/** Periodic tail sweep + stuck-open hygiene (live-oscar). `reconcileOk` kept for dashboard compat (always true). */
export const LivePeriodicSelfHealReportSchema = z.object({
  kind: z.literal('live_periodic_self_heal'),
  ok: z.boolean(),
  reconcileOk: z.boolean(),
  /** Stale open positions with on-chain balance observed this tick. */
  staleOpensObserved: z.number().int().nonnegative().optional(),
  staleOpensForced: z.number().int().nonnegative(),
  /** Observed stale opens that were intentionally not sold because force-close is disabled. */
  staleOpensForceCloseDisabled: z.number().int().nonnegative().optional(),
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
  exitReason: z.string().max(64).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  thresholdUsd: z.number().finite().optional(),
});

/** Wallet tail flush after partial exit, post-close sweep, or periodic heal. */
export const LiveTailFlushSchema = z.object({
  kind: z.literal('live_tail_flush'),
  mint: z.string().min(1).max(64),
  context: z.enum(['post_close', 'partial_exit', 'periodic_heal']),
  ok: z.boolean(),
  note: z.string().max(240).optional(),
  estUsd: z.number().finite().optional(),
  thresholdUsd: z.number().finite().optional(),
  rawAtoms: z.string().max(64).optional(),
  flushed: z.boolean().optional(),
});

/** Candidate passed paper gates but mint not on allowlist (`LIVE_MINT_WHITELIST_ENABLED`). */
export const LiveWhitelistSkipSchema = z.object({
  kind: z.literal('live_whitelist_skip'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
});

/** Mint на постоянном denylist (seed/local); вход заблокирован даже при ошибочном возврате строки в whitelist. */
export const LivePermanentDenySkipSchema = z.object({
  kind: z.literal('live_permanent_deny_skip'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
});

/** Oscar discovery: candidate failed paper eval gates (`pass: false`); mirrors dropped paper JSONL on live-oscar. */
export const LiveDiscoveryEvalSchema = z.object({
  kind: z.literal('live_discovery_eval'),
  mint: z.string().min(1).max(64),
  /** Present on new writers; omitted on legacy rows (treat as false). */
  pass: z.boolean().optional(),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  ageMin: z.number().finite().optional(),
  /** Trade strategy lane (`prod` | `scalp_wave`) for mutex audit. */
  tradeLane: z.string().max(32).optional(),
  reasons: z.array(z.string().max(400)).max(24),
  /** Tier «Первый выстрел» shadow eval (PR1+). */
  pervyyVystrel: z
    .object({
      phase: z.string().max(32),
      wouldOnboard: z.boolean().optional(),
      shadowMode: z.boolean().optional(),
    })
    .optional(),
  entryPath: z.string().max(120).optional(),
  /**
   * Numeric telemetry pulled from `EvalDecision.features` (1.11.234 — telemetry-A).
   * Lets retro tools ("how close to dip threshold") work without re-querying PG.
   * All optional: legacy rows and writers without features keep working.
   */
  priceUsd: z.number().finite().nullable().optional(),
  liqUsd: z.number().finite().nullable().optional(),
  marketCapUsd: z.number().finite().nullable().optional(),
  vol1hUsd: z.number().finite().nullable().optional(),
  vol5mUsd: z.number().finite().nullable().optional(),
  buySellRatio5m: z.number().finite().nullable().optional(),
  /** Final dipPct of the window that passed; null when no window passed. */
  dipPct: z.number().finite().nullable().optional(),
  dipLookbackMin: z.number().finite().nullable().optional(),
  /** Per-window dip% snapshot (e.g. {"120": -5.36, "360": -18.43, "720": -18.43}). Always present when ctx existed. */
  dipPctByWindow: z.record(z.string(), z.number().finite()).optional(),
  /** Min distance from local-high across configured windows (closest-to-high in pct, e.g. -0.5 means 0.5% below). */
  localHighDistMinPct: z.number().finite().nullable().optional(),
  /** Policy A+ pre-filter metrics, when computed. */
  priceChange30mPct: z.number().finite().nullable().optional(),
  priceChange1hPct: z.number().finite().nullable().optional(),
  bounceFromMin30mPct: z.number().finite().nullable().optional(),
});

/** Mint on deep-audit list hit `PAPER_DISCOVERY_REEVAL_SEC` throttle before eval. */
export const LiveDiscoveryTickSkipSchema = z.object({
  kind: z.literal('live_discovery_tick_skip'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  reason: z.string().min(1).max(120),
  discoveryReevalSec: z.number().int().min(5).max(600).optional(),
});

/** Mint not returned by snapshot candidate SQL (filters, staleness, or crowded-out LIMIT). */
export const LiveDiscoveryUniverseMissSchema = z.object({
  kind: z.literal('live_discovery_universe_miss'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  reasons: z.array(z.string().max(400)).min(1).max(40),
  snapshotHint: z.string().max(1600).optional(),
});

/** Staged-entry anchor accepted for a live mint before the first buy leg is allowed. */
export const LiveStagedEntrySignalSchema = z.object({
  kind: z.literal('live_staged_entry_signal'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  signalPriceUsd: z.number().finite(),
  signalMarketCapUsd: z.number().finite().nullable().optional(),
  holderCount: z.number().finite().nullable().optional(),
  firstDropPct: z.number().finite(),
  firstTargetUsd: z.number().finite(),
  secondDropPct: z.number().finite(),
  thirdDropPct: z.number().finite().optional(),
  expiresAt: z.number().finite(),
});

/** Staged-entry anchor cleared after confirmed buy / `live_position_open`. */
export const LiveStagedEntryClearedForBuySchema = z.object({
  kind: z.literal('staged_entry_cleared_for_buy'),
  mint: z.string().min(1).max(64),
  signalPriceUsd: z.number().finite().optional(),
  signalTs: z.number().finite().optional(),
  expiresAt: z.number().finite().optional(),
});

/** Staged-entry anchor restored after a failed `tryExecuteBuyOpen` (RCA observability). */
export const LiveStagedEntryRestoredAfterBuyFailSchema = z.object({
  kind: z.literal('staged_entry_restored_after_buy_fail'),
  mint: z.string().min(1).max(64),
  signalPriceUsd: z.number().finite(),
  signalTs: z.number().finite(),
  expiresAt: z.number().finite(),
});

/** Staged-entry anchor cleared after wait-window TTL without −10% entry (fresh re-eval required). */
export const LiveStagedEntryTtlExpiredSchema = z.object({
  kind: z.literal('staged_entry_ttl_expired'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  signalPriceUsd: z.number().finite(),
  signalTs: z.number().finite(),
  expiresAt: z.number().finite(),
});

/** Passed eval but open blocked (safety, impulse, price verify, already_open, etc.). */
export const LiveDiscoverySkipOpenSchema = z.object({
  kind: z.literal('live_discovery_skip_open'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  reason: z.string().min(1).max(500),
  tradeLane: z.string().max(32).optional(),
  openTradeLane: z.string().max(32).optional(),
  detail: z.string().max(2000).optional(),
});

/** scalp_wave → prod/low handoff when shallow dip deepens or timestop without TP. */
export const LivePhaseEscalationSchema = z.object({
  kind: z.literal('live_phase_escalation'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  fromLane: z.string().max(32),
  toLane: z.string().max(32),
  toTier: z.string().max(32).optional(),
  trigger: z.enum(['deep_dip', 'timestop_no_tp', 'discovery_handoff']),
  liveExitPolicyId: z.string().max(32).optional(),
  dropFromEntryPct: z.number().finite().optional(),
  openTrade: z.record(z.string(), z.unknown()).optional(),
});

/** PR1+ — Phase 0 watchlist onboard (shadow observability). */
export const PervyyVystrelWatchOnboardSchema = z.object({
  kind: z.literal('pervyy_vystrel_watch_onboard'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  mcap: z.number().finite().optional(),
  vol1h: z.number().finite().optional(),
  anchor_band: z.string().max(64).optional(),
  shadowMode: z.boolean().optional(),
});

/** PR1+ — shadow gate blocked / pre-onboard skip. */
export const PervyyVystrelShadowSkipSchema = z.object({
  kind: z.literal('pervyy_vystrel_shadow_skip'),
  mint: z.string().min(1).max(64),
  symbol: z.string().max(64).optional(),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  phase: z.string().max(32).optional(),
  reasons: z.array(z.string().max(400)).max(16),
});

/** Phase A surveillance tick (PR3; schema registered PR1). */
export const PervyyVystrelPhaseATickSchema = z.object({
  kind: z.literal('pervyy_vystrel_phase_a_tick'),
  mint: z.string().min(1).max(64),
  peakMcap: z.number().finite().optional(),
  unique_buyers_1h: z.number().finite().optional(),
  cluster_ratio: z.number().finite().optional(),
});

/** Phase B hourly surveillance (PR3; schema registered PR1). */
export const PervyyVystrelSurveillanceTickSchema = z.object({
  kind: z.literal('pervyy_vystrel_surveillance_tick'),
  mint: z.string().min(1).max(64),
  mcap: z.number().finite().optional(),
  vol1h: z.number().finite().optional(),
  holder_delta_30m: z.number().finite().optional(),
});

/** Phase C cluster dump confirmed (PR2/PR3). */
export const PervyyVystrelClusterDumpConfirmedSchema = z.object({
  kind: z.literal('pervyy_vystrel_cluster_dump_confirmed'),
  mint: z.string().min(1).max(64),
  dump_pct: z.number().finite().optional(),
  cluster_sell_ratio: z.number().finite().optional(),
});

/** Phase D entry signal (PR3). */
export const PervyyVystrelEntrySignalSchema = z.object({
  kind: z.literal('pervyy_vystrel_entry_signal'),
  mint: z.string().min(1).max(64),
  would_enter: z.boolean().optional(),
  enter: z.boolean().optional(),
});

/** PR2 — batch volume authenticity snapshot (shadow). */
export const PervyyVystrelVolAuthSnapshotSchema = z.object({
  kind: z.literal('pervyy_vystrel_vol_auth_snapshot'),
  mint: z.string().min(1).max(64),
  wash_score: z.number().finite(),
  organic_score: z.number().finite(),
  round_trip_share: z.number().finite().nullable().optional(),
  cycle_share: z.number().finite().nullable().optional(),
  net_new_share: z.number().finite().nullable().optional(),
  pass: z.boolean().optional(),
});

export const PervyyVystrelVolAuthInsufficientDataSchema = z.object({
  kind: z.literal('pervyy_vystrel_vol_auth_insufficient_data'),
  mint: z.string().min(1).max(64),
  swap_count: z.number().int().nonnegative(),
});

/** PR2 — organic flow shadow gate. */
export const PervyyVystrelOrganicFlowShadowSchema = z.object({
  kind: z.literal('pervyy_vystrel_organic_flow_shadow'),
  mint: z.string().min(1).max(64),
  unique_buyers_1h: z.number().finite(),
  cluster_buyer_ratio: z.number().finite().nullable().optional(),
  unclustered_buyers: z.number().finite(),
  pass: z.boolean().optional(),
});

/** PR2 — cluster dump attribution shadow (Phase C). */
export const PervyyVystrelClusterDumpShadowSchema = z.object({
  kind: z.literal('pervyy_vystrel_cluster_dump_shadow'),
  mint: z.string().min(1).max(64),
  cluster_sell_ratio: z.number().finite().nullable().optional(),
  cluster_unique_sellers: z.number().int().nonnegative(),
  pass: z.boolean().optional(),
});

/** Phase D armed window (PR3). */
export const PervyyVystrelPhaseDArmedSchema = z.object({
  kind: z.literal('pervyy_vystrel_phase_d_armed'),
  mint: z.string().min(1).max(64),
  bottom_mcap: z.number().finite().optional(),
  reramp_pct: z.number().finite().optional(),
});

/** Phase C retail-only dump skip (PR3). */
export const PervyyVystrelDumpRetailSkippedSchema = z.object({
  kind: z.literal('pervyy_vystrel_dump_retail_skipped'),
  mint: z.string().min(1).max(64),
  retail_panic_score: z.number().finite().nullable().optional(),
});

/** Watchlist eviction (TTL / drop / arm window). */
export const PervyyVystrelWatchEvictedSchema = z.object({
  kind: z.literal('pervyy_vystrel_watch_evicted'),
  mint: z.string().min(1).max(64),
  reason: z.string().max(128),
});

/** Phase A/B vol-auth hard block. */
export const PervyyVystrelVolAuthWashBlockedSchema = z.object({
  kind: z.literal('pervyy_vystrel_vol_auth_wash_blocked'),
  mint: z.string().min(1).max(64),
  wash_score: z.number().finite(),
  reasons: z.array(z.string().max(200)).max(12),
});

/** Phase B holder stall flag. */
export const PervyyVystrelVolAuthDecayFlagSchema = z.object({
  kind: z.literal('pervyy_vystrel_vol_auth_decay_flag'),
  mint: z.string().min(1).max(64),
  vol1h: z.number().finite().optional(),
  holder_delta_30m: z.number().finite().optional(),
});

/** Phase C fake churn dump skip. */
export const PervyyVystrelVolAuthFakeDumpSkippedSchema = z.object({
  kind: z.literal('pervyy_vystrel_vol_auth_fake_dump_skipped'),
  mint: z.string().min(1).max(64),
  cycle_share: z.number().finite().optional(),
  cluster_sell_ratio: z.number().finite().optional(),
});

/** Phase D phantom/replay requires materialized PR2 snapshots; never opens a position. */
export const PervyyVystrelPhaseDMissingMaterializedSnapshotSchema = z.object({
  kind: z.literal('pervyy_vystrel_phase_d_missing_materialized_snapshot'),
  mint: z.string().min(1).max(64),
  materialize_enabled: z.boolean(),
  pass: z.literal(false),
  reasons: z.array(z.string()).optional(),
});

/** Phase C phantom candidate from materialized cluster-dump attribution. */
export const PervyyVystrelPhaseCCandidateSchema = z.object({
  kind: z.literal('pervyy_vystrel_phase_c_candidate'),
  mint: z.string().min(1).max(64),
  cluster_dump_completed: z.boolean(),
  cluster_sell_ratio: z.number().finite().nullable().optional(),
  cluster_unique_sellers: z.number().int().nonnegative(),
  retail_panic_score: z.number().finite().nullable().optional(),
  pass: z.literal(false),
  reasons: z.array(z.string()).optional(),
});

/** Phase D phantom/replay candidate. `would_enter:false` is the no-live-buy contract. */
export const PervyyVystrelPhaseDCandidateSchema = z.object({
  kind: z.literal('pervyy_vystrel_phase_d_candidate'),
  mint: z.string().min(1).max(64),
  cluster_dump_completed: z.boolean(),
  fresh_retail_absorption: z.boolean(),
  reramp_confirmation: z.boolean(),
  organic_score: z.number().finite().nullable().optional(),
  unique_buyers_1h: z.number().finite().nullable().optional(),
  unclustered_buyers: z.number().finite().nullable().optional(),
  wash_score: z.number().finite().nullable().optional(),
  pass: z.literal(false),
  would_enter: z.literal(false),
  reasons: z.array(z.string()).optional(),
});

/** Daily Telegram summary tick (1.11.231+); appended to live JSONL for audit. */
export const LiveDailySummarySchema = z.object({
  kind: z.literal('live_daily_summary'),
  fromMs: z.number().finite(),
  toMs: z.number().finite(),
  evals: z.number().int().nonnegative(),
  passes: z.number().int().nonnegative(),
  buyAttempts: z.number().int().nonnegative(),
  buyConfirmed: z.number().int().nonnegative(),
  sellConfirmed: z.number().int().nonnegative(),
  closedPositions: z.number().int().nonnegative(),
  netPnlUsd: z.number().finite(),
  simErrCount: z.number().int().nonnegative(),
  stagedCooldownRearms: z.number().int().nonnegative(),
  autoDenylistAdds: z.number().int().nonnegative(),
  priorityFeeBoosts: z.number().int().nonnegative(),
  topBlockers: z
    .array(
      z.object({
        reason: z.string().max(200),
        count: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

/**
 * Stage 1.1 (1.11.467) — Shyft shadow consumer connection status (observability only).
 * Without this schema member `appendLiveJsonlEvent` silently drops the event (validation fail).
 */
export const LiveShyftShadowStatusSchema = z.object({
  kind: z.literal('live_shyft_shadow_status'),
  status: z.enum(['connecting', 'connected', 'end', 'error', 'decode_error', 'closed', 'idle']),
  detail: z.string().max(400).optional(),
});

/** Stage 1.1 (1.11.467) — stream-vs-PG shadow price observation (observability only). */
export const LiveShyftShadowPriceSchema = z.object({
  kind: z.literal('live_shyft_shadow_price'),
  mint: z.string().min(1).max(64),
  lane: z.string().max(32),
  surface: z.enum(['entry', 'mtm']).optional(),
  streamPriceUsd: z.number().finite(),
  pgPriceUsd: z.number().finite().nullable(),
  streamTsMs: z.number().finite(),
  pgSnapshotTsMs: z.number().finite().nullable(),
  pgPriceAgeMs: z.number().finite().nullable(),
  streamVsPgLagMs: z.number().finite().nullable(),
  streamVsPgPriceDiffPct: z.number().finite().nullable(),
  streamSlot: z.number().finite().nullable().optional(),
});

/** Stage 1.2 (1.11.468) — stream price picked as primary at entry/MTM (observability). */
export const LiveShyftPricePrimarySchema = z.object({
  kind: z.literal('live_shyft_price_primary'),
  mint: z.string().min(1).max(64),
  lane: z.string().max(32),
  surface: z.enum(['entry', 'mtm']),
  source: z.literal('stream'),
  baselinePriceUsd: z.number().finite().nullable(),
  streamPriceUsd: z.number().finite(),
  streamTsMs: z.number().finite(),
  streamAgeMs: z.number().finite().nullable(),
  streamVsBaselinePct: z.number().finite().nullable(),
  streamSlot: z.number().finite().nullable().optional(),
});

/** Stage 1.3 (1.11.469) — Shyft DeFi mcap/liq vs PG at discovery eval (observability). */
export const LiveShyftDefiMcapSchema = z.object({
  kind: z.literal('live_shyft_defi_mcap'),
  mint: z.string().min(1).max(64),
  lane: z.string().max(32),
  pgMcapUsd: z.number().finite().nullable(),
  pgLiqUsd: z.number().finite().nullable(),
  defiMcapUsd: z.number().finite().nullable(),
  defiLiqUsd: z.number().finite().nullable(),
});

/** Birdeye REST market quote picked over PG at discovery eval (observability). */
export const LiveBirdeyeMarketQuoteSchema = z.object({
  kind: z.literal('live_birdeye_market_quote'),
  mint: z.string().min(1).max(64),
  lane: z.string().max(32),
  source: z.enum(['birdeye', 'dexscreener']),
  pgPriceUsd: z.number().finite().nullable(),
  pgMcapUsd: z.number().finite().nullable(),
  pgLiqUsd: z.number().finite().nullable(),
  pgVol5mUsd: z.number().finite().nullable(),
  pgSnapshotAgeMs: z.number().finite().nullable(),
  quotePriceUsd: z.number().finite().nullable(),
  quoteMcapUsd: z.number().finite().nullable(),
  quoteLiqUsd: z.number().finite().nullable(),
  quoteVol5mUsd: z.number().finite().nullable(),
});

/** PG snapshot stale and REST fallbacks missed — coverage hole observability. */
export const BirdeyeCoverageGapSchema = z.object({
  kind: z.literal('birdeye_coverage_gap'),
  mint: z.string().min(1).max(64),
  lane: z.string().max(32),
  reason: z.literal('birdeye_coverage_gap'),
  pgSnapshotAgeMs: z.number().finite(),
  coverageGapMinMs: z.number().finite().positive(),
  resolvedSource: z.enum(['birdeye', 'dexscreener', 'pg_snapshot']),
});

/** Birdeye 429 / CU quota — subscription tier may be insufficient. */
export const BirdeyeTierInsufficientSchema = z.object({
  kind: z.literal('birdeye_tier_insufficient'),
  mint: z.string().min(1).max(64),
  lane: z.string().max(32),
  reason: z.literal('birdeye_tier_insufficient'),
  errorKind: z.enum(['rate_limit', 'quota', 'auth', 'network', 'parse']).optional(),
  message: z.string().max(240).optional(),
});

/** Stage 0 (1.11.466) — PG snapshot price older than warn threshold at entry eval. */
export const LiveStalePriceWarnSchema = z.object({
  kind: z.literal('live_stale_price_warn'),
  mint: z.string().min(1).max(64),
  lane: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  symbol: z.string().max(64).optional(),
  priceAgeMs: z.number().int().nonnegative(),
  warnThresholdMs: z.number().int().positive(),
  priceUsd: z.number().finite().nullable().optional(),
  snapshotTsMs: z.number().finite().nullable().optional(),
});

/** Boot: pre-boot open snapshot merged into truncated journal replay (1.11.483). */
export const LiveBootSnapshotMergeSchema = z.object({
  kind: z.literal('live_boot_snapshot_merge'),
  restoredMints: z.array(z.string()).optional(),
  skippedSeenInReplay: z.array(z.string()).optional(),
  journalReplayTruncated: z.boolean().optional(),
  replayOpenAfterMerge: z.number().int().nonnegative().optional(),
});

/** Boot: wallet SPL orphan restored via full-journal mint replay (1.11.483). */
/** Runtime wallet-vs-journal resync (manual adjustment / MENSA-class orphan). */
export const OrphanReconcileSchema = z.object({
  kind: z.literal('orphan_reconcile'),
  mint: z.string().min(1).max(64),
  reason: z.enum(['chain_above_journal', 'journal_zero_chain_holds', 'chain_orphan_no_open']),
  prevRemainingFraction: z.number().finite().min(0).max(1).optional(),
  nextRemainingFraction: z.number().finite().min(0).max(1).optional(),
  journalRemainingUsd: z.number().finite().nonnegative().optional(),
  chainOscarUsd: z.number().finite().nonnegative(),
  minUsd: z.number().finite().nonnegative().optional(),
});

export const LiveBootWalletOrphanRestoreSchema = z.object({
  kind: z.literal('live_boot_wallet_orphan_restore'),
  restoredMints: z.array(z.string()).optional(),
  walletMintsScanned: z.array(z.string()).optional(),
  replayOpenAfterRestore: z.number().int().nonnegative().optional(),
});

/** Entry-split leg 2 add (v2 staged entry); mirrored from paper tracker on live-oscar. */
export const EntrySplitAddSchema = z.object({
  kind: z.literal('entry_split_add'),
  mint: z.string().min(1).max(64),
  ts: z.number().finite().optional(),
  price: z.number().finite().optional(),
  marketPrice: z.number().finite().optional(),
  sizeUsd: z.number().finite().optional(),
  avgEntry: z.number().finite().optional(),
  avgEntryMarket: z.number().finite().optional(),
  totalInvestedUsd: z.number().finite().optional(),
  legCount: z.number().int().nonnegative().optional(),
  mcUsdLive: z.number().finite().nullable().optional(),
  priorityFee: z.number().finite().optional(),
  timelineLabelRu: z.string().max(512).optional(),
  liveExitProfileMode: z.literal('B').optional(),
});

/** Staged averaging leg add (−7% / −14% vs signal); mirrored from paper tracker on live-oscar. */
export const StagedAvgAddSchema = z.object({
  kind: z.literal('staged_avg_add'),
  mint: z.string().min(1).max(64),
  ts: z.number().finite().optional(),
  price: z.number().finite().optional(),
  marketPrice: z.number().finite().optional(),
  sizeUsd: z.number().finite().optional(),
  avgEntry: z.number().finite().optional(),
  avgEntryMarket: z.number().finite().optional(),
  totalInvestedUsd: z.number().finite().optional(),
  legCount: z.number().int().nonnegative().optional(),
  mcUsdLive: z.number().finite().nullable().optional(),
  priorityFee: z.number().finite().optional(),
  timelineLabelRu: z.string().max(512).optional(),
  liveExitProfileMode: z.literal('B').optional(),
});

/** 1.11.502 — planned multi-slice live exit (partial TP, kill, full close). */
export const ExitSlicePlanSchema = z.object({
  kind: z.literal('exit_slice_plan'),
  mint: z.string().min(1).max(64),
  intentKind: z.enum(['sell_partial', 'sell_full']).optional(),
  totalUsdNotional: z.number().finite().optional(),
  maxUsdPerSlice: z.number().finite().optional(),
  sliceCount: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(),
});

export const ExitSliceAttemptSchema = z.object({
  kind: z.literal('exit_slice_attempt'),
  mint: z.string().min(1).max(64),
  sliceIndex: z.number().int().nonnegative().optional(),
  sliceCount: z.number().int().positive().optional(),
  usdNotional: z.number().finite().optional(),
  intentKind: z.enum(['sell_partial', 'sell_full']).optional(),
});

export const ExitSliceResultSchema = z.object({
  kind: z.literal('exit_slice_result'),
  mint: z.string().min(1).max(64),
  sliceIndex: z.number().int().nonnegative().optional(),
  sliceCount: z.number().int().positive().optional(),
  ok: z.boolean().optional(),
  slicesCompleted: z.number().int().nonnegative().optional(),
});

/** 1.11.458 — hot tick killstop pre-arm observability. */
export const LiveKillstopPrearmSchema = z.object({
  kind: z.literal('live_killstop_prearm'),
  mint: z.string().min(1).max(64),
  pnlFracVsAvg: z.number().finite().optional(),
  killEffPct: z.number().finite().optional(),
  sellUsdPerToken: z.number().finite().optional(),
  ttlMs: z.number().int().nonnegative().optional(),
});

export const LiveSellQuotePrearmArmedSchema = z.object({
  kind: z.literal('live_sell_quote_prearm_armed'),
  mint: z.string().min(1).max(64),
  intentKind: z.enum(['sell_partial', 'sell_full']).optional(),
  tokenAmountRaw: z.string().optional(),
  expiresAtMs: z.number().finite().optional(),
});

export const LiveSellQuotePrearmExpiredSchema = z.object({
  kind: z.literal('live_sell_quote_prearm_expired'),
  mint: z.string().min(1).max(64),
  intentKind: z.enum(['sell_partial', 'sell_full']).optional(),
  expiresAtMs: z.number().finite().optional(),
  nowMs: z.number().finite().optional(),
});

export const LiveSellQuotePrearmConsumedSchema = z.object({
  kind: z.literal('live_sell_quote_prearm_consumed'),
  mint: z.string().min(1).max(64),
  intentKind: z.enum(['sell_partial', 'sell_full']).optional(),
  ageMs: z.number().finite().optional(),
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
  LiveTailFlushSchema,
  LiveWhitelistSkipSchema,
  LivePermanentDenySkipSchema,
  LiveDiscoveryEvalSchema,
  LiveDiscoveryTickSkipSchema,
  LiveDiscoveryUniverseMissSchema,
  LiveStagedEntrySignalSchema,
  LiveStagedEntryClearedForBuySchema,
  LiveStagedEntryRestoredAfterBuyFailSchema,
  LiveStagedEntryTtlExpiredSchema,
  LiveDiscoverySkipOpenSchema,
  LivePhaseEscalationSchema,
  PervyyVystrelWatchOnboardSchema,
  PervyyVystrelShadowSkipSchema,
  PervyyVystrelPhaseATickSchema,
  PervyyVystrelSurveillanceTickSchema,
  PervyyVystrelClusterDumpConfirmedSchema,
  PervyyVystrelEntrySignalSchema,
  PervyyVystrelVolAuthSnapshotSchema,
  PervyyVystrelVolAuthInsufficientDataSchema,
  PervyyVystrelOrganicFlowShadowSchema,
  PervyyVystrelClusterDumpShadowSchema,
  PervyyVystrelPhaseDMissingMaterializedSnapshotSchema,
  PervyyVystrelPhaseCCandidateSchema,
  PervyyVystrelPhaseDCandidateSchema,
  PervyyVystrelPhaseDArmedSchema,
  PervyyVystrelDumpRetailSkippedSchema,
  PervyyVystrelWatchEvictedSchema,
  PervyyVystrelVolAuthWashBlockedSchema,
  PervyyVystrelVolAuthDecayFlagSchema,
  PervyyVystrelVolAuthFakeDumpSkippedSchema,
  LiveDailySummarySchema,
  LiveShyftShadowStatusSchema,
  LiveShyftShadowPriceSchema,
  LiveShyftPricePrimarySchema,
  LiveShyftDefiMcapSchema,
  LiveBirdeyeMarketQuoteSchema,
  BirdeyeCoverageGapSchema,
  BirdeyeTierInsufficientSchema,
  LiveStalePriceWarnSchema,
  LiveBootSnapshotMergeSchema,
  LiveBootWalletOrphanRestoreSchema,
  OrphanReconcileSchema,
  EntrySplitAddSchema,
  StagedAvgAddSchema,
  ExitSlicePlanSchema,
  ExitSliceAttemptSchema,
  ExitSliceResultSchema,
  LiveKillstopPrearmSchema,
  LiveSellQuotePrearmArmedSchema,
  LiveSellQuotePrearmExpiredSchema,
  LiveSellQuotePrearmConsumedSchema,
]);

export type LiveEventBody = z.infer<typeof LiveEventBodySchema>;

export function parseLiveEventBody(data: unknown): LiveEventBody {
  return LiveEventBodySchema.parse(data);
}

export function safeParseLiveEventBody(data: unknown): z.SafeParseReturnType<unknown, LiveEventBody> {
  return LiveEventBodySchema.safeParse(data);
}
