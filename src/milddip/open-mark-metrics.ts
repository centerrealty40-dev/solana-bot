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
  liquidityDeadTsMs: number | null;
  liquidityDeadFirstTsMs: number | null;
};

export type MildDipMarkLiquidityTelemetry = {
  liqRatio: number | null;
  depthDrainRatio: number | null;
};

export function computeMarkLiquidityTelemetry(args: {
  liquidityUsd: number | null | undefined;
  entryLiquidityUsd: number | null | undefined;
  priceUsd: number | null | undefined;
  entryPriceUsd: number | null | undefined;
}): MildDipMarkLiquidityTelemetry {
  const liq = args.liquidityUsd;
  const entryLiq = args.entryLiquidityUsd;
  const px = args.priceUsd;
  const entryPx = args.entryPriceUsd;
  if (
    liq == null ||
    !Number.isFinite(liq) ||
    entryLiq == null ||
    !Number.isFinite(entryLiq) ||
    entryLiq <= 0
  ) {
    return { liqRatio: null, depthDrainRatio: null };
  }
  const liqRatio = liq / entryLiq;
  if (
    !Number.isFinite(liqRatio) ||
    px == null ||
    !Number.isFinite(px) ||
    px <= 0 ||
    entryPx == null ||
    !Number.isFinite(entryPx) ||
    entryPx <= 0
  ) {
    return { liqRatio, depthDrainRatio: null };
  }
  const priceRatio = px / entryPx;
  const depthDrainRatio = liqRatio / priceRatio;
  return {
    liqRatio,
    depthDrainRatio: Number.isFinite(depthDrainRatio) ? depthDrainRatio : null,
  };
}

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
  const prior = byMint.get(mint);
  const liveLiquidity = liq != null && liq > 0;
  byMint.set(mint, {
    tsMs,
    pc5mPct: pc,
    volume5mUsd: vol,
    liquidityUsd: liq,
    liquidityDeadTsMs: liveLiquidity ? null : prior?.liquidityDeadTsMs ?? null,
    liquidityDeadFirstTsMs: liveLiquidity ? null : prior?.liquidityDeadFirstTsMs ?? null,
  });
}

export function noteOpenMarkLiquidityDead(mint: string, tsMs: number): void {
  if (!mint || mint.length < 32) return;
  const now = tsMs > 0 && Number.isFinite(tsMs) ? tsMs : Date.now();
  const prior = byMint.get(mint);
  byMint.set(mint, {
    tsMs: now,
    pc5mPct: prior?.pc5mPct ?? null,
    volume5mUsd: prior?.volume5mUsd ?? null,
    liquidityUsd: null,
    liquidityDeadTsMs: now,
    liquidityDeadFirstTsMs: prior?.liquidityDeadFirstTsMs ?? now,
  });
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

export function isOpenMarkLiquidityDead(
  metrics: MildDipOpenMarkMetrics | null,
  confirmMs: number,
): boolean {
  return (
    metrics?.liquidityDeadTsMs != null &&
    metrics.liquidityDeadFirstTsMs != null &&
    metrics.liquidityDeadTsMs - metrics.liquidityDeadFirstTsMs >= confirmMs
  );
}

export function __resetOpenMarkMetricsForTests(): void {
  byMint.clear();
}
