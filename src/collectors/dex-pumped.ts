import { request } from 'undici';
import { child } from '../core/logger.js';
import { isQuoteMint } from '../core/constants.js';

const log = child('dex-pumped');

/**
 * A token that has demonstrably moved in price within a recent window.
 * The "pump retro" alpha discovery method works by finding wallets that
 * bought BEFORE the move — that's actual leading-edge alpha, not lagging
 * volume-based noise.
 */
export interface PumpedToken {
  mint: string;
  symbol?: string;
  priceUsd?: number;
  /** % change in past 24h (e.g. 250 = 3.5x) */
  priceChangeH24: number;
  /** % change in past 6h */
  priceChangeH6?: number;
  /** % change in past 1h */
  priceChangeH1?: number;
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd?: number;
  ageHours?: number;
  /** unix ms when the pair was created (used to compute pump-start window) */
  pairCreatedAt?: number;
}

/**
 * Mints we never want to score for "pump alpha" — wrapped majors, stables,
 * LSTs and deprecated/bridged tokens. Their price movements are arb-driven,
 * not info-edge driven.
 */
const PUMP_BLACKLIST = new Set<string>([
  'So11111111111111111111111111111111111111112',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
]);

const PUMP_SYMBOL_RE =
  /^(.*USD[A-Z0-9]*|.*USDT|.*USDC|PYUSD|FDUSD|USDe|DAI|TUSD|FRAX|w?SOL|j[a-z]+SOL|bSOL|mSOL|stSOL|.*[bw]?BTC|.*[bw]?ETH|HYPE|SUI|DOGE|XRP|ADA|LINK|UNI|ARB|OP|MATIC|AVAX|DOT|TRX|TON|LTC|XMR|XLM|JUP|RAY|ORCA|JTO)$/i;

function isBlacklisted(mint: string, symbol?: string): boolean {
  if (PUMP_BLACKLIST.has(mint)) return true;
  if (symbol && PUMP_SYMBOL_RE.test(symbol)) return true;
  return false;
}

