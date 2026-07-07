/**
 * Shared primary snapshot fetch: Birdeye → DexScreener → GeckoTerminal.
 */
import {
  BIRDEYE_DEX_MARKETS,
  birdeyeEnabled,
  fetchBirdeyePrimaryRows,
} from './birdeye-collector-api.mjs';

/**
 * @param {object} opts
 * @param {string} opts.dexSource — lane id (`raydium`, `meteora`, …)
 * @param {Date} opts.bucketTs
 * @param {string[]} opts.searchTerms — DexScreener / Birdeye fuzzy terms
 * @param {function} opts.fetchFromDexScreener
 * @param {function} opts.fetchFromGeckoTrending
 * @param {function} [opts.fetchFromGeckoNewPools]
 * @param {function} opts.fetchJsonWithRetry
 * @param {function} opts.sleep
 * @param {number} [opts.tokenListPages]
 * @param {number} [opts.minLiquidityUsd]
 * @param {number} [opts.minVolume5mUsd]
 */
export async function fetchPrimarySnapshotRows(opts) {
  const {
    dexSource,
    bucketTs,
    searchTerms,
    fetchFromDexScreener,
    fetchFromGeckoTrending,
    fetchFromGeckoNewPools,
    fetchJsonWithRetry,
    sleep,
    tokenListPages = Number(process.env.BIRDEYE_TOKEN_LIST_PAGES || 1),
    minLiquidityUsd = Number(process.env.BIRDEYE_MIN_LIQ_USD || 20_000),
    minVolume5mUsd = Number(process.env.BIRDEYE_MIN_VOL5M_USD || 2_000),
  } = opts;

  let primaryRows = [];
  let sourceUsed = 'dexscreener';
  let dexRateLimited = false;

  if (birdeyeEnabled()) {
    try {
      const markets = BIRDEYE_DEX_MARKETS[dexSource] ?? '';
      primaryRows = await fetchBirdeyePrimaryRows({
        bucketTs,
        dexSource,
        markets,
        searchTerms,
        fetchJsonWithRetry,
        sleep,
        tokenListPages,
        minLiquidityUsd,
        minVolume5mUsd,
      });
      if (primaryRows.length > 0) {
        sourceUsed = 'birdeye';
        return { primaryRows, sourceUsed, dexRateLimited };
      }
      sourceUsed = 'birdeye-empty';
    } catch (error) {
      sourceUsed = 'birdeye-failed';
      if (opts.log) {
        opts.log('warn', 'birdeye primary failed; dexscreener fallback', { error: String(error), dexSource });
      }
    }
  }

  try {
    primaryRows = await fetchFromDexScreener(bucketTs);
  } catch (error) {
    if (String(error).includes('status=429')) {
      dexRateLimited = true;
      primaryRows = [];
      if (opts.log) {
        opts.log('warn', 'dexscreener rate limited; gecko fallback', { error: String(error), dexSource });
      }
    } else {
      throw error;
    }
  }

  if (primaryRows.length === 0 || dexRateLimited) {
    sourceUsed = dexRateLimited ? 'geckoterminal-trending-429-fallback' : 'geckoterminal-trending';
    primaryRows = await fetchFromGeckoTrending(bucketTs);
  }

  if (primaryRows.length === 0 && fetchFromGeckoNewPools) {
    sourceUsed = 'geckoterminal-new-pools';
    primaryRows = await fetchFromGeckoNewPools(bucketTs);
  }

  if (sourceUsed === 'dexscreener' || sourceUsed === 'birdeye-empty' || sourceUsed === 'birdeye-failed') {
    if (primaryRows.length > 0 && !dexRateLimited) sourceUsed = 'dexscreener';
  }

  return { primaryRows, sourceUsed, dexRateLimited };
}
