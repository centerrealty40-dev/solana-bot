/**
 * Apply shared Jupiter spot cache to discovery rows (Live Oscar / paper).
 */
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import {
  applyPriorityJupiterSpotEntryToRow,
  priorityJupiterSpotCacheMaxAgeMs,
  readPriorityJupiterSpotCache,
} from './priority-jupiter-spot-cache.js';

function spotCacheEnabled(): boolean {
  const v = process.env.PAPER_PRIORITY_JUPITER_SPOT_CACHE?.trim().toLowerCase();
  if (v === '0' || v === 'false') return false;
  return true;
}

/**
 * Override stale PG snapshot prices with fresher Jupiter v3 spot (fast watcher).
 */
export async function applyPriorityJupiterSpotCacheToRows(
  _cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  priorityMintSet: ReadonlySet<string>,
): Promise<number> {
  void _cfg;
  if (!spotCacheEnabled() || rows.length === 0 || priorityMintSet.size === 0) return 0;

  const cache = await readPriorityJupiterSpotCache();
  const maxAgeMs = priorityJupiterSpotCacheMaxAgeMs();
  let applied = 0;

  for (const row of rows) {
    if (!priorityMintSet.has(row.mint)) continue;
    const entry = cache.entries[row.mint];
    if (!entry) continue;
    if (applyPriorityJupiterSpotEntryToRow(row, entry, maxAgeMs)) applied += 1;
  }

  return applied;
}
