/**
 * Large liquid names: skip artificial exits (hold-cap / vol-fade) and only
 * mirror the leader. Thresholds are live Dex metrics at decision time.
 */
export type LeaderFollowOnlyConfig = {
  /** Min live mcap USD to disable timeouts. **0** = exempt off. */
  leaderFollowOnlyMinMcapUsd: number;
  /** Min live 1h volume USD (with mcap floor). **0** = exempt off. */
  leaderFollowOnlyMinVolume1hUsd: number;
};

export function isLeaderFollowOnlyMarket(
  cfg: LeaderFollowOnlyConfig,
  input: { marketCapUsd?: number | null; volume1hUsd?: number | null },
): boolean {
  if (!(cfg.leaderFollowOnlyMinMcapUsd > 0) || !(cfg.leaderFollowOnlyMinVolume1hUsd > 0)) {
    return false;
  }
  const mcap = input.marketCapUsd;
  const vol1h = input.volume1hUsd;
  if (mcap == null || !(mcap > 0) || vol1h == null || !(vol1h > 0)) return false;
  return mcap + 1e-9 >= cfg.leaderFollowOnlyMinMcapUsd && vol1h + 1e-9 >= cfg.leaderFollowOnlyMinVolume1hUsd;
}
