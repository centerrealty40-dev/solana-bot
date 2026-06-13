/**
 * Jupiter spot refresh for priority discovery mints — ловит тихие проливы между PG minute buckets.
 */
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { refreshRowsPricesFromJupiter, type JupiterSpotRefreshResult } from './jupiter-spot-refresh.js';

export type PriorityPriceRefreshResult = JupiterSpotRefreshResult & {
  refreshedMints: Set<string>;
};

/**
 * Обновляет `row.price_usd` свежим Jupiter quote (SOL→mint) для priority mint'ов.
 * Не пишет в PG — только in-memory row после dipMap, перед eval loop.
 */
export async function refreshPriorityMintPricesFromJupiter(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  priorityMintSet: ReadonlySet<string>,
  skipMints: ReadonlySet<string> = new Set(),
): Promise<PriorityPriceRefreshResult> {
  const empty: PriorityPriceRefreshResult = {
    refreshed: 0,
    skipped: 0,
    errors: 0,
    refreshedMints: new Set(),
  };
  if (!cfg.priorityDiscoveryEnabled || !cfg.priorityDiscoveryJupiterRefreshEnabled) {
    return empty;
  }
  if (priorityMintSet.size === 0) return empty;

  const refreshedMints = new Set<string>();
  const result = await refreshRowsPricesFromJupiter(
    cfg,
    rows,
    (row) => priorityMintSet.has(row.mint) && !skipMints.has(row.mint),
    cfg.priorityDiscoveryJupiterRefreshMaxPerTick,
    { onApplied: (row) => refreshedMints.add(row.mint) },
  );
  return { ...result, refreshedMints };
}
