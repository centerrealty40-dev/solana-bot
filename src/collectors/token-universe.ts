import { request } from 'undici';
import { child } from '../core/logger.js';
import { isQuoteMint } from '../core/constants.js';
import { getTopSolanaTokens } from './birdeye.js';
import { getTopSolanaPairs } from './dexscreener.js';

const log = child('token-universe');

export interface UniverseToken {
  mint: string;
  symbol?: string;
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd: number;
  ageHours?: number;
  /** which sources surfaced this token (debug aid) */
  sources: Set<string>;
}

const BLUECHIP_BLACKLIST = new Set<string>([
  'So11111111111111111111111111111111111111112',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM',
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
]);

/**
 * Fetch DexScreener token-boosts (paid promotion → strong organic activity proxy).
 * Public endpoint, no auth.
 */
async function getDexScreenerBoosts(): Promise<string[]> {
  try {
    const res = await request('https://api.dexscreener.com/token-boosts/latest/v1', {
      method: 'GET',
    });
    if (res.statusCode !== 200) return [];
    const json = (await res.body.json()) as Array<{ chainId: string; tokenAddress: string }>;
    return json
      .filter((b) => b.chainId === 'solana')
      .map((b) => b.tokenAddress)
      .filter((addr) => !BLUECHIP_BLACKLIST.has(addr));
  } catch (err) {
    log.warn({ err: String(err) }, 'dexscreener boosts failed');
    return [];
  }
}

/**
 * Fetch DexScreener token-profiles latest (newly listed/active tokens).
 */
async function getDexScreenerNewProfiles(): Promise<string[]> {
  try {
    const res = await request('https://api.dexscreener.com/token-profiles/latest/v1', {
      method: 'GET',
    });
    if (res.statusCode !== 200) return [];
    const json = (await res.body.json()) as Array<{ chainId: string; tokenAddress: string }>;
    return json
      .filter((b) => b.chainId === 'solana')
      .map((b) => b.tokenAddress)
      .filter((addr) => !BLUECHIP_BLACKLIST.has(addr));
  } catch (err) {
    log.warn({ err: String(err) }, 'dexscreener profiles failed');
    return [];
  }
}

/**
 * Resolve metadata for a flat list of mints via DexScreener tokens endpoint
 * (batched up to 30 per call). Used to enrich boosts/profiles with
 * liquidity/volume/age/fdv so we can apply the same filters as Birdeye output.
 */
