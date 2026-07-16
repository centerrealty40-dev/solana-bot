import type { OpenTrade } from './types.js';
import { stampLiveOscarTradeLaneOnOpen } from './live-oscar-scalp-wave.js';

export const DORMANT_AWAKENING_MAP_SUFFIX = '::dormant_awakening';

export function dormantAwakeningOpenMapKey(mint: string): string {
  return `${mint}${DORMANT_AWAKENING_MAP_SUFFIX}`;
}

export function isDormantAwakeningOpenMapKey(key: string): boolean {
  return key.endsWith(DORMANT_AWAKENING_MAP_SUFFIX);
}

export function isDormantAwakeningTrade(
  ot: Pick<OpenTrade, 'liveOscarTradeLane' | 'liveExitPolicyId' | 'positionSource'>,
): boolean {
  if (ot.liveOscarTradeLane === 'dormant_awakening') return true;
  return ot.liveExitPolicyId === 'dormant_awakening_v1';
}

export function dormantAwakeningMintAlreadyOpen(
  open: ReadonlyMap<string, OpenTrade>,
  mint: string,
): boolean {
  if (open.has(dormantAwakeningOpenMapKey(mint))) return true;
  const ot = open.get(mint);
  return ot != null && isDormantAwakeningTrade(ot);
}

export function countOpenDormantAwakeningPositions(open: ReadonlyMap<string, OpenTrade>): number {
  let n = 0;
  for (const ot of open.values()) {
    if (isDormantAwakeningTrade(ot)) n += 1;
  }
  return n;
}

export function stampDormantAwakeningOnOpen(ot: OpenTrade): void {
  stampLiveOscarTradeLaneOnOpen(ot, 'dormant_awakening');
}

/** Re-key awakening opens to `mint::dormant_awakening` after journal/snapshot replay at bare mint. */
export function normalizeDormantAwakeningOpenMapKeys(open: Map<string, OpenTrade>): number {
  let migrated = 0;
  for (const [key, ot] of [...open.entries()]) {
    if (!isDormantAwakeningTrade(ot)) continue;
    stampDormantAwakeningOnOpen(ot);
    const canon = dormantAwakeningOpenMapKey(ot.mint);
    if (key === canon) continue;
    open.delete(key);
    open.set(canon, ot);
    migrated += 1;
  }
  return migrated;
}
