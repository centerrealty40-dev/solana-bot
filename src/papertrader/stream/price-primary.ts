/**
 * Stream-price-primary pure helpers (Stage 1.2, 1.11.468).
 *
 * Side-effect-free resolver that picks the price source for a live-oscar decision point
 * (discovery dip-eval and open-position MTM): the freshest Shyft stream price as **primary**
 * with a `MAX_STALE_MS` freshness-gate, falling back to the existing PG/Jupiter ("baseline")
 * price when the stream is disabled, unseen, stale, or non-positive.
 *
 * **Safety:** `resolvePrimaryPriceUsd` is a no-op passthrough when `enabled === false` — it
 * returns the baseline price verbatim with `source: 'pg'`. With the Stage 1.2 flag default-OFF
 * the trading behaviour is byte-for-byte identical to the current PG/Jupiter path.
 */

export interface PrimaryPriceInput {
  /** Master gate — when `false` the baseline price is returned unchanged (`source: 'pg'`). */
  enabled: boolean;
  /** Current baseline (PG/Jupiter-derived) price; `null`/non-positive => no baseline. */
  pgPriceUsd: number | null | undefined;
  /** Freshest observed Shyft stream price for the mint, or `null` when none/disabled. */
  streamPriceUsd: number | null | undefined;
  /** Local epoch ms of the stream observation; `null` when unknown. */
  streamTsMs: number | null | undefined;
  /** `now` for the freshness gate. */
  nowMs: number;
  /** Max age (ms) a stream price may have to be accepted as primary. */
  maxStaleMs: number;
}

export type PrimaryPriceSource = 'pg' | 'stream';

export interface PrimaryPriceResult {
  /** Chosen price. Equals `pgPriceUsd` (verbatim) whenever the stream is not picked. */
  priceUsd: number | null;
  source: PrimaryPriceSource;
  /** Age (ms) of the stream observation when it was picked; `null` otherwise. */
  streamAgeMs: number | null;
}

function asPositive(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Pick the primary price for a decision point. Returns the baseline (`pg`) price unchanged when
 * disabled or when the stream price is missing / stale / non-positive; otherwise returns the
 * fresh stream price tagged `source: 'stream'`.
 */
export function resolvePrimaryPriceUsd(input: PrimaryPriceInput): PrimaryPriceResult {
  const pg = input.pgPriceUsd != null && Number.isFinite(input.pgPriceUsd) ? input.pgPriceUsd : null;
  if (!input.enabled) {
    return { priceUsd: pg, source: 'pg', streamAgeMs: null };
  }
  const stream = asPositive(input.streamPriceUsd);
  if (stream == null) {
    return { priceUsd: pg, source: 'pg', streamAgeMs: null };
  }
  if (input.streamTsMs == null || !Number.isFinite(input.streamTsMs)) {
    return { priceUsd: pg, source: 'pg', streamAgeMs: null };
  }
  const maxStale = Number.isFinite(input.maxStaleMs) && input.maxStaleMs > 0 ? input.maxStaleMs : 0;
  if (maxStale <= 0) {
    return { priceUsd: pg, source: 'pg', streamAgeMs: null };
  }
  const age = input.nowMs - input.streamTsMs;
  if (!(age <= maxStale) || age < 0) {
    // Stale (older than gate) or future-skewed timestamp => fall back to baseline.
    return { priceUsd: pg, source: 'pg', streamAgeMs: null };
  }
  return { priceUsd: stream, source: 'stream', streamAgeMs: age };
}

export interface PricePrimaryEventInput {
  mint: string;
  lane: string;
  surface: 'entry' | 'mtm';
  /** Baseline (PG/Jupiter) price that would have been used without the override. */
  baselinePriceUsd: number | null;
  /** Stream price that was chosen as primary. */
  streamPriceUsd: number;
  streamTsMs: number;
  streamAgeMs: number | null;
  nowMs: number;
  streamSlot?: number | null;
}

export interface PricePrimaryEvent {
  [key: string]: unknown;
  kind: 'live_shyft_price_primary';
  mint: string;
  lane: string;
  surface: 'entry' | 'mtm';
  source: 'stream';
  baselinePriceUsd: number | null;
  streamPriceUsd: number;
  streamTsMs: number;
  streamAgeMs: number | null;
  /** Signed % difference of the chosen stream price vs the baseline (`null` when no baseline). */
  streamVsBaselinePct: number | null;
  streamSlot?: number | null;
}

/** Build the observability `live_shyft_price_primary` record (emitted only when stream is picked). */
export function buildPricePrimaryEvent(input: PricePrimaryEventInput): PricePrimaryEvent {
  const base =
    input.baselinePriceUsd != null && Number.isFinite(input.baselinePriceUsd) && input.baselinePriceUsd > 0
      ? input.baselinePriceUsd
      : null;
  const diffPct = base != null ? ((input.streamPriceUsd - base) / base) * 100 : null;
  return {
    kind: 'live_shyft_price_primary',
    mint: input.mint,
    lane: input.lane,
    surface: input.surface,
    source: 'stream',
    baselinePriceUsd: base,
    streamPriceUsd: input.streamPriceUsd,
    streamTsMs: input.streamTsMs,
    streamAgeMs: input.streamAgeMs,
    streamVsBaselinePct: diffPct != null ? +diffPct.toFixed(4) : null,
    ...(input.streamSlot != null ? { streamSlot: input.streamSlot } : {}),
  };
}
