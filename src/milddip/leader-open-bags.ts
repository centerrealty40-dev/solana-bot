export type LeaderOpenBagEntry = {
  mint: string;
  leader: string;
  fillPriceUsd: number;
  sizeUsd: number;
  leaderBuyAtMs: number;
  lastCheckAtMs: number;
  lastReason: string;
};

export type LeaderOpenBagStore = Record<string, LeaderOpenBagEntry>;

function keyOf(entry: Pick<LeaderOpenBagEntry, 'mint' | 'leader'>): string {
  return `${entry.mint}|${entry.leader}`;
}

export function upsertLeaderOpenBag(
  store: LeaderOpenBagStore,
  entry: LeaderOpenBagEntry,
  maxEntries: number,
): void {
  const key = keyOf(entry);
  store[key] = entry;
  const limit = Math.max(0, Math.floor(maxEntries));
  if (limit === 0) {
    delete store[key];
    return;
  }
  const entries = Object.entries(store);
  if (entries.length <= limit) return;
  entries
    .sort(
      ([, a], [, b]) =>
        a.leaderBuyAtMs - b.leaderBuyAtMs ||
        a.lastCheckAtMs - b.lastCheckAtMs ||
        a.mint.localeCompare(b.mint) ||
        a.leader.localeCompare(b.leader),
    )
    .slice(0, entries.length - limit)
    .forEach(([oldKey]) => delete store[oldKey]);
}

export function selectLeaderOpenBagRetryKeys(args: {
  entries: LeaderOpenBagStore | readonly LeaderOpenBagEntry[];
  nowMs: number;
  intervalMs: number;
  maxPerPass: number;
}): string[] {
  const entries = Array.isArray(args.entries)
    ? args.entries.map((entry) => [keyOf(entry), entry] as const)
    : Object.entries(args.entries);
  return entries
    .filter(([, entry]) => args.nowMs - entry.lastCheckAtMs >= args.intervalMs)
    .sort(
      ([, a], [, b]) =>
        a.lastCheckAtMs - b.lastCheckAtMs ||
        a.leaderBuyAtMs - b.leaderBuyAtMs ||
        keyOf(a).localeCompare(keyOf(b)),
    )
    .slice(0, Math.max(0, Math.floor(args.maxPerPass)))
    .map(([key]) => key);
}

export function leaderOpenBagDropReason(args: {
  nowMs: number;
  entry: LeaderOpenBagEntry;
  maxAgeMs: number;
  leaderHolds: boolean;
  weHoldPosition: boolean;
  activeWatch: boolean;
}): null | 'leader_flat' | 'expired' | 'already_open' | 'active_watch' {
  if (!args.leaderHolds) return 'leader_flat';
  if (args.maxAgeMs >= 0 && args.nowMs - args.entry.leaderBuyAtMs > args.maxAgeMs) {
    return 'expired';
  }
  if (args.weHoldPosition) return 'already_open';
  if (args.activeWatch) return 'active_watch';
  return null;
}
