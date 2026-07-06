import { fetchDexScreenerQuoteViaCache } from '../papertrader/pricing/dexscreener-quote-cache.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export type DexInfo = {
  symbol: string;
  name: string;
  priceUsd: number;
  marketCap: number;
  liquidityUsd: number;
  volume24h: number;
  volume1h: number;
  pairCreatedAtMs: number | null;
  dexId: string;
};

const cache = new Map<string, { at: number; val: DexInfo | null }>();

function looksLikeMintAddress(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

export async function fetchDexInfo(mint: string, solUsd: number): Promise<DexInfo | null> {
  if (!looksLikeMintAddress(mint)) return null;
  if (mint === SOL_MINT) {
    return {
      symbol: 'SOL',
      name: 'Solana',
      priceUsd: solUsd,
      marketCap: 0,
      liquidityUsd: 0,
      volume24h: 0,
      volume1h: 0,
      pairCreatedAtMs: null,
      dexId: '',
    };
  }

  const now = Date.now();
  const mem = cache.get(mint);
  if (mem && now - mem.at < 60_000) return mem.val;

  const snap = await fetchDexScreenerQuoteViaCache(mint);
  if (!snap || !(snap.priceUsd != null && snap.priceUsd > 0)) {
    cache.set(mint, { at: now, val: null });
    return null;
  }

  const info: DexInfo = {
    symbol: mint.slice(0, 8),
    name: mint.slice(0, 8),
    priceUsd: snap.priceUsd ?? 0,
    marketCap: snap.marketCapUsd ?? 0,
    liquidityUsd: snap.liquidityUsd ?? 0,
    volume24h: 0,
    volume1h: snap.volume1hUsd ?? 0,
    pairCreatedAtMs: snap.fetchedAtMs ?? null,
    dexId: '',
  };
  cache.set(mint, { at: now, val: info });
  return info;
}
