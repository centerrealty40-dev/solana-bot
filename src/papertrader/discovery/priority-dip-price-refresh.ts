/**
 * Jupiter spot refresh for priority discovery mints — ловит тихие проливы между PG minute buckets.
 */
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { refreshRowsPricesFromJupiter, type JupiterSpotRefreshResult } from './jupiter-spot-refresh.js';

export type PriorityPriceRefreshResult = JupiterSpotRefreshResult;

/**
 * Обновляет `row.price_usd` свежим Jupiter quote (SOL→mint) для priority mint'ов.
 * Не пишет в PG — только in-memory row перед dip-eval на этом тике.
 */
export async function refreshPriorityMintPricesFromJupiter(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  priorityMintSet: ReadonlySet<string>,
  skipMints: ReadonlySet<string> = new Set(),
): Promise<PriorityPriceRefreshResult> {
  if (!cfg.priorityDiscoveryEnabled || !cfg.priorityDiscoveryJupiterRefreshEnabled) {
    return { refreshed: 0, skipped: 0, errors: 0 };
  }
  if (priorityMintSet.size === 0) return { refreshed: 0, skipped: 0, errors: 0 };

  return refreshRowsPricesFromJupiter(
    cfg,
    rows,
    (row) => priorityMintSet.has(row.mint) && !skipMints.has(row.mint),
    cfg.priorityDiscoveryJupiterRefreshMaxPerTick,
  );
}
