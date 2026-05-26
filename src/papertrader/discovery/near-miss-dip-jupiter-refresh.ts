/**
 * Jupiter spot refresh for mints «почти прошли dip» (PG minute bucket отстаёт от tradable).
 */
import type { DipContextByWindows } from '../dip-detector.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import {
  refreshRowsPricesFromJupiter,
  type JupiterSpotRefreshResult,
} from './jupiter-spot-refresh.js';

export type NearMissDipGap = {
  bestDipPct: number;
  gapPct: number;
  dipHighPx: number;
};

/** Best (shallowest) dip% across windows; gap = bestDipPct − dipMinDropPct when still too shallow. */
export function computeNearMissDipGap(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctxByWindow: DipContextByWindows | undefined,
): NearMissDipGap | null {
  if (!cfg.priorityDiscoveryNearMissJupiterRefreshEnabled) return null;
  if (!ctxByWindow || ctxByWindow.size === 0 || !(row.price_usd > 0)) return null;

  let bestDipPct: number | null = null;
  let dipHighPx = 0;
  for (const w of cfg.dipLookbackWindowsMin) {
    const ctx = ctxByWindow.get(w);
    if (!ctx || !(ctx.high_px > 0)) continue;
    const dipPct = (row.price_usd / ctx.high_px - 1) * 100;
    if (bestDipPct === null || dipPct < bestDipPct) {
      bestDipPct = dipPct;
      dipHighPx = ctx.high_px;
    }
  }
  if (bestDipPct === null || !(dipHighPx > 0)) return null;
  if (bestDipPct <= cfg.dipMinDropPct) return null;

  const gapPct = bestDipPct - cfg.dipMinDropPct;
  if (!(gapPct > 0) || gapPct > cfg.priorityDiscoveryNearMissJupiterGapPct) return null;

  return { bestDipPct, gapPct, dipHighPx };
}

export function selectNearMissDipMintSet(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  dipMap: Map<string, DipContextByWindows>,
  skipMints: ReadonlySet<string>,
): Map<string, NearMissDipGap> {
  const out = new Map<string, NearMissDipGap>();
  for (const row of rows) {
    if (skipMints.has(row.mint)) continue;
    const gap = computeNearMissDipGap(cfg, row, dipMap.get(row.mint));
    if (gap) out.set(row.mint, gap);
  }
  return out;
}

/**
 * После PG dipMap: Jupiter refresh для near-miss mint'ов (только если tradable ниже PG).
 */
export async function refreshNearMissDipPricesFromJupiter(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  dipMap: Map<string, DipContextByWindows>,
  alreadyRefreshedMints: ReadonlySet<string>,
): Promise<JupiterSpotRefreshResult> {
  const nearMiss = selectNearMissDipMintSet(cfg, rows, dipMap, alreadyRefreshedMints);
  if (nearMiss.size === 0) {
    return { refreshed: 0, skipped: 0, errors: 0 };
  }

  const maxPerTick = cfg.priorityDiscoveryNearMissJupiterRefreshMaxPerTick;
  return refreshRowsPricesFromJupiter(cfg, rows, (row) => nearMiss.has(row.mint), maxPerTick, {
    onlyIfLowerThanSnapshot: true,
    acceptPrice: (row, jpx) => {
      const gap = nearMiss.get(row.mint);
      if (!gap) return false;
      const dipPct = (jpx / gap.dipHighPx - 1) * 100;
      return dipPct >= cfg.dipMaxDropPct;
    },
  });
}
