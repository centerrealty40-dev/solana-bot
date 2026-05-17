import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';
import { fetchLatestCrossVenueSnapshotRowForMint } from './snapshot.js';

const DEFAULT_WHITELIST_LOOKBACK_MIN = 60;

function whitelistLookbackMinutes(cfg: PaperTraderConfig): number {
  const n = cfg.whitelistSnapshotLookbackMin;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WHITELIST_LOOKBACK_MIN;
}

/**
 * Whitelist mints must be evaluated even when crowded out of SQL `snapshotCandidateLimit`.
 * Probe PG (wider lookback than main lane) and append rows for full dip/policy eval.
 */
export async function injectWhitelistDiscoveryCandidates(
  cfg: PaperTraderConfig,
  snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }>,
): Promise<Array<{ row: SnapshotCandidateRow; lane: Lane }>> {
  const wl = cfg.discoveryDeepAuditWhitelistMintSet;
  if (!wl || wl.size === 0) return [];
  const have = new Set(snapshotTagged.map((x) => x.row.mint));
  const lookbackMin = whitelistLookbackMinutes(cfg);
  const lane: Lane = 'post_migration';
  const added: Array<{ row: SnapshotCandidateRow; lane: Lane }> = [];
  for (const mint of wl) {
    if (have.has(mint)) continue;
    const row = await fetchLatestCrossVenueSnapshotRowForMint(mint, { lookbackMinutes: lookbackMin });
    if (!row) continue;
    added.push({ row, lane });
    have.add(mint);
  }
  return added;
}
