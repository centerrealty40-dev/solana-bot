import type { CopyTraderConfig } from './config.js';

/** Skip leader rebuy when we missed first entry and have no bag (legacy ignore path). */
export function shouldIgnoreMissedEntryLeaderRebuy(
  cfg: Pick<CopyTraderConfig, 'allowLateEntryOnLeaderRebuy'>,
  preLeaderRaw: bigint,
): boolean {
  return preLeaderRaw > 0n && !cfg.allowLateEntryOnLeaderRebuy;
}
