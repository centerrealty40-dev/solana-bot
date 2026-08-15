export function recoverDeferIsCapped(pnlPct: number, maxPnlPct: number): boolean {
  return maxPnlPct > 0 && pnlPct >= maxPnlPct;
}
