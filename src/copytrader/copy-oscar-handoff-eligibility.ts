/**
 * Oscar exit handoff only when live-oscar would adopt (mcap tier).
 * Below-threshold copy legs stay copy-managed (leader mirror sells).
 */
import { readLiveOpenSnapshot } from '../live/open-snapshot.js';
import { resolveCopyLeaderAdoptTier } from '../live/copy-leader-exit-adopt.js';
import { loadPaperTraderConfig } from '../papertrader/config.js';
import type { CopyTraderConfig } from './config.js';
import { appendCopyEvent } from './executor.js';
import { oscarOpenSnapshotPathForCopyTrader } from './oscar-position-guard.js';
import type { CopyPosition, CopyTraderState } from './state.js';

export type CopyOscarHandoffEligibility = {
  eligible: boolean;
  blockReason?: string;
  mcapUsd?: number | null;
};

export function copyOscarHandoffEligibleForPosition(
  pos: CopyPosition,
  paperCfg = loadPaperTraderConfig(),
): CopyOscarHandoffEligibility {
  const tier = resolveCopyLeaderAdoptTier(paperCfg, pos.entryMcapUsd);
  return {
    eligible: !tier.adoptBlocked,
    blockReason: tier.blockReason,
    mcapUsd: tier.mcapUsd,
  };
}

export function copyPositionOscarExitManaged(pos: CopyPosition | undefined | null): boolean {
  return pos?.oscarPromotedAt != null && pos.oscarPromotedAt > 0;
}

function oscarOpenHasMint(mint: string, snapshotPath?: string): boolean {
  const snap = readLiveOpenSnapshot(snapshotPath ?? oscarOpenSnapshotPathForCopyTrader());
  if (!snap) return false;
  return snap.positions.some((p) => p.mint === mint);
}

/**
 * Drop stale `oscarPromotedAt` when Oscar cannot adopt (below prod mcap floor).
 * Restores leader mirror exit without manual state edits.
 */
export function reconcileIneligibleOscarHandoffs(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
): number {
  let reverted = 0;
  for (const [mint, pos] of Object.entries({ ...state.positions })) {
    if (!copyPositionOscarExitManaged(pos)) continue;
    if (oscarOpenHasMint(mint)) continue;

    const elig = copyOscarHandoffEligibleForPosition(pos);
    if (elig.eligible) continue;

    delete pos.oscarPromotedAt;
    reverted += 1;
    appendCopyEvent(cfg, {
      kind: 'copy_oscar_handoff_reverted',
      mint,
      symbol: pos.symbol,
      reason: elig.blockReason ?? 'mcap_ineligible',
      entryMcapUsd: pos.entryMcapUsd ?? null,
      mcapUsd: elig.mcapUsd ?? null,
    });
  }
  return reverted;
}
