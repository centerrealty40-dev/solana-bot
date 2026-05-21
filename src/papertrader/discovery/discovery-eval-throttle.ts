/** Per-mint last full discovery eval timestamp (ms). Shared by dip-clones + priority registry. */
export const evaluatedAtMap = new Map<string, number>();

export function getRecentlyEvaluatedMints(maxAgeMin: number): string[] {
  if (!(maxAgeMin > 0)) return [];
  const cutoff = Date.now() - maxAgeMin * 60_000;
  const out: string[] = [];
  for (const [mint, ts] of evaluatedAtMap) {
    if (ts >= cutoff) out.push(mint);
  }
  return out;
}

export function shouldEvaluateMint(mint: string, reevalAfterSec: number): boolean {
  const last = evaluatedAtMap.get(mint) || 0;
  if (Date.now() - last < reevalAfterSec * 1000) return false;
  evaluatedAtMap.set(mint, Date.now());
  return true;
}

export function peekLastEvalTs(mint: string): number {
  return evaluatedAtMap.get(mint) ?? 0;
}
