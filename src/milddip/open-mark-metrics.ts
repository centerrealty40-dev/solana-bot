/**
 * Last Dex open-mark metrics (pc5m / vol5m) written by background refresh.
 * Exit path reads these without awaiting HTTP.
 */

export type MildDipOpenMarkMetrics = {
  tsMs: number;
  pc5mPct: number | null;
  volume5mUsd: number | null;
};

const byMint = new Map<string, MildDipOpenMarkMetrics>();

/** Max age for metrics used by never-arm HELD+PC+SL (stale Dex → fail closed). */
export const OPEN_MARK_METRICS_MAX_AGE_MS = 120_000;

export function noteOpenMarkMetrics(
  mint: string,
  metrics: {
    tsMs?: number;
    pc5mPct?: number | null;
    volume5mUsd?: number | null;
  },
): void {
  if (!mint || mint.length < 32) return;
  const tsMs = metrics.tsMs != null && metrics.tsMs > 0 ? metrics.tsMs : Date.now();
  const pc =
    metrics.pc5mPct != null && Number.isFinite(metrics.pc5mPct) ? Number(metrics.pc5mPct) : null;
  const vol =
    metrics.volume5mUsd != null && Number.isFinite(metrics.volume5mUsd) && metrics.volume5mUsd >= 0
      ? Number(metrics.volume5mUsd)
      : null;
  byMint.set(mint, { tsMs, pc5mPct: pc, volume5mUsd: vol });
}

export function readOpenMarkMetrics(
  mint: string,
  nowMs = Date.now(),
  maxAgeMs = OPEN_MARK_METRICS_MAX_AGE_MS,
): MildDipOpenMarkMetrics | null {
  const row = byMint.get(mint);
  if (!row) return null;
  if (maxAgeMs > 0 && nowMs - row.tsMs > maxAgeMs) return null;
  return row;
}

export function __resetOpenMarkMetricsForTests(): void {
  byMint.clear();
}
