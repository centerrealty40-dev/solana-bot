/**
 * Pure rolling-flush detector for the knife-catcher (no stream / native deps → unit-testable).
 *
 * Catches slow/distributed intraday flushes (e.g. a −8…−12% bleed over 5–15m) that the
 * whale-sell trigger (single sell coinciding with a short 2m-high drop) misses entirely.
 */

export interface PricePoint {
  t: number;
  p: number;
}

export interface RollingFlush {
  detectedAtMs: number;
  preDumpHigh: number;
  dumpLow: number;
  dumpPct: number;
  sellUsd: number;
  signature: string;
  source: string;
}

export interface FlushDetectConfig {
  flushWindowMs: number;
  flushMinDumpPct: number;
  maxDrawdownPct: number;
}

/** Highest price within the last `windowMs` of the buffer. */
export function recentHighInWindow(buf: PricePoint[], nowMs: number, windowMs: number): number {
  let hi = 0;
  const cutoff = nowMs - windowMs;
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    const pt = buf[i]!;
    if (pt.t < cutoff) break;
    if (pt.p > hi) hi = pt.p;
  }
  return hi;
}

export function detectRollingFlush(
  buf: PricePoint[],
  price: number,
  tsMs: number,
  cfg: FlushDetectConfig,
): RollingFlush | null {
  const preHigh = recentHighInWindow(buf, tsMs, cfg.flushWindowMs);
  if (!(preHigh > 0)) return null;

  const dumpPct = ((preHigh - price) / preHigh) * 100;
  if (dumpPct < cfg.flushMinDumpPct) return null;
  if (dumpPct > cfg.maxDrawdownPct) return null;

  return {
    detectedAtMs: tsMs,
    preDumpHigh: preHigh,
    dumpLow: price,
    dumpPct: Number(dumpPct.toFixed(2)),
    sellUsd: 0,
    signature: '',
    source: 'rolling_flush',
  };
}
