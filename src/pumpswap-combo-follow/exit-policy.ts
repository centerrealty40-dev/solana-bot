/** Stop-loss gating — do not exit at a loss while leader still holds / averages. */

export type FollowSlMode = 'fixed' | 'while_leader_holds_off' | 'after_leader_sell';

export function parseFollowSlMode(raw: string | undefined): FollowSlMode {
  const v = (raw ?? 'while_leader_holds_off').trim().toLowerCase();
  if (v === 'fixed' || v === 'legacy') return 'fixed';
  if (v === 'after_leader_sell' || v === 'leader_sell') return 'after_leader_sell';
  return 'while_leader_holds_off';
}

export function stopLossAllowed(args: {
  slMode: FollowSlMode;
  leaderHolds: boolean;
  /** Any leader sell observed on this mint since our entry opened. */
  leaderSoldSinceOpen: boolean;
}): boolean {
  switch (args.slMode) {
    case 'fixed':
      return true;
    case 'while_leader_holds_off':
      return !args.leaderHolds;
    case 'after_leader_sell':
      return args.leaderSoldSinceOpen && !args.leaderHolds;
    default:
      return !args.leaderHolds;
  }
}
