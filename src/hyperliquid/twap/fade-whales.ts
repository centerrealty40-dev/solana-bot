import type { TwapSide } from './types.js';

function normAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Comma/space-separated whale addresses — we enter opposite to their TWAP side. */
export function loadFadeWhaleAddresses(): Set<string> {
  const out = new Set<string>();
  const raw = process.env.HL_TWAP_FADE_WHALES?.trim();
  if (!raw) return out;
  for (const part of raw.split(/[\s,;]+/)) {
    const a = normAddr(part);
    if (a.startsWith('0x') && a.length >= 10) out.add(a);
  }
  return out;
}

let cached: Set<string> | null = null;

export function fadeWhaleAddresses(): Set<string> {
  if (!cached) cached = loadFadeWhaleAddresses();
  return cached;
}

export function isFadeWhale(user: string | null | undefined): boolean {
  if (!user) return false;
  return fadeWhaleAddresses().has(normAddr(user));
}

export function invertTwapSide(side: TwapSide): TwapSide {
  return side === 'buy' ? 'sell' : 'buy';
}

/** Our perp side for this whale TWAP (fade → opposite of whale direction). */
export function hlTwapEntrySide(user: string | null | undefined, whaleSide: TwapSide): TwapSide {
  if (isFadeWhale(user)) return invertTwapSide(whaleSide);
  return whaleSide;
}

/** Test helper — reset env cache after env mutation. */
export function resetFadeWhaleCache(): void {
  cached = null;
}
