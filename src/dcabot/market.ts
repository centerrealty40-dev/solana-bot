/**
 * dca_frontrun — market data (read-only). Dexscreener for price/liquidity/age (no key),
 * Jupiter lite price API as a fallback. Used both for paper fill prices and the scorer.
 */
export type TokenMarket = {
  mint: string;
  symbol: string | null;
  priceUsd: number;
  liquidityUsd: number;
  marketCap: number;
  volume24h: number;
  ageMin: number | null;
};

const cache = new Map<string, { at: number; data: TokenMarket | null }>();
const TTL_MS = 8000;

async function fetchJson(url: string, timeoutMs = 6000): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fromDexscreener(mint: string): Promise<TokenMarket | null> {
  const data = (await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)) as
    | { pairs?: any[] }
    | null;
  const pairs = data?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const solPairs = pairs.filter((p) => p?.chainId === 'solana');
  const best = (solPairs.length ? solPairs : pairs).sort(
    (a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0),
  )[0];
  if (!best) return null;
  const base = best.baseToken?.address === mint ? best.baseToken : best.quoteToken;
  const created = Number(best.pairCreatedAt || 0);
  return {
    mint,
    symbol: base?.symbol || null,
    priceUsd: Number(best.priceUsd || 0),
    liquidityUsd: Number(best.liquidity?.usd || 0),
    marketCap: Number(best.marketCap || best.fdv || 0),
    volume24h: Number(best.volume?.h24 || 0),
    ageMin: created > 0 ? (Date.now() - created) / 60000 : null,
  };
}

async function jupiterPriceUsd(mint: string): Promise<number> {
  const data = (await fetchJson(`https://lite-api.jup.ag/price/v2?ids=${mint}`)) as
    | { data?: Record<string, { price?: string | number }> }
    | null;
  const p = data?.data?.[mint]?.price;
  const n = Number(p);
  return Number.isFinite(n) ? n : 0;
}

export async function getTokenMarket(mint: string): Promise<TokenMarket | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  let m = await fromDexscreener(mint);
  if ((!m || m.priceUsd <= 0)) {
    const px = await jupiterPriceUsd(mint);
    if (px > 0) {
      m = m
        ? { ...m, priceUsd: px }
        : { mint, symbol: null, priceUsd: px, liquidityUsd: 0, marketCap: 0, volume24h: 0, ageMin: null };
    }
  }
  cache.set(mint, { at: Date.now(), data: m });
  return m;
}

export async function getPriceUsd(mint: string): Promise<number> {
  const m = await getTokenMarket(mint);
  return m?.priceUsd ?? 0;
}

/**
 * Rough estimate of how much the DCA's remaining buying will push price, as a percentage.
 * Uses a simple constant-product-style impact: remainingBuyUsd / liquidityUsd.
 */
export function estimateGainPct(remainingBuyUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 0;
  return (remainingBuyUsd / liquidityUsd) * 100;
}
