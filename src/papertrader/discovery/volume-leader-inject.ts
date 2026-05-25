import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';
import { fetchCrossVenueSnapshotRowsByVolumeCanonical } from './snapshot.js';
import { fetchVolumeLeaderMints } from './volume-leader-query.js';

/**
 * Volume-leader tier: top-N mints by 24h peak volume_1h всегда получают dip-eval
 * с канонической парой max volume (не max liq). Без SQL mcap/vol5m pre-filter.
 */
export async function injectVolumeLeaderCandidates(
  cfg: PaperTraderConfig,
  _snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }>,
): Promise<{
  injected: Array<{ row: SnapshotCandidateRow; lane: Lane }>;
  volumeLeaderMintSet: Set<string>;
}> {
  const leaderMints = await fetchVolumeLeaderMints(cfg);
  const volumeLeaderMintSet = new Set(leaderMints);
  if (!cfg.volumeLeaderEnabled || leaderMints.length === 0) {
    return { injected: [], volumeLeaderMintSet };
  }

  const rowsByMint = await fetchCrossVenueSnapshotRowsByVolumeCanonical(cfg, leaderMints, {
    canonicalByVolume: true,
  });
  const injected: Array<{ row: SnapshotCandidateRow; lane: Lane }> = [];
  const lane: Lane = 'post_migration';

  for (const mint of leaderMints) {
    const row = rowsByMint.get(mint);
    if (!row) continue;
    injected.push({ row, lane });
  }

  return { injected, volumeLeaderMintSet };
}
