/**
 * Post-exit mint cooldown. Losing trades get a longer pause so we do not
 * rebuy a grinding dump every `mintCooldownMs` cycle.
 */

export function cooldownMsAfterExit(args: {
  pnlPct: number | null | undefined;
  /** Baseline after any close (default 5m). */
  mintCooldownMs: number;
  /** After realized/mark pnl &lt; 0 (default 10m). 0 = same as baseline. */
  lossCooldownMs: number;
}): { cooldownMs: number; kind: 'base' | 'loss' } {
  const base = Math.max(0, args.mintCooldownMs);
  const lossCd = Math.max(0, args.lossCooldownMs);
  const pnl = args.pnlPct;
  const isLoss = pnl != null && Number.isFinite(pnl) && pnl < 0;
  if (isLoss && lossCd > base) {
    return { cooldownMs: lossCd, kind: 'loss' };
  }
  if (isLoss && lossCd > 0) {
    return { cooldownMs: Math.max(base, lossCd), kind: 'loss' };
  }
  return { cooldownMs: base, kind: 'base' };
}
