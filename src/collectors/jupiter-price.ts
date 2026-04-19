import { request } from 'undici';
import { child } from '../core/logger.js';
import { QUOTE_MINTS } from '../core/constants.js';

const log = child('jupiter-price');

const JUP_PRICE_URL = 'https://price.jup.ag/v6/price';

interface JupPriceResponse {
  data: Record<string, { id: string; price: number }>;
  timeTaken?: number;
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
  try {
    const url = `${JUP_PRICE_URL}?ids=${stale.join(',')}`;
    const res = await request(url, { method: 'GET' });
    if (res.statusCode !== 200) {
      log.warn({ status: res.statusCode }, 'jup price non-200');
      return fresh;
    }
    const json = (await res.body.json()) as JupPriceResponse;
    for (const [k, v] of Object.entries(json.data ?? {})) {
      cache.set(k, { price: v.price, ts: now });
      fresh[k] = v.price;
    }
  } catch (err) {
    log.warn({ err }, 'jup price fetch failed');
  }
  return fresh;
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
