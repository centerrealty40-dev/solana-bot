import { fetch } from 'undici';
import { fetchDexScreenerQuoteViaCache } from '../../papertrader/pricing/dexscreener-quote-cache.js';
import type { AwakeningDexMarket } from './awakening-types.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function pos(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickBestSolanaPair(pairs: unknown[], mint: string): Record<string, unknown> | null {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const relevant = pairs.filter((p) => {
    const row = p as { chainId?: string; baseToken?: { address?: string }; quoteToken?: { address?: string } };
    if (row.chainId && row.chainId !== 'solana') return false;
    const base = row.baseToken?.address ?? '';
    const quote = row.quoteToken?.address ?? '';
    return base === mint || quote === mint;
  });
  const pool = relevant.length > 0 ? relevant : pairs;
  let best: Record<string, unknown> | null = null;
  let bestLiq = -1;
  for (const p of pool) {
    const row = p as { liquidity?: { usd?: number } };
    const liq = Number(row.liquidity?.usd ?? 0);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p as Record<string, unknown>;
    }
  }
  return best;
}

function pairToMarket(mint: string, pair: Record<string, unknown> | null, fetchedAtMs: number): AwakeningDexMarket | null {
  if (!pair) return null;
  const volume = pair.volume as { m5?: number; h1?: number; h6?: number; h24?: number } | undefined;
  const txns = pair.txns as { m5?: { buys?: number; sells?: number } } | undefined;
  const priceChange = pair.priceChange as { m5?: number; h1?: number; h6?: number; h24?: number } | undefined;
  const baseToken = pair.baseToken as { address?: string } | undefined;
  const priceUsd = pos(pair.priceUsd);
  if (priceUsd == null) return null;

  const baseMint = baseToken?.address ?? mint;
  if (baseMint !== mint && baseMint !== SOL_MINT) {
    // Only evaluate the requested token mint as base.
    const quote = (pair.quoteToken as { address?: string } | undefined)?.address;
    if (quote !== mint) return null;
  }

  const pairCreatedAt = num((pair as { pairCreatedAt?: number }).pairCreatedAt);
  const poolAgeMin =
    pairCreatedAt != null && pairCreatedAt > 0
      ? Math.max(0, (fetchedAtMs - pairCreatedAt) / 60_000)
      : null;

  return {
    mint,
    priceUsd,
    marketCapUsd: pos((pair as { marketCap?: number }).marketCap ?? (pair as { fdv?: number }).fdv),
    liquidityUsd: pos((pair.liquidity as { usd?: number } | undefined)?.usd),
    volume5mUsd: pos(volume?.m5),
    volume1hUsd: pos(volume?.h1),
    volume6hUsd: pos(volume?.h6),
    volume24hUsd: pos(volume?.h24),
    buys5m: num(txns?.m5?.buys),
    sells5m: num(txns?.m5?.sells),
    priceChangeM5: num(priceChange?.m5),
    priceChangeH1: num(priceChange?.h1),
    priceChangeH6: num(priceChange?.h6),
    priceChangeH24: num(priceChange?.h24),
    pairAddress: (pair.pairAddress as string | undefined) ?? null,
    dexId: (pair.dexId as string | undefined) ?? null,
    poolAgeMin,
    fetchedAtMs,
  };
}

/** Full DexScreener pair (h6, txns, priceChange) for awakening gates. */
export async function fetchAwakeningDexMarket(
  mint: string,
  opts?: { fetchImpl?: typeof fetch; nowMs?: number },
): Promise<AwakeningDexMarket | null> {
  if (!mint || mint === SOL_MINT) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const doFetch = opts?.fetchImpl ?? fetch;

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const json = (await res.json()) as { pairs?: unknown[] };
    const pair = pickBestSolanaPair(json.pairs ?? [], mint);
    return pairToMarket(mint, pair, nowMs);
  } catch {
    return null;
  }
}

/** Lighter path via shared quote cache when full pair already warm. */
export async function fetchAwakeningDexMarketCached(mint: string): Promise<AwakeningDexMarket | null> {
  const snap = await fetchDexScreenerQuoteViaCache(mint);
  if (!snap?.priceUsd) return null;
  return {
    mint,
    priceUsd: snap.priceUsd,
    marketCapUsd: snap.marketCapUsd,
    liquidityUsd: snap.liquidityUsd,
    volume5mUsd: snap.volume5mUsd,
    volume1hUsd: snap.volume1hUsd,
    volume6hUsd: null,
    volume24hUsd: null,
    buys5m: null,
    sells5m: null,
    priceChangeM5: null,
    priceChangeH1: null,
    priceChangeH6: null,
    priceChangeH24: null,
    pairAddress: null,
    dexId: null,
    poolAgeMin: null,
    fetchedAtMs: snap.fetchedAtMs ?? Date.now(),
  };
}
