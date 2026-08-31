export type LeaderActiveGates = {
  enabled: boolean;
  windowMs: number;
};

/** Freshest known moment a leader traded this mint (state memory ∪ seed hit). */
export function leaderActiveAtMs(args: {
  leaderSeenAtMs?: number | null;
  seedHitAtMs?: number | null;
}): number | null {
  const timestamps = [args.leaderSeenAtMs, args.seedHitAtMs].filter(
    (value): value is number => value != null && Number.isFinite(value) && value > 0,
  );
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

/** True when a leader traded the mint inside the window → re-entry/runner relax. */
export function leaderActiveNow(args: {
  gates: LeaderActiveGates;
  nowMs: number;
  leaderSeenAtMs?: number | null;
  seedHitAtMs?: number | null;
}): boolean {
  const ts = leaderActiveAtMs(args);
  return (
    args.gates.enabled &&
    args.gates.windowMs > 0 &&
    ts != null &&
    args.nowMs - ts <= args.gates.windowMs
  );
}
