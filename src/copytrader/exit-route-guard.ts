const missingRoutes = new Map<string, number>();

export function markExitRouteMissing(mint: string, nowMs: number): void {
  missingRoutes.set(mint, nowMs);
}

export function isExitRouteMissingCached(mint: string, nowMs: number, ttlMs: number): boolean {
  const markedAt = missingRoutes.get(mint);
  if (markedAt == null) return false;
  if (nowMs - markedAt >= ttlMs) {
    missingRoutes.delete(mint);
    return false;
  }
  return true;
}

export function clearExitRouteMissing(mint: string): void {
  missingRoutes.delete(mint);
}

export function exitRouteGuardResetForTests(): void {
  missingRoutes.clear();
}
