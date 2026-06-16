/**
 * 1.11.458 — in-memory executable sell price cache for open positions (hot-path Phase 1).
 */

export interface OpenPositionExecSellSnapshot {
  mint: string;
  sellUsdPerToken: number;
  quoteAgeMs: number;
  updatedAtMs: number;
  probeTokenRaw: string;
  wsolOutLamports: string;
}

const cache = new Map<string, OpenPositionExecSellSnapshot>();

export function setOpenPositionExecSellUsd(mint: string, snap: OpenPositionExecSellSnapshot): void {
  cache.set(mint, snap);
}

export function getOpenPositionExecSellUsd(mint: string): number | null {
  const row = cache.get(mint);
  if (!row || !(row.sellUsdPerToken > 0)) return null;
  return row.sellUsdPerToken;
}

export function getOpenPositionExecSellSnapshot(mint: string): OpenPositionExecSellSnapshot | null {
  return cache.get(mint) ?? null;
}

export function isOpenPositionExecSellFresh(mint: string, maxAgeMs: number): boolean {
  const row = cache.get(mint);
  if (!row) return false;
  const age = Date.now() - row.updatedAtMs;
  return age >= 0 && age <= maxAgeMs;
}

export function listOpenPositionExecPriceMints(): string[] {
  return [...cache.keys()];
}

export function clearOpenPositionExecSellUsd(mint: string): void {
  cache.delete(mint);
}

export function _resetOpenPositionExecPriceCacheForTests(): void {
  cache.clear();
}

/** SOL proceeds / token amount → USD per token. */
export function sellUsdPerTokenFromQuote(args: {
  wsolOutLamports: bigint;
  tokenAmountRaw: bigint;
  solUsd: number;
  decimals: number;
}): number | null {
  const { wsolOutLamports, tokenAmountRaw, solUsd, decimals } = args;
  if (!(solUsd > 0) || tokenAmountRaw <= 0n || wsolOutLamports <= 0n) return null;
  const solOut = Number(wsolOutLamports) / 1e9;
  const tokens = Number(tokenAmountRaw) / 10 ** decimals;
  if (!(tokens > 0) || !(solOut > 0)) return null;
  const px = (solOut * solUsd) / tokens;
  return Number.isFinite(px) && px > 0 ? px : null;
}

export function wsolOutLamportsFromJupiterSellQuote(q: Record<string, unknown>): bigint | null {
  const out = q.outAmount;
  if (typeof out === 'string' && /^\d+$/.test(out)) return BigInt(out);
  return null;
}