interface DexPair {
  chainId: string;
  baseToken: { address: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  volume?: { h24?: number; h6?: number };
  fdv?: number;
  pairCreatedAt?: number;
}

/**
 * Pull a wide trending pool from DexScreener via the search endpoint with
 * many seed queries. Each query returns up to ~30-100 pairs. We dedupe and
 * keep the deepest-liquidity pool per mint downstream.
 *
 * No auth, generous rate limits. The diversity of queries matters more than
 * any single one — DexScreener's relevance algorithm pulls different sets
 * for different terms even when the underlying activity overlaps.
 */
async function fetchTrendingPairs(): Promise<DexPair[]> {
  const queries = [
    'solana',
    'raydium',
    'pump',
    'pumpfun',
    'meteora',
    'memecoin',
    'meme',
    'sol',
    'bonk',
    'jup',
    'orca',
    'launch',
  ];
  const collected: DexPair[] = [];
  for (const q of queries) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
      const res = await request(url, { method: 'GET' });
      if (res.statusCode !== 200) {
        log.warn({ q, status: res.statusCode }, 'dex search non-200');
        continue;
      }
      const json = (await res.body.json()) as { pairs?: DexPair[] };
      for (const p of json.pairs ?? []) {
        if (p.chainId === 'solana') collected.push(p);
      }
    } catch (err) {
      log.warn({ q, err: String(err) }, 'dex search failed');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return collected;
}

/**
 * Token-boosts surface paid-promoted tokens — usually because a team is hyping
 * a real run. Boosted + pumping = high signal that the move is real, not wash.
 */
async function fetchBoostedMints(): Promise<string[]> {
  try {
    const res = await request('https://api.dexscreener.com/token-boosts/latest/v1', {
      method: 'GET',
    });
    if (res.statusCode !== 200) return [];
    const json = (await res.body.json()) as Array<{ chainId: string; tokenAddress: string }>;
    return json.filter((b) => b.chainId === 'solana').map((b) => b.tokenAddress);
  } catch (err) {
    log.warn({ err: String(err) }, 'dex boosts failed');
    return [];
  }
}

/**
 * Top-boosted-tokens — orthogonal endpoint surfacing tokens with the most
 * accumulated boost spend (vs latest-boosts which is recency-sorted).
 * Usually different set than latest, broadens our pool.
 */
async function fetchTopBoostedMints(): Promise<string[]> {
  try {
    const res = await request('https://api.dexscreener.com/token-boosts/top/v1', {
      method: 'GET',
    });
    if (res.statusCode !== 200) return [];
    const json = (await res.body.json()) as Array<{ chainId: string; tokenAddress: string }>;
    return json.filter((b) => b.chainId === 'solana').map((b) => b.tokenAddress);
  } catch (err) {
    log.warn({ err: String(err) }, 'dex top-boosts failed');
    return [];
  }
}

/**
 * Token-profiles latest — newly-listed tokens with profile pages.
 * Heavy overlap with launch-stage memecoins; broadens our pool.
 */
async function fetchProfileMints(): Promise<string[]> {
  try {
    const res = await request('https://api.dexscreener.com/token-profiles/latest/v1', {
      method: 'GET',
    });
    if (res.statusCode !== 200) return [];
    const json = (await res.body.json()) as Array<{ chainId: string; tokenAddress: string }>;
    return json.filter((b) => b.chainId === 'solana').map((b) => b.tokenAddress);
  } catch (err) {
    log.warn({ err: String(err) }, 'dex profiles failed');
    return [];
  }
}

/**
 * Enrich a flat list of mints into full DexPair info via /tokens/{mints}.
 * Required to get priceChange data for boosted/profile mints.
 */
async function enrichMints(mints: string[]): Promise<DexPair[]> {
  const out: DexPair[] = [];
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`;
      const res = await request(url, { method: 'GET' });
      if (res.statusCode !== 200) continue;
      const json = (await res.body.json()) as { pairs?: DexPair[] };
      for (const p of json.pairs ?? []) {
        if (p.chainId === 'solana') out.push(p);
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'enrich failed');
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

/**
 * Find tokens that have demonstrably moved in price recently — the input pool
 * for retroactive alpha discovery.
 *
 * Strategy: pull a wide trending + boosted pool, then filter by:
 *   - priceChange.h24 in [minPriceChangePct, maxPriceChangePct]
 *     (lower bound = "actually pumped"; upper bound = "skip 1000x rugs whose
 *     early buyers are insider/team wallets we can't replicate")
 *   - liquidity >= minLiquidityUsd (real liquidity, not wash)
 *   - volume24h >= minVolume24hUsd (active enough to scrape buyers)
 *   - age >= minAgeHours (drops fresh launchpad noise where everyone is a sniper)
 *
 * For each mint we keep the deepest-liquidity pair. Result is sorted by
 * (pump magnitude × sqrt(liquidity)) — biggest real pumps first.
 */
export async function findPumpedTokens(opts: {
  minPriceChangePct?: number;
  maxPriceChangePct?: number;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  minAgeHours?: number;
  maxAgeHours?: number;
  limit?: number;
} = {}): Promise<PumpedToken[]> {
  const o = {
    minPriceChangePct: opts.minPriceChangePct ?? 50, // 1.5x — wider net for thin markets
    maxPriceChangePct: opts.maxPriceChangePct ?? 5000, // 51x — keep some room for genuine moonshots
    minLiquidityUsd: opts.minLiquidityUsd ?? 10_000,
    minVolume24hUsd: opts.minVolume24hUsd ?? 30_000,
    minAgeHours: opts.minAgeHours ?? 4, // 4h skips most pure-snipe windows but keeps fresh runners
    maxAgeHours: opts.maxAgeHours ?? 24 * 30,
    limit: opts.limit ?? 50,
  };
  log.info({ filters: o }, 'searching pumped tokens');

  const [trending, boostedLatest, boostedTop, profiles] = await Promise.all([
    fetchTrendingPairs(),
    fetchBoostedMints(),
    fetchTopBoostedMints(),
    fetchProfileMints(),
  ]);
  log.info(
    {
      trendingPairs: trending.length,
      boostedLatest: boostedLatest.length,
      boostedTop: boostedTop.length,
      profiles: profiles.length,
    },
    'pools fetched',
  );

  const enriched: DexPair[] = [...trending];
  const mintsToEnrich = Array.from(new Set([...boostedLatest, ...boostedTop, ...profiles]));
  if (mintsToEnrich.length) {
    const enrich = await enrichMints(mintsToEnrich);
    enriched.push(...enrich);
  }

  // Keep deepest-liquidity pair per mint
  const byMint = new Map<string, DexPair>();
  for (const p of enriched) {
    const mint = p.baseToken.address;
    if (isBlacklisted(mint, p.baseToken.symbol)) continue;
    if (isQuoteMint(mint)) continue;
    const cur = byMint.get(mint);
    if (!cur || (cur.liquidity?.usd ?? 0) < (p.liquidity?.usd ?? 0)) {
      byMint.set(mint, p);
    }
  }

  const now = Date.now();
  const candidates: PumpedToken[] = [];
  let droppedNoChange = 0;
  let droppedSmallChange = 0;
  let droppedHugeChange = 0;
  let droppedLiq = 0;
  let droppedVol = 0;
  let droppedAge = 0;

  for (const p of byMint.values()) {
    const ch24 = p.priceChange?.h24 ?? null;
    const ch6 = p.priceChange?.h6 ?? null;
    if (ch24 === null && ch6 === null) {
      droppedNoChange++;
      continue;
    }
    // Treat token as pumped if EITHER 24h OR 6h timeframe crossed threshold.
    // Catches both "fully developed" pumps (h24 high) and "in-flight" moves
    // (h6 high but h24 still low) — both have early buyers we want.
    const peakChange = Math.max(ch24 ?? -Infinity, ch6 ?? -Infinity);
    if (peakChange < o.minPriceChangePct) {
      droppedSmallChange++;
      continue;
    }
    if (peakChange > o.maxPriceChangePct) {
      droppedHugeChange++;
      continue;
    }
    const liq = p.liquidity?.usd ?? 0;
    if (liq < o.minLiquidityUsd) {
      droppedLiq++;
      continue;
    }
    const vol = p.volume?.h24 ?? 0;
    if (vol < o.minVolume24hUsd) {
      droppedVol++;
      continue;
    }
    const ageHours = p.pairCreatedAt ? (now - p.pairCreatedAt) / 3_600_000 : undefined;
    if (ageHours !== undefined && (ageHours < o.minAgeHours || ageHours > o.maxAgeHours)) {
      droppedAge++;
      continue;
    }
    candidates.push({
      mint: p.baseToken.address,
      symbol: p.baseToken.symbol,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
      priceChangeH24: ch24 ?? 0,
      priceChangeH6: ch6 ?? undefined,
      priceChangeH1: p.priceChange?.h1,
      liquidityUsd: liq,
      volume24hUsd: vol,
      fdvUsd: p.fdv,
      ageHours,
      pairCreatedAt: p.pairCreatedAt,
    });
  }

  candidates.sort((a, b) => {
    const peakA = Math.max(a.priceChangeH24, a.priceChangeH6 ?? 0);
    const peakB = Math.max(b.priceChangeH24, b.priceChangeH6 ?? 0);
    const sa = peakA * Math.sqrt(Math.max(1, a.liquidityUsd));
    const sb = peakB * Math.sqrt(Math.max(1, b.liquidityUsd));
    return sb - sa;
  });

  const final = candidates.slice(0, o.limit);
  log.info(
    {
      pool: byMint.size,
      kept: final.length,
      droppedNoChange,
      droppedSmallChange,
      droppedHugeChange,
      droppedLiq,
      droppedVol,
      droppedAge,
      preview: final
        .slice(0, 8)
        .map((t) => {
          const peak = Math.max(t.priceChangeH24, t.priceChangeH6 ?? 0);
          return `${t.symbol ?? t.mint.slice(0, 4)}(+${Math.round(peak)}%)`;
        })
        .join(', '),
    },
    'pumped tokens selected',
  );
  return final;
}
