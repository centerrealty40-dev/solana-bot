import type { CopyTraderConfig } from './config.js';

function randomInRangeMs(minMs: number, maxMs: number): number {
  const min = Math.max(0, minMs);
  const max = Math.max(min, maxMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Fast mirror delay for leader add / partial sell (default 5?10 s). */
export function randomMirrorActionDelayMs(cfg: CopyTraderConfig): number {
  return randomInRangeMs(cfg.mirrorActionDelayMinMs, cfg.mirrorActionDelayMaxMs);
}

export function entryBuyDelayMs(cfg: CopyTraderConfig): number {
  return Math.max(0, cfg.buyDelayMs);
}
