/** When we have no bag, leader buy with preBalance>0 is a late catch-up entry (not mirror-add). */
export function blocksMissedEntryLeaderAlreadyIn(args: {
  preLeaderRaw: bigint;
  hasOurPosition: boolean;
  allowLateEntryOnLeaderAdd: boolean;
}): boolean {
  if (args.hasOurPosition) return false;
  if (args.preLeaderRaw <= 0n) return false;
  return !args.allowLateEntryOnLeaderAdd;
}
