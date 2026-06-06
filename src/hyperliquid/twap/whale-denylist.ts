/** Prod denylist: slow multi-coin buy cluster (TON/FARTCOIN/TAO/CFX/FET), net −$24 live. */
export const HL_TWAP_DEFAULT_DENIED_WHALES = [
  '0x153c8444380512cabdc34f6cea09c322e14e319a',
] as const;

function normAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Comma/space-separated extra addresses merged with built-in defaults. */
export function loadDeniedWhaleAddresses(): Set<string> {
  const out = new Set<string>(HL_TWAP_DEFAULT_DENIED_WHALES.map(normAddr));
  const raw = process.env.HL_TWAP_WHALE_DENYLIST?.trim();
  if (!raw) return out;
  for (const part of raw.split(/[\s,;]+/)) {
    const a = normAddr(part);
    if (a.startsWith('0x') && a.length >= 10) out.add(a);
  }
  return out;
}

let cached: Set<string> | null = null;

export function deniedWhaleAddresses(): Set<string> {
  if (!cached) cached = loadDeniedWhaleAddresses();
  return cached;
}

export function isDeniedWhale(user: string | null | undefined): boolean {
  if (!user) return false;
  return deniedWhaleAddresses().has(normAddr(user));
}

/** Test helper — reset env cache after env mutation. */
export function resetDeniedWhaleCache(): void {
  cached = null;
}