async function enrichDexScreener(mints: string[]): Promise<Map<string, Partial<UniverseToken>>> {
  const out = new Map<string, Partial<UniverseToken>>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`;
      const res = await request(url, { method: 'GET' });
      if (res.statusCode !== 200) continue;
      const json = (await res.body.json()) as {
        pairs?: Array<{
          chainId: string;
          baseToken: { address: string; symbol: string };
          liquidity?: { usd?: number };
          volume?: { h24?: number };
          fdv?: number;
          pairCreatedAt?: number;
        }>;
      };
      // pick deepest-liquidity pair per mint
      const byMint = new Map<string, NonNullable<typeof json.pairs>[number]>();
      for (const p of json.pairs ?? []) {
        if (p.chainId !== 'solana') continue;
        const cur = byMint.get(p.baseToken.address);
        if (!cur || (cur.liquidity?.usd ?? 0) < (p.liquidity?.usd ?? 0)) {
          byMint.set(p.baseToken.address, p);
        }
      }
      const now = Date.now();
      for (const [mint, p] of byMint) {
        out.set(mint, {
          symbol: p.baseToken.symbol,
          liquidityUsd: p.liquidity?.usd ?? 0,
          volume24hUsd: p.volume?.h24 ?? 0,
          fdvUsd: p.fdv ?? 0,
          ageHours: p.pairCreatedAt ? (now - p.pairCreatedAt) / 3_600_000 : undefined,
        });
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'enrich tokens failed');
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

/**
 * Build a deduplicated universe of tokens worth scanning for swappers.
 *
 * Sources:
 *  1. Birdeye top-tokens (filtered to memecoin FDV range)
 *  2. DexScreener "search?q=solana" trending
 *  3. DexScreener token-boosts (paid promotion → real activity)
 *  4. DexScreener token-profiles latest (fresh listings)
 *
 * All sources are unioned, then enriched with liquidity/fdv/age and
 * filtered against `opts`. The intersection of sources is preferred:
 * tokens surfaced by 2+ sources are ranked higher.
 */
export async function buildTokenUniverse(opts: {
  targetCount?: number;
  minFdvUsd?: number;
  maxFdvUsd?: number;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  maxAgeHours?: number;
  /** if true, allow tokens younger than `minAgeHours` (otherwise drop fresh rugs) */
  minAgeHours?: number;
} = {}): Promise<UniverseToken[]> {
  const o = {
    targetCount: opts.targetCount ?? 50,
    minFdvUsd: opts.minFdvUsd ?? 500_000,
    maxFdvUsd: opts.maxFdvUsd ?? 500_000_000,
    minLiquidityUsd: opts.minLiquidityUsd ?? 30_000,
    minVolume24hUsd: opts.minVolume24hUsd ?? 100_000,
    maxAgeHours: opts.maxAgeHours ?? 24 * 60, // 60 days
    minAgeHours: opts.minAgeHours ?? 2, // > 2h drops the freshest rug bait
  };

  log.info({ filters: o }, 'building token universe');

  const candidates = new Map<string, UniverseToken>();
  const note = (mint: string, source: string, partial: Partial<UniverseToken>) => {
    if (BLUECHIP_BLACKLIST.has(mint) || isQuoteMint(mint)) return;
    let t = candidates.get(mint);
    if (!t) {
      t = {
        mint,
        liquidityUsd: 0,
        volume24hUsd: 0,
        fdvUsd: 0,
        sources: new Set(),
      };
      candidates.set(mint, t);
    }
    t.sources.add(source);
    if (partial.symbol && !t.symbol) t.symbol = partial.symbol;
    if ((partial.liquidityUsd ?? 0) > t.liquidityUsd) t.liquidityUsd = partial.liquidityUsd!;
    if ((partial.volume24hUsd ?? 0) > t.volume24hUsd) t.volume24hUsd = partial.volume24hUsd!;
    if ((partial.fdvUsd ?? 0) > t.fdvUsd) t.fdvUsd = partial.fdvUsd!;
    if (partial.ageHours !== undefined) {
      t.ageHours = t.ageHours === undefined ? partial.ageHours : Math.min(t.ageHours, partial.ageHours);
    }
  };

  // Source 1: Birdeye
  try {
    const bd = await getTopSolanaTokens(o.targetCount, {
      minFdvUsd: o.minFdvUsd,
      maxFdvUsd: o.maxFdvUsd,
      minLiquidity: o.minLiquidityUsd,
    });
    for (const t of bd) {
      note(t.address, 'birdeye', {
        symbol: t.symbol,
        liquidityUsd: t.liquidity ?? 0,
        volume24hUsd: t.v24hUSD ?? 0,
        fdvUsd: t.mc ?? 0,
      });
    }
    log.info({ got: bd.length }, 'birdeye contributed');
  } catch (err) {
    log.warn({ err: String(err) }, 'birdeye source failed');
  }

  // Source 2: DexScreener search "solana"
  try {
    const ds = await getTopSolanaPairs('solana');
    for (const p of ds) {
      note(p.baseToken.address, 'dex_search', {
        symbol: p.baseToken.symbol,
        liquidityUsd: p.liquidity?.usd ?? 0,
        volume24hUsd: p.volume?.h24 ?? 0,
        fdvUsd: p.fdv ?? 0,
        ageHours: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3_600_000 : undefined,
      });
    }
    log.info({ got: ds.length }, 'dexscreener search contributed');
  } catch (err) {
    log.warn({ err: String(err) }, 'dexscreener search failed');
  }

  // Source 3 & 4: boosts + new profiles (need enrichment)
  const [boosts, profiles] = await Promise.all([getDexScreenerBoosts(), getDexScreenerNewProfiles()]);
  log.info({ boosts: boosts.length, profiles: profiles.length }, 'dexscreener boosts/profiles fetched');
  const toEnrich = Array.from(new Set([...boosts, ...profiles])).slice(0, 90);
  if (toEnrich.length) {
    const enrichment = await enrichDexScreener(toEnrich);
    for (const m of boosts) {
      const meta = enrichment.get(m);
      if (meta) note(m, 'dex_boost', meta);
    }
    for (const m of profiles) {
      const meta = enrichment.get(m);
      if (meta) note(m, 'dex_profile', meta);
    }
  }

  // Apply filters
  const filtered: UniverseToken[] = [];
  let droppedFdv = 0,
    droppedLiq = 0,
    droppedVol = 0,
    droppedAge = 0;
  for (const t of candidates.values()) {
    if (t.fdvUsd > 0 && (t.fdvUsd < o.minFdvUsd || t.fdvUsd > o.maxFdvUsd)) {
      droppedFdv++;
      continue;
    }
    if (t.liquidityUsd < o.minLiquidityUsd) {
      droppedLiq++;
      continue;
    }
    if (t.volume24hUsd < o.minVolume24hUsd) {
      droppedVol++;
      continue;
    }
    if (t.ageHours !== undefined && (t.ageHours < o.minAgeHours || t.ageHours > o.maxAgeHours)) {
      droppedAge++;
      continue;
    }
    filtered.push(t);
  }

  // Rank: source-overlap × sqrt(volume)
  filtered.sort((a, b) => {
    const sa = a.sources.size * Math.sqrt(a.volume24hUsd);
    const sb = b.sources.size * Math.sqrt(b.volume24hUsd);
    return sb - sa;
  });

  const final = filtered.slice(0, o.targetCount);
  log.info(
    {
      candidates: candidates.size,
      kept: final.length,
      droppedFdv,
      droppedLiq,
      droppedVol,
      droppedAge,
      multiSourceCount: final.filter((t) => t.sources.size >= 2).length,
    },
    'universe built',
  );
  return final;
}
