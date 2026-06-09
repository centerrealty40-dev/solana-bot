import type { FollowPosition } from './types.js';

export function followHoldSec(pos: FollowPosition, nowMs: number = Date.now()): number {
  return Math.max(0, Math.round((nowMs - pos.openedAt) / 1000));
}

export function followMaxHoldDue(pos: FollowPosition, maxHoldMs: number, nowMs: number = Date.now()): boolean {
  if (!(maxHoldMs > 0)) return false;
  return nowMs - pos.openedAt >= maxHoldMs;
}
