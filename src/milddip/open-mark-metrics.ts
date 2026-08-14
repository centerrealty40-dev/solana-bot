/**
 * Last Dex open-mark metrics (pc5m / vol5m / liq) written by background refresh.
 * Exit path reads these without awaiting HTTP.
 */

export type MildDipOpenMarkMetrics = {
  tsMs: number;
  pc5mPct: number | null;
  volume5mUsd: number | null;
  /** 1.11.797 — pool liquidity at last Dex refresh (rebuy liq-drop baseline). */
  liquidityUsd: number | null;
  /** DexScreener dexId at last refresh — entry allow-list on exit defer. */
  dexId: string | null;
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
    liquidityUsd?: number | null;
    dexId?: string | null;
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
  const liq =
    metrics.liquidityUsd != null && Number.isFinite(metrics.liquidityUsd) && metrics.liquidityUsd > 0
      ? Number(metrics.liquidityUsd)
      : null;
  const dexId =
    typeof metrics.dexId === 'string' && metrics.dexId.trim().length > 0
      ? metrics.dexId.trim()
      : null;
  byMint.set(mint, { tsMs, pc5mPct: pc, volume5mUsd: vol, liquidityUsd: liq, dexId });
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
