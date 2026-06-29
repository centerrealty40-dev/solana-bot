/**
 * When a position's remaining fraction falls at or below this threshold of the
 * original size, flush the entire remainder (avoid TP/trail dust).
 */
export function remainderCloseFrac(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct));
  return clamped / 100;
}

/** True when remaining position size should be fully closed. */
export function shouldRemainderFlush(remainingFraction: number, remainderClosePct: number): boolean {
  if (remainingFraction <= 1e-6) return false;
  return remainingFraction <= remainderCloseFrac(remainderClosePct) + 1e-9;
}

/** Remaining gross USD vs original entry gross. */
export function remainingGrossUsd(totalGrossUsd: number, remainingFraction: number): number {
  return totalGrossUsd * remainingFraction;
}
