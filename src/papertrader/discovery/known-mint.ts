import type { PaperTraderConfig } from '../config.js';

/** Journal-derived trade timestamps for known-mint detection (14d lookback default). */
export type KnownMintTradeHistory = {
  lastEntryTsByMint: ReadonlyMap<string, number>;
  lastPostExitBuyCooldownTsByMint: ReadonlyMap<string, number>;
  lastRealExitTsByMint: ReadonlyMap<string, { exitTs: number }>;
  lastExitTsByMint: ReadonlyMap<string, { exitTs: number }>;
};

/**
 * Prior bot open/close within lookback — mint is "known" (not a first-time discovery).
 * Used for stricter volume guards on new mints; PG gap bypass uses {@link isPgCoverageKnownMint}.
 */
/** Journal history + optional whitelist/graduated supplement (repeat-traded mints). */
export function isKnownMint(
  cfg: PaperTraderConfig,
  mint: string,
  history: KnownMintTradeHistory,
  nowMs = Date.now(),
  supplement?: ReadonlySet<string>,
): boolean {
  const key = mint.trim();
  if (key && supplement?.has(key)) return true;
  const days = cfg.pgDataCoverageKnownMintLookbackDays;
  if (!(days > 0)) return false;
  const cutoff = nowMs - days * 24 * 3_600_000;
  const tsCandidates = [
    history.lastEntryTsByMint.get(mint) ?? 0,
    history.lastPostExitBuyCooldownTsByMint.get(mint) ?? 0,
    history.lastRealExitTsByMint.get(mint)?.exitTs ?? 0,
    history.lastExitTsByMint.get(mint)?.exitTs ?? 0,
  ];
  return tsCandidates.some((ts) => ts >= cutoff);
}

/** PG gap bypass: known mint + feature flag (PR #302 — do not loosen). */
export function isPgCoverageKnownMint(
  cfg: PaperTraderConfig,
  mint: string,
  history: KnownMintTradeHistory,
  nowMs = Date.now(),
): boolean {
  if (!cfg.pgDataCoverageKnownMintGapBypass) return false;
  return isKnownMint(cfg, mint, history, nowMs);
}

/**
 * Prior bot trade (any lane) within lookback — familiar repeat-traded mint (audit/logging only).
 * Gate bypass removed: pg_stale / volume guards use fresh Dex quote SSOT (#404, #409).
 */
export function isFamiliarMint(
  cfg: PaperTraderConfig,
  mint: string,
  history: KnownMintTradeHistory,
  nowMs = Date.now(),
  supplement?: ReadonlySet<string>,
): boolean {
  return isKnownMint(cfg, mint, history, nowMs, supplement);
}

export function buildKnownMintTradeHistory(args: {
  lastEntryTsByMint: ReadonlyMap<string, number>;
  lastPostExitBuyCooldownTsByMint: ReadonlyMap<string, number>;
  lastRealExitMarketSnapshotByMint: ReadonlyMap<string, { exitTs: number }>;
  lastExitMarketSnapshotByMint: ReadonlyMap<string, { exitTs: number }>;
}): KnownMintTradeHistory {
  return {
    lastEntryTsByMint: args.lastEntryTsByMint,
    lastPostExitBuyCooldownTsByMint: args.lastPostExitBuyCooldownTsByMint,
    lastRealExitTsByMint: args.lastRealExitMarketSnapshotByMint,
    lastExitTsByMint: args.lastExitMarketSnapshotByMint,
  };
}
