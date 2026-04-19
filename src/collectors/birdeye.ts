import { request } from 'undici';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';

const log = child('birdeye');

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

/**
 * Birdeye top trader entry as returned by /defi/v2/tokens/top_traders.
 * Only the fields we care about are typed.
 */
export interface BirdeyeTopTrader {
  /** wallet address (base58) */
  owner: string;
  /** count of trades in the requested window */
  trade: number;
  /** USD volume in the requested window */
  volume: number;
  /** USD volume of buys in the window */
  volumeBuy?: number;
  /** USD volume of sells in the window */
  volumeSell?: number;
}

interface BirdeyeListEntry {
  address: string;
  symbol: string;
  v24hUSD?: number;
  liquidity?: number;
}

const HEADERS = (): Record<string, string> => ({
  accept: 'application/json',
  'x-chain': 'solana',
  ...(config.birdeyeApiKey ? { 'X-API-KEY': config.birdeyeApiKey } : {}),
});

/**
 * Sleep helper to keep us under Birdeye Starter plan's 30 req/min ceiling.
 * 2.5s between requests = max 24 req/min, leaves us a safety margin.
 */
const POLITE_DELAY_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch top tokens by 24h USD volume on Solana.
 * Used as the universe over which we aggregate top traders.
 *
 * Docs: https://docs.birdeye.so/reference/get-defi-tokenlist
 */
export async function getTopSolanaTokens(limit = 30): Promise<BirdeyeListEntry[]> {
  const url =
    `${BIRDEYE_BASE}/defi/tokenlist` +
    `?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${Math.min(limit, 50)}&min_liquidity=50000`;
  try {
    const res = await request(url, { method: 'GET', headers: HEADERS() });
    if (res.statusCode !== 200) {
      log.warn({ status: res.statusCode }, 'birdeye tokenlist non-200');
      return [];
    }
    const json = (await res.body.json()) as {
      data?: { tokens?: BirdeyeListEntry[] };
    };
    return (json.data?.tokens ?? []).filter((t) => !!t.address);
  } catch (err) {
    log.warn({ err: String(err) }, 'birdeye tokenlist failed');
    return [];
  }
}

/**
 * Fetch top traders for a given token by USD volume in the last 24h.
 *
 * Docs: https://docs.birdeye.so/reference/get-defi-v2-tokens-top_traders
 *
 * Returns up to `limit` entries; we typically use 10–15 per token.
 */
export async function getTopTraders(
  tokenMint: string,
  limit = 10,
): Promise<BirdeyeTopTrader[]> {
  const url =
    `${BIRDEYE_BASE}/defi/v2/tokens/top_traders` +
    `?address=${tokenMint}&time_frame=24h` +
    `&sort_type=desc&sort_by=volume&offset=0&limit=${Math.min(limit, 10)}`;
  try {
    const res = await request(url, { method: 'GET', headers: HEADERS() });
    if (res.statusCode !== 200) {
      log.warn({ token: tokenMint, status: res.statusCode }, 'birdeye top_traders non-200');
      return [];
    }
    const json = (await res.body.json()) as {
      data?: { items?: BirdeyeTopTrader[] };
    };
    return json.data?.items ?? [];
  } catch (err) {
    log.warn({ err: String(err), token: tokenMint }, 'birdeye top_traders failed');
    return [];
  }
}

/**
 * Aggregate top traders across many tokens.
 *
 * Returns each wallet with:
 *   - tokensCount: how many tokens it appeared as a top trader of (signal of breadth)
 *   - totalVolume: summed USD volume across those tokens
 *   - totalTrades: summed trade count
 *
 * The aggregator iterates tokens with a polite delay so we stay within the
 * Birdeye Starter plan's 30 req/min limit.
 */
export interface AggregatedTrader {
  wallet: string;
  tokensCount: number;
  totalVolumeUsd: number;
  totalTrades: number;
  /** sample of token mints where this wallet was a top trader */
  sampleTokens: string[];
}

export async function aggregateTopTraders(
  tokens: string[],
  perTokenLimit = 10,
): Promise<AggregatedTrader[]> {
  const acc = new Map<string, AggregatedTrader>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const traders = await getTopTraders(t, perTokenLimit);
    for (const tr of traders) {
      const cur = acc.get(tr.owner) ?? {
        wallet: tr.owner,
        tokensCount: 0,
        totalVolumeUsd: 0,
        totalTrades: 0,
        sampleTokens: [],
      };
      cur.tokensCount++;
      cur.totalVolumeUsd += tr.volume ?? 0;
      cur.totalTrades += tr.trade ?? 0;
      if (cur.sampleTokens.length < 5) cur.sampleTokens.push(t);
      acc.set(tr.owner, cur);
    }
    log.debug({ done: i + 1, of: tokens.length, found: acc.size }, 'aggregating');
    if (i < tokens.length - 1) await sleep(POLITE_DELAY_MS);
  }
  return Array.from(acc.values());
}

/**
 * Filter aggregated traders down to plausible "smart money" candidates and
 * remove obvious junk:
 *   - keep only wallets in ≥ minTokens distinct tokens (breadth filter)
 *   - drop wallets with absurd volume (> $10M in 24h — these are CEX hot wallets / MEV)
 *   - drop wallets with absurd trade counts (> 200/day — almost certainly arb bots)
 *   - drop wallets with too few trades (< 3 — probably one-shot luck)
 */
export function filterSmartMoneyCandidates(
  traders: AggregatedTrader[],
  opts: {
    minTokens?: number;
    maxVolumeUsd?: number;
    maxTradesPerDay?: number;
    minTrades?: number;
    limit?: number;
  } = {},
): AggregatedTrader[] {
  const minTokens = opts.minTokens ?? 2;
  const maxVolumeUsd = opts.maxVolumeUsd ?? 10_000_000;
  const maxTradesPerDay = opts.maxTradesPerDay ?? 200;
  const minTrades = opts.minTrades ?? 3;
  const limit = opts.limit ?? 200;

  const filtered = traders
    .filter((t) => t.tokensCount >= minTokens)
    .filter((t) => t.totalVolumeUsd <= maxVolumeUsd)
    .filter((t) => t.totalTrades <= maxTradesPerDay)
    .filter((t) => t.totalTrades >= minTrades)
    // basic sanity check on wallet format (base58, 32-44 chars)
    .filter((t) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.wallet));

  // Rank by breadth × √volume — favours wallets that hit many tokens with
  // meaningful (but not insane) volume; sqrt dampens whale-bias.
  filtered.sort(
    (a, b) =>
      b.tokensCount * Math.sqrt(b.totalVolumeUsd + 1) -
      a.tokensCount * Math.sqrt(a.totalVolumeUsd + 1),
  );

  return filtered.slice(0, limit);
}
