import type { PaperTraderConfig } from '../config.js';
import { passesDiscoveryMinMarketCap } from '../filters/snapshot-filter.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';
import { fetchLatestCrossVenueSnapshotRowForMint } from './snapshot.js';
import { buildPriorityDiscoveryMintSet } from './priority-discovery-registry.js';

/**
 * Priority tier: mint'ы вне SQL top-N / vol5m floor всё равно получают полный dip-eval.
 * Заменяет ops-whitelist для prod при `LIVE_MINT_WHITELIST_ENABLED=0`.
 */
export async function injectPriorityDiscoveryCandidates(
  cfg: PaperTraderConfig,
  snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }>,
): Promise<{
  injected: Array<{ row: SnapshotCandidateRow; lane: Lane }>;
  priorityMintSet: Set<string>;
}> {
  const priorityMintSet = buildPriorityDiscoveryMintSet(cfg);
  if (!cfg.priorityDiscoveryEnabled || priorityMintSet.size === 0) {
    return { injected: [], priorityMintSet };
  }

  const have = new Set(snapshotTagged.map((x) => x.row.mint));
  const lookbackMin = cfg.priorityDiscoveryLookbackMin;
  const lane: Lane = 'post_migration';
  const injected: Array<{ row: SnapshotCandidateRow; lane: Lane }> = [];

  for (const mint of priorityMintSet) {
    if (have.has(mint)) continue;
    const row = await fetchLatestCrossVenueSnapshotRowForMint(mint, { lookbackMinutes: lookbackMin });
    if (!row) continue;
    if (!passesDiscoveryMinMarketCap(cfg, row)) continue;
    injected.push({ row, lane });
    have.add(mint);
  }

  return { injected, priorityMintSet };
}
