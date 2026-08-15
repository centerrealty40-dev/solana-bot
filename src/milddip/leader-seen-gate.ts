import type { MildDipConfig } from './config.js';
import { leaderSeedHitByMint, readLeaderSeedHits } from './discover-extra.js';
import type { MildDipState } from './state.js';

/** Rolling window for "a leader has traded this mint" (state memory). */
export function leaderEverSeenInState(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
): boolean {
  if (cfg.leaderSeenMemoryMs <= 0) return false;
  const ts = state.leaderSeenMints?.[mint];
  return ts != null && nowMs - ts <= cfg.leaderSeenMemoryMs;
}

function leaderSeenWindowMs(cfg: MildDipConfig): number {
  if (cfg.leaderSeenMemoryMs > 0) return cfg.leaderSeenMemoryMs;
  return cfg.requireLeaderSeenMaxAgeMs;
}

/**
 * Final buy gate: mint must appear in leader seed or remembered leader memory.
 * Used at entry-attempt so stream/discover/wait_dip cannot solo-buy unknown names.
 */
export function leaderBuyGateOk(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
): boolean {
  if (!cfg.requireLeaderSeen) return true;
  if (leaderEverSeenInState(cfg, state, mint, nowMs)) return true;
  const windowMs = leaderSeenWindowMs(cfg);
  const hit = leaderSeedHitByMint(
    readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
      maxAgeMs: windowMs,
      max: cfg.leaderSeedMax,
    }),
    mint,
  );
  return hit != null;
}
