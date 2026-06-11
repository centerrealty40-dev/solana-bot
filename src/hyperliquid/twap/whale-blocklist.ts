/**
 * Data-driven whale blocklist: serial cancellers (🔴100%, ≥3 TWAP) with non-positive live PNL.
 * See scripts-tmp/_hl_whale_blocklist_analysis.json (2026-06-11, prod 1.11.419).
 */
export const HL_TWAP_DEFAULT_BLOCKLIST_WHALES = [
  /** 0xb676…7dbf — 🔴100% cancel (5/5), live PNL −$6.02 */
  '0xb676a78f19227ffe9a97db93263fce675e547dbf',
] as const;

function normAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Comma/space-separated extra addresses merged with built-in defaults. */
export function loadBlocklistedWhaleAddresses(): Set<string> {
  const out = new Set<string>(HL_TWAP_DEFAULT_BLOCKLIST_WHALES.map(normAddr));
  const raw = process.env.HL_TWAP_WHALE_BLOCKLIST?.trim();
  if (!raw) return out;
  for (const part of raw.split(/[\s,;]+/)) {
    const a = normAddr(part);
    if (a.startsWith('0x') && a.length >= 10) out.add(a);
  }
  return out;
}

let cached: Set<string> | null = null;

export function blocklistedWhaleAddresses(): Set<string> {
  if (!cached) cached = loadBlocklistedWhaleAddresses();
  return cached;
}

export function isBlocklistedWhale(user: string | null | undefined): boolean {
  if (!user) return false;
  return blocklistedWhaleAddresses().has(normAddr(user));
}

/** Test helper — reset env cache after env mutation. */
export function resetBlocklistedWhaleCache(): void {
  cached = null;
}
