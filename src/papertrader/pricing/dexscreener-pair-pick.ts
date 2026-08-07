/**
 * Pick a DexScreener pair whose `priceUsd` is trustworthy for `mint`.
 *
 * DexScreener `priceUsd` is always the **base** token price. Exotic quote pairs
 * (e.g. TOKEN/MET) sometimes publish garbage USD (SOL-like ~$128) with huge liq —
 * max-liquidity-only selection then poisons copy-trader / discovery.
 */
export const DEXSCREENER_STABLE_QUOTE_MINTS = new Set<string>([
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export const DEXSCREENER_STABLE_QUOTE_SYMBOLS = new Set<string>([
  'SOL',
  'WSOL',
  'USDC',
  'USDT',
  'USD1',
  'USDS',
]);

type PairRow = {
  chainId?: string;
  dexId?: string;
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
};

export function isDexScreenerStableQuote(pair: {
  quoteToken?: { address?: string; symbol?: string };
}): boolean {
  const addr = pair.quoteToken?.address ?? '';
  if (addr && DEXSCREENER_STABLE_QUOTE_MINTS.has(addr)) return true;
  const sym = String(pair.quoteToken?.symbol ?? '')
    .trim()
    .toUpperCase();
  return sym.length > 0 && DEXSCREENER_STABLE_QUOTE_SYMBOLS.has(sym);
}

function pairLiquidityUsd(pair: PairRow): number {
  const n = Number(pair.liquidity?.usd ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pairPriceUsd(pair: PairRow): number | null {
  const n = Number(pair.priceUsd);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function maxLiqPair(pool: PairRow[]): PairRow | null {
  let best: PairRow | null = null;
  let bestLiq = -1;
  for (const p of pool) {
    const liq = pairLiquidityUsd(p);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p;
    }
  }
  return best;
}

/**
 * Select the best Solana pair for mint pricing.
 * 1) Prefer pairs where mint is **base** (priceUsd applies to mint).
 * 2) Prefer stable quotes (SOL/USDC/USDT/…).
 * 3) Among the chosen pool, max liquidity.
 * 4) If only exotic-quote pairs exist but any stable-quote base pair exists with a
 *    sane price cluster, prefer the stable pool even at lower liq when the exotic
 *    max-liq price diverges by more than `outlierRatio` from the best stable price.
 */
export function pickBestSolanaPairForMint(
  pairs: unknown[],
  mint: string,
  opts?: {
    preferredDex?: string;
    /**
     * When set, only pairs whose dexId is in this list (case-insensitive exact)
     * are eligible. Mild-dip: avoid picking a higher-liq Meteora pool and then
     * rejecting the whole mint on ALLOWED_DEX_IDS (NEEGY / 6oGuFDbE).
     */
    allowedDexIds?: string[];
    outlierRatio?: number;
  },
): Record<string, unknown> | null {
  if (!Array.isArray(pairs) || pairs.length === 0 || !mint) return null;
  const outlierRatio = opts?.outlierRatio ?? 3;
  const allowed = (opts?.allowedDexIds ?? [])
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean);
  const allowedSet = allowed.length > 0 ? new Set(allowed) : null;
  const dexAllowed = (p: PairRow): boolean => {
    if (!allowedSet) return true;
    return allowedSet.has(String(p.dexId ?? '').toLowerCase());
  };

  const solana = pairs.filter((p) => {
    const row = p as PairRow;
    return (!row.chainId || row.chainId === 'solana') && dexAllowed(row);
  }) as PairRow[];
  if (solana.length === 0) return null;

  let asBase = solana.filter((p) => (p.baseToken?.address ?? '') === mint);
  // Fallback: mint as quote — rare; priceUsd is for base, so skip for pricing unless no base pairs.
  const asQuoteOnly = asBase.length === 0
    ? solana.filter((p) => (p.quoteToken?.address ?? '') === mint)
    : [];

  let pool: PairRow[] = asBase.length > 0 ? asBase : asQuoteOnly;
  if (pool.length === 0) pool = solana;

  const dexNeedle = opts?.preferredDex?.trim().toLowerCase();
  if (dexNeedle) {
    const dexPool = pool.filter((p) => String(p.dexId ?? '').toLowerCase().includes(dexNeedle));
    if (dexPool.length > 0) pool = dexPool;
  }

  if (asBase.length > 0) {
    const stable = asBase.filter((p) => isDexScreenerStableQuote(p));
    if (stable.length > 0) {
      const bestStable = maxLiqPair(stable);
      const bestAny = maxLiqPair(asBase);
      const stablePx = bestStable ? pairPriceUsd(bestStable) : null;
      const anyPx = bestAny ? pairPriceUsd(bestAny) : null;
      if (bestStable && stablePx != null) {
        if (
          !bestAny ||
          bestAny === bestStable ||
          anyPx == null ||
          isDexScreenerStableQuote(bestAny)
        ) {
          return bestStable as Record<string, unknown>;
        }
        const ratio = Math.max(anyPx / stablePx, stablePx / anyPx);
        // Exotic max-liq disagrees hard with stable quote → keep stable (Ge87/MET ≈ $128 vs SOL ≈ $0.026).
        if (ratio > outlierRatio) return bestStable as Record<string, unknown>;
      }
      // Exotic agrees or no stable price — still prefer stable pool max liq.
      return (maxLiqPair(stable) ?? bestStable) as Record<string, unknown>;
    }
  }

  return maxLiqPair(pool) as Record<string, unknown> | null;
}

/**
 * True when `candidatePx` diverges from `anchorPx` by more than `maxRatio` (default 2×).
 * Used by copy-trader to reject garbage Dex vs leader fill price.
 */
export function isUsdPriceOutlierVsAnchor(
  candidatePx: number,
  anchorPx: number,
  maxRatio = 2,
): boolean {
  if (!(candidatePx > 0) || !(anchorPx > 0) || !(maxRatio > 1)) return false;
  const ratio = Math.max(candidatePx / anchorPx, anchorPx / candidatePx);
  return ratio > maxRatio;
}
