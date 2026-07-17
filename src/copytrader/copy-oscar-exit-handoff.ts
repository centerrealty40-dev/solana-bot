import type { CopyTraderConfig } from './config.js';
import { copyOscarHandoffEligibleForPosition } from './copy-oscar-handoff-eligibility.js';
import { usesOscarExitPolicy } from './exit-mode.js';
import { appendCopyEvent } from './executor.js';
import type { CopyPosition, CopyTraderState } from './state.js';

/** After copy buy: Oscar owns exit (half8_runner); copy-trader stops leader mirror sells. */
export function handoffCopyPositionToOscarExit(args: {
  cfg: CopyTraderConfig;
  state: CopyTraderState;
  pos: CopyPosition;
  leaderSignature?: string;
}): boolean {
  if (!usesOscarExitPolicy(args.cfg)) return false;
  if (args.pos.oscarPromotedAt) return true;

  const elig = copyOscarHandoffEligibleForPosition(args.pos);
  if (!elig.eligible) {
    appendCopyEvent(args.cfg, {
      kind: 'copy_oscar_handoff_skipped',
      mint: args.pos.mint,
      symbol: args.pos.symbol,
      leaderSignature: args.leaderSignature ?? null,
      reason: elig.blockReason ?? 'mcap_ineligible',
      entryMcapUsd: args.pos.entryMcapUsd ?? null,
      mcapUsd: elig.mcapUsd ?? null,
      exitMode: args.cfg.exitMode,
    });
    return false;
  }

  const promotedAt = Date.now();
  args.pos.oscarPromotedAt = promotedAt;

  appendCopyEvent(args.cfg, {
    kind: 'copy_oscar_exit_handoff',
    mint: args.pos.mint,
    symbol: args.pos.symbol,
    leaderSignature: args.leaderSignature ?? null,
    oscarPromotedAt: promotedAt,
    exitMode: args.cfg.exitMode,
    sizeUsd: args.pos.sizeUsd,
    entryDeployedCostUsd: args.pos.entryDeployedCostUsd ?? args.pos.sizeUsd,
  });

  return true;
}
