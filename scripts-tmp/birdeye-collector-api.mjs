/**
 * Birdeye Data API helpers for DEX snapshot collectors (primary source on LERA).
 * DexScreener remains fallback in collector-primary-fetch.mjs / paper2 enrich.
 */
import { acquireBirdeyeSlot } from './birdeye-api-gate.mjs';

export const BIRDEYE_API_BASE = 'https://public-api.birdeye.so';

/** Birdeye `markets` filter per lane (see docs: sourceFilterSearchParam). */
export const BIRDEYE_DEX_MARKETS = {
  raydium: 'Raydium,Raydium CP,Raydium Clamm',
  meteora: 'Meteora,Meteora DLMM',
  pumpswap: 'Pump.fun',
  moonshot: 'Pump.fun',
  orca: 'Orca',
};

export function birdeyeEnabled() {
  if (process.env.BIRDEYE_COLLECTOR_ENABLED === '0') return false;
  return Boolean(process.env.BIRDEYE_API_KEY?.trim());
}

export function birdeyeApiKey() {
  return process.env.BIRDEYE_API_KEY?.trim() ?? '';
}

export function birdeyeJsonHeaders(extra = {}) {
  const key = birdeyeApiKey();
  return {
    accept: 'application/json',
    ...(key ? { 'X-API-KEY': key } : {}),
    'x-chain': 'solana',
    ...extra,
  };
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** True when Birdeye market `source` matches our lane (`raydium`, `meteora`, `pumpswap`, ...). */
export function birdeyeMarketMatchesDexSource(marketSource, dexSource) {
  const src = String(marketSource ?? '').toLowerCase();
  const lane = String(dexSource ?? '').toLowerCase();
  if (!src || !lane) return false;
  if (lane === 'pumpswap' || lane === 'moonshot') {
    return src.includes('pump');
  }
  if (lane === 'raydium') return src.includes('raydium');
  if (lane === 'meteora') return src.includes('meteora');
  if (lane === 'orca') return src.includes('orca');
  return src.includes(lane);
}

export function normalizeBirdeyeMarketRow(market, bucketTs, dexSource, tokenOverlay = null) {
  const pairAddress = market?.address;
  const baseMint = market?.base_mint;
  const quoteMint = market?.quote_mint;
  if (!pairAddress || !baseMint || !quoteMint) return null;
  if (!birdeyeMarketMatchesDexSource(market?.source, dexSource)) return null;

  const t = tokenOverlay ?? {};
  return {
    ts: bucketTs,
    source: dexSource,
    pair_address: pairAddress,
    base_mint: baseMint,
    quote_mint: quoteMint,
    price_usd: toNum(t.price ?? market?.price),
    liquidity_usd: toNum(market?.liquidity ?? t.liquidity),
    volume_5m: toNum(t.volume_5m_usd),
    volume_1h: toNum(t.volume_1h_usd ?? (market?.volume_24h_usd != null ? market.volume_24h_usd / 24 : null)),
    buys_5m: toInt(t.buy_5m),
    sells_5m: toInt(t.sell_5m),
    fdv_usd: toNum(t.fdv),
    market_cap_usd: toNum(t.market_cap),
    base_symbol: t.symbol ?? null,
    base_name: t.name ?? null,
    launch_ts: t.creation_time ? new Date(t.creation_time) : null,
  };
}

function birdeyeUrl(path, params = {}) {
  const u = new URL(`${BIRDEYE_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export async function birdeyeFetchJson(url, fetchJsonWithRetry, retryTag = 'birdeye') {
  if (!birdeyeEnabled()) throw new Error('birdeye disabled or missing BIRDEYE_API_KEY');
  await acquireBirdeyeSlot();
  const json = await fetchJsonWithRetry(
    url,
    { headers: birdeyeJsonHeaders() },
    retryTag,
  );
  if (json?.success === false) {
    throw new Error(`${retryTag} success=false message=${String(json?.message ?? '')}`);
  }
  return json;
}

function extractSearchMarkets(json) {
  const items = json?.data?.items;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const block of items) {
    if (block?.type !== 'market' || !Array.isArray(block?.result)) continue;
    for (const m of block.result) out.push(m);
  }
  return out;
}

export async function birdeyeSearchMarkets({
  keyword,
  markets,
  limit = 20,
  fetchJsonWithRetry,
  retryTag = 'birdeye-search',
}) {
  const url = birdeyeUrl('/defi/v3/search', {
    chain: 'solana',
    keyword,
    target: 'market',
    search_mode: 'fuzzy',
    markets,
    limit,
  });
  const json = await birdeyeFetchJson(url, fetchJsonWithRetry, retryTag);
  return extractSearchMarkets(json);
}

export async function birdeyeSearchMarketsByMint({
  mint,
  markets,
  fetchJsonWithRetry,
  retryTag = 'birdeye-search-mint',
}) {
  const url = birdeyeUrl('/defi/v3/search', {
    chain: 'solana',
    keyword: mint,
    search_by: 'address',
    target: 'market',
    search_mode: 'exact',
    markets,
    limit: 10,
  });
  const json = await birdeyeFetchJson(url, fetchJsonWithRetry, retryTag);
  return extractSearchMarkets(json);
}

export async function birdeyeTokenListPage({
  offset = 0,
  limit = 50,
  minLiquidityUsd,
  minVolume5mUsd,
  fetchJsonWithRetry,
  retryTag = 'birdeye-token-list',
}) {
  const url = birdeyeUrl('/defi/v3/token/list', {
    sort_by: 'volume_5m_usd',
    sort_type: 'desc',
    offset,
    limit,
    min_liquidity: minLiquidityUsd,
    min_volume_5m_usd: minVolume5mUsd,
  });
  const json = await birdeyeFetchJson(url, fetchJsonWithRetry, retryTag);
  const items = json?.data?.items;
  return Array.isArray(items) ? items : [];
}

/** DexScreener-shaped pair for paper2 enrich `normalizeDexPair` hooks. */
export function birdeyeMarketToDexPairShape(market, tradeData = null) {
  const td = tradeData ?? {};
  return {
    chainId: 'solana',
    dexId: String(market?.source ?? '').toLowerCase().replace(/\s+/g, '_'),
    pairAddress: market?.address,
    baseToken: { address: market?.base_mint, symbol: td.symbol, name: td.name },
    quoteToken: { address: market?.quote_mint },
    priceUsd: td.price ?? market?.price,
    liquidity: { usd: market?.liquidity },
    volume: {
      m5: td.volume_5m_usd,
      h1: td.volume_1h_usd,
    },
    txns: {
      m5: {
        buys: td.buy_5m,
        sells: td.sell_5m,
      },
    },
    fdv: td.fdv,
    marketCap: td.market_cap,
    pairCreatedAt: td.creation_time ? Date.parse(td.creation_time) : null,
  };
}

export function pickBestBirdeyeMarket(markets, dexSource) {
  let best = null;
  let bestLiq = -1;
  for (const m of markets) {
    if (!birdeyeMarketMatchesDexSource(m?.source, dexSource)) continue;
    const liq = toNum(m?.liquidity) ?? -1;
    if (liq > bestLiq) {
      bestLiq = liq;
      best = m;
    }
  }
  return best;
}

export async function birdeyeTradeDataSingle({ mint, fetchJsonWithRetry, retryTag = 'birdeye-trade-data' }) {
  const url = birdeyeUrl('/defi/v3/token/trade-data/single', {
    address: mint,
    frames: '5m,1h',
  });
  const json = await birdeyeFetchJson(url, fetchJsonWithRetry, retryTag);
  return json?.data ?? null;
}

/**
 * Primary universe fetch: Birdeye token list + market search.
 * Returns snapshot rows for one DEX lane.
 */
export async function fetchBirdeyePrimaryRows({
  bucketTs,
  dexSource,
  markets,
  searchTerms,
  fetchJsonWithRetry,
  sleep,
  tokenListPages = 1,
  tokenListLimit = 50,
  minLiquidityUsd = 20_000,
  minVolume5mUsd = 2_000,
  resolvePairsMax = 20,
}) {
  const allRows = [];
  const seenPairs = new Set();

  for (let page = 0; page < tokenListPages; page += 1) {
    const tokens = await birdeyeTokenListPage({
      offset: page * tokenListLimit,
      limit: tokenListLimit,
      minLiquidityUsd,
      minVolume5mUsd,
      fetchJsonWithRetry,
      retryTag: `birdeye-token-list-p${page + 1}`,
    });
    const toResolve = tokens.slice(0, resolvePairsMax);
    for (const token of toResolve) {
      const mint = token?.address;
      if (!mint) continue;
      const mkts = await birdeyeSearchMarketsByMint({
        mint,
        markets,
        fetchJsonWithRetry,
        retryTag: 'birdeye-resolve-pair',
      });
      const best = pickBestBirdeyeMarket(mkts, dexSource);
      if (!best) continue;
      const row = normalizeBirdeyeMarketRow(best, bucketTs, dexSource, token);
      if (!row || seenPairs.has(row.pair_address)) continue;
      seenPairs.add(row.pair_address);
      allRows.push(row);
      if (sleep) await sleep(80);
    }
    if (sleep) await sleep(120);
  }

  for (const term of searchTerms) {
    const mkts = await birdeyeSearchMarkets({
      keyword: term,
      markets,
      fetchJsonWithRetry,
      retryTag: 'birdeye-search-term',
    });
    for (const m of mkts) {
      const row = normalizeBirdeyeMarketRow(m, bucketTs, dexSource);
      if (!row || seenPairs.has(row.pair_address)) continue;
      seenPairs.add(row.pair_address);
      allRows.push(row);
    }
    if (sleep) await sleep(120);
  }

  return allRows;
}

/** Enrich open/pin mints via Birdeye search (+ optional trade-data for 5m vol). */
export async function fetchBirdeyePairsForMint({
  mint,
  markets,
  dexSource,
  bucketTs,
  fetchJsonWithRetry,
  withTradeData = true,
}) {
  const mkts = await birdeyeSearchMarketsByMint({
    mint,
    markets,
    fetchJsonWithRetry,
    retryTag: 'birdeye-enrich-mint',
  });
  const best = pickBestBirdeyeMarket(mkts, dexSource);
  if (!best) return [];

  let trade = null;
  if (withTradeData) {
    try {
      trade = await birdeyeTradeDataSingle({ mint, fetchJsonWithRetry, retryTag: 'birdeye-enrich-trade' });
    } catch {
      trade = null;
    }
  }

  const overlay = trade
    ? {
        price: trade.price,
        volume_5m_usd: trade.volume_5m_usd,
        volume_1h_usd: trade.volume_1h_usd,
        buy_5m: trade.buy_5m,
        sell_5m: trade.sell_5m,
        fdv: trade.fdv,
        market_cap: trade.market_cap,
      }
    : {};

  const row = normalizeBirdeyeMarketRow(best, bucketTs, dexSource, overlay);
  return row ? [row] : [];
}
