import { request } from 'undici';
import { child } from '../core/logger.js';
import { QUOTE_MINTS } from '../core/constants.js';

const log = child('jupiter-price');

/**
 * We try multiple Jupiter price endpoints because they keep migrating
 * and silently breaking the previous one. Order = preference.
 */
const JUP_PRICE_ENDPOINTS = [
  'https://lite-api.jup.ag/price/v3',
  'https://lite-api.jup.ag/price/v2',
  'https://api.jup.ag/price/v2',
];

interface JupPriceResponse {
  data?: Record<string, { id: string; price: number | string; type?: string } | null>;
  /** v3 sometimes returns the map directly without the data wrapper */
  [k: string]: unknown;
}

/**
 * Fetch latest USD price for one or many mints from Jupiter price API v6.
 * Returns a map; missing mints are simply absent.
 *
 * Cached locally for 10 seconds to avoid hammering the public endpoint.
 */
const cache = new Map<string, { price: number; ts: number }>();
const TTL_MS = 10_000;

export async function getJupPrices(mints: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  const fresh: Record<string, number> = {};
  const stale: string[] = [];
  for (const m of mints) {
    const c = cache.get(m);
    if (c && now - c.ts < TTL_MS) fresh[m] = c.price;
    else stale.push(m);
  }
  if (stale.length === 0) return fresh;

  // Try each Jupiter endpoint in order until one returns useful data
  for (const base of JUP_PRICE_ENDPOINTS) {
    try {
      const url = `${base}?ids=${stale.join(',')}`;
      const res = await request(url, { method: 'GET' });
      if (res.statusCode !== 200) {
        log.debug({ status: res.statusCode, base }, 'jup price endpoint non-200, trying next');
        continue;
      }
      const json = (await res.body.json()) as JupPriceResponse;
      // v2: { data: { mint: { price } } }; v3: { mint: { usdPrice } } in some variants
      const dataMap =
        (json.data && typeof json.data === 'object'
          ? json.data
          : (json as Record<string, { price?: number | string; usdPrice?: number | string } | null>));
      let added = 0;
      for (const [k, v] of Object.entries(dataMap ?? {})) {
        if (!v || typeof v !== 'object') continue;
        const obj = v as { price?: number | string; usdPrice?: number | string };
        const raw = obj.price ?? obj.usdPrice;
        const priceNum = typeof raw === 'string' ? Number(raw) : raw;
        if (priceNum === undefined || !Number.isFinite(priceNum) || priceNum <= 0) continue;
        cache.set(k, { price: priceNum, ts: now });
        fresh[k] = priceNum;
        added++;
      }
      if (added > 0) return fresh;
    } catch (err) {
      log.debug({ err: String(err), base }, 'jup price endpoint failed, trying next');
    }
  }

  // All Jupiter endpoints failed — fall back to DexScreener for the well-known
  // quote mints (SOL/USDC/USDT). USDC and USDT are 1:1 by definition.
  log.warn('all jupiter endpoints failed; falling back to DexScreener for quote prices');
  for (const m of stale) {
    if (m === QUOTE_MINTS.USDC || m === QUOTE_MINTS.USDT) {
      cache.set(m, { price: 1, ts: now });
      fresh[m] = 1;
    } else {
      const px = await getDexScreenerPrice(m);
      if (px > 0) {
        cache.set(m, { price: px, ts: now });
        fresh[m] = px;
      }
    }
  }
  return fresh;
}

/**
 * Fallback: pull priceUsd for a mint from DexScreener (no auth, very reliable).
 * Picks the deepest-liquidity Solana pair to minimize wick noise.
 */
async function getDexScreenerPrice(mint: string): Promise<number> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await request(url, { method: 'GET' });
    if (res.statusCode !== 200) return 0;
    const json = (await res.body.json()) as {
      pairs?: Array<{
        chainId: string;
        priceUsd?: string;
        liquidity?: { usd?: number };
      }>;
    };
    const pairs = (json.pairs ?? []).filter((p) => p.chainId === 'solana');
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const px = Number(pairs[0]?.priceUsd ?? 0);
    return Number.isFinite(px) ? px : 0;
  } catch (err) {
    log.warn({ err: String(err), mint }, 'dexscreener price fallback failed');
    return 0;
  }
}

/** Convenience: SOL price in USD. */
export async function getSolPrice(): Promise<number> {
  const p = await getJupPrices([QUOTE_MINTS.SOL]);
  return p[QUOTE_MINTS.SOL] ?? 0;
}

/**
 * Quote endpoint — returns the expected output amount for a hypothetical swap.
 * Used by the paper executor to simulate realistic slippage.
 *
 * @param inputMint  mint we're paying with
 * @param outputMint mint we're receiving
 * @param amountRaw  raw input amount (smallest units)
 * @param slippageBps acceptable slippage (we ask for the worst-case route fitting this cap)
 */
export interface JupQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  slippageBps: number;
  swapMode: 'ExactIn' | 'ExactOut';
}

export async function getJupQuote(opts: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
  swapMode?: 'ExactIn' | 'ExactOut';
}): Promise<JupQuote | null> {
  const swapMode = opts.swapMode ?? 'ExactIn';
  const url =
    `https://quote-api.jup.ag/v6/quote?inputMint=${opts.inputMint}&outputMint=${opts.outputMint}` +
    `&amount=${opts.amountRaw.toString()}&slippageBps=${opts.slippageBps}&swapMode=${swapMode}`;
  try {
    const res = await request(url, { method: 'GET' });
    if (res.statusCode !== 200) {
      log.debug({ status: res.statusCode, url }, 'jup quote non-200');
      return null;
    }
    return (await res.body.json()) as JupQuote;
  } catch (err) {
    log.warn({ err }, 'jup quote fetch failed');
    return null;
  }
}
