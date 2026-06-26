/** Comma/space-separated coin symbols blocked from new entries (live + paper). */
export function loadBlockedCoinSymbols(): Set<string> {
  const out = new Set<string>();
  const raw = process.env.HL_TWAP_COIN_BLOCKLIST?.trim();
  if (!raw) return out;
  for (const part of raw.split(/[\s,;]+/)) {
    const s = part.trim().toUpperCase();
    if (s) out.add(s);
  }
  return out;
}

let cached: Set<string> | null = null;

export function blockedCoinSymbols(): Set<string> {
  if (!cached) cached = loadBlockedCoinSymbols();
  return cached;
}

export function isBlockedCoin(coin: string | null | undefined, displaySymbol?: string | null): boolean {
  const blocked = blockedCoinSymbols();
  if (blocked.size === 0) return false;
  const c = coin?.trim().toUpperCase();
  const d = displaySymbol?.trim().toUpperCase();
  return (c != null && c !== '' && blocked.has(c)) || (d != null && d !== '' && blocked.has(d));
}

/** Test helper — reset env cache after env mutation. */
export function resetBlockedCoinCache(): void {
  cached = null;
}
