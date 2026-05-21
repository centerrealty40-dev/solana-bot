import { getNearReadyDipWatchlist } from '../discovery-health-window.js';
import { getRecentlyEvaluatedMints } from './discovery-eval-throttle.js';
import type { PaperTraderConfig } from '../config.js';

/** Mint'ы с открытой позицией — обновляются из `papertrader/main` каждый discovery-tick. */
let openMintSet = new Set<string>();

export function syncPriorityOpenMints(mints: Iterable<string>): void {
  openMintSet = new Set(
    [...mints].map((m) => String(m ?? '').trim()).filter((m) => m.length >= 32),
  );
}

export function getPriorityOpenMints(): ReadonlySet<string> {
  return openMintSet;
}

/**
 * Полный набор mint'ов для 24/7 dip-watch (без whitelist):
 * open positions + near-ready + недавно eval'нутые из SQL-пула.
 */
export function buildPriorityDiscoveryMintSet(cfg: PaperTraderConfig): Set<string> {
  const out = new Set<string>();
  if (!cfg.priorityDiscoveryEnabled) return out;

  for (const m of openMintSet) out.add(m);

  for (const item of getNearReadyDipWatchlist()) {
    const m = String(item.mint ?? '').trim();
    if (m.length >= 32) out.add(m);
  }

  const recentMin = cfg.priorityDiscoveryRecentEvalMin;
  if (recentMin > 0) {
    for (const m of getRecentlyEvaluatedMints(recentMin)) out.add(m);
  }

  const max = cfg.priorityDiscoveryMaxMints;
  if (out.size <= max) return out;

  /** При переполнении: open > near-ready > recent (по порядку добавления выше). */
  const trimmed = new Set<string>();
  for (const m of openMintSet) {
    trimmed.add(m);
    if (trimmed.size >= max) return trimmed;
  }
  for (const item of getNearReadyDipWatchlist()) {
    const m = String(item.mint ?? '').trim();
    if (m.length >= 32 && !trimmed.has(m)) trimmed.add(m);
    if (trimmed.size >= max) return trimmed;
  }
  for (const m of getRecentlyEvaluatedMints(recentMin)) {
    if (!trimmed.has(m)) trimmed.add(m);
    if (trimmed.size >= max) return trimmed;
  }
  return trimmed;
}

export function isPriorityDiscoveryMint(cfg: PaperTraderConfig, mint: string): boolean {
  if (!cfg.priorityDiscoveryEnabled) return false;
  return buildPriorityDiscoveryMintSet(cfg).has(mint);
}
