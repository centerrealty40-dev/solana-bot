/**
 * Stale-price observability helpers (Stage 0, 1.11.466).
 *
 * Pure, side-effect-free utilities to measure how old the polled PG snapshot price is at the
 * entry-decision point. Used for **observability only** — they never change a trading decision.
 * They exist to quantify the 30–90s price-blindness (PG collector poll 30s + reeval throttle)
 * before the Shyft+PG hybrid (Stage 1) is introduced.
 */

/** Parse a snapshot row `ts` (Date | ISO string) into epoch ms; `null` if missing/unparseable. */
export function snapshotRowTsMs(ts: Date | string | null | undefined): number | null {
  if (ts == null) return null;
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(String(ts));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Age (ms) of a snapshot price relative to `nowMs`. `null` when the timestamp is unknown.
 * Negative ages (clock skew / future ts) are clamped to 0.
 */
export function snapshotPriceAgeMs(snapshotTsMs: number | null | undefined, nowMs: number): number | null {
  if (snapshotTsMs == null || !Number.isFinite(snapshotTsMs)) return null;
  const age = nowMs - snapshotTsMs;
  return age > 0 ? age : 0;
}

/**
 * Whether the entry price is stale enough to warn. Observability only.
 * Returns `false` when the warn threshold is disabled (`warnMs <= 0`) or the timestamp is unknown.
 */
export function isEntryPriceStale(
  snapshotTsMs: number | null | undefined,
  nowMs: number,
  warnMs: number,
): boolean {
  if (!Number.isFinite(warnMs) || warnMs <= 0) return false;
  const age = snapshotPriceAgeMs(snapshotTsMs, nowMs);
  if (age == null) return false;
  return age > warnMs;
}
