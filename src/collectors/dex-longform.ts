import { request } from 'undici';
import { child } from '../core/logger.js';
import { isQuoteMint } from '../core/constants.js';

const log = child('dex-longform');

/**
 * A "long-form winner" candidate: a token that grew large over WEEKS, not
 * within a 24h pump-and-dump window. The thesis is that wallets which were
 * early in such tokens AND held through the journey have a fundamentally
 * different profile from launchpad snipers — they're conviction traders
 * with real information edge.
 *
 * Selection criteria (no historical price data needed — we use age + current
 * size as a proxy for "this token grew over time"):
 *   - pair created 14-90 days ago (survived initial cycle)
 *   - current FDV > $3M (no token launches at this size from scratch — it grew)
 *   - current liquidity > $200k (not a rug)
 *   - decent 24h volume (still active, scrapable)
 *
 * Why these thresholds catch winners: a memecoin that launched 30 days ago
 * with $30k initial liquidity and is now worth $20M FDV did a ~50x.
 * Filtering by age+FDV captures these without needing OHLC history.
 */
export interface LongformWinner {
  mint: string;
  symbol?: string;
  priceUsd?: number;
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd: number;
  ageDays: number;
  /** unix ms when the pair was created (= approximate launch time) */
  pairCreatedAt: number;
}

/**
 * Same blacklist philosophy as dex-pumped: skip wrapped majors, stables,
 * LSTs, and infrastructure tokens. We want pure speculation winners.
 */
const LONGFORM_BLACKLIST = new Set<string>([
  'So11111111111111111111111111111111111111112',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
]);

const LONGFORM_SYMBOL_RE =
  /^(.*USD[A-Z0-9]*|.*USDT|.*USDC|PYUSD|FDUSD|USDe|DAI|TUSD|FRAX|w?SOL|j[a-z]+SOL|bSOL|mSOL|stSOL|.*[bw]?BTC|.*[bw]?ETH|HYPE|SUI|DOGE|XRP|ADA|LINK|UNI|ARB|OP|MATIC|AVAX|DOT|TRX|TON|LTC|XMR|XLM|JUP|RAY|ORCA|JTO)$/i;

function isBlacklisted(mint: string, symbol?: string): boolean {
  if (LONGFORM_BLACKLIST.has(mint)) return true;
  if (symbol && LONGFORM_SYMBOL_RE.test(symbol)) return true;
  return false;
}

interface DexPair {
  chainId: string;
  baseToken: { address: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
  pairCreatedAt?: number;
}

/**
 * Pull a wide trending pool from DexScreener using diverse search seeds.
 * For long-form discovery we need MORE breadth than for pump-retro, since
 * mature tokens fall out of trending feeds quickly. Adding "mature" /
 * "established" terms surfaces pages that wouldn't appear under "pump".
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
    // long-form-specific: tokens that survived
    'gem',
    'hold',
    'community',
    'ai',
    'dog',
    'cat',
    'frog',
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
 * Both boost endpoints (latest + top by spend) tend to surface tokens that
 * teams are actively promoting — usually because they're on a real run.
 */
async function fetchBoostedMints(): Promise<string[]> {
  const out: string[] = [];
  for (const path of ['/token-boosts/latest/v1', '/token-boosts/top/v1']) {
    try {
      const res = await request(`https://api.dexscreener.com${path}`, { method: 'GET' });
      if (res.statusCode !== 200) continue;
      const json = (await res.body.json()) as Array<{ chainId: string; tokenAddress: string }>;
      for (const b of json) if (b.chainId === 'solana') out.push(b.tokenAddress);
    } catch (err) {
      log.warn({ path, err: String(err) }, 'dex boosts failed');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

/**
 * Resolve a flat list of mints to full DexPair info via /tokens/{mints}.
 * Required to get FDV + liquidity + age for boost-only mints.
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
 * Find tokens that meet "long-form winner" criteria. These are the input pool
 * for retroactive alpha discovery via the held-through-pump method.
 *
 * Sorted by FDV descending — biggest winners first (they have the strongest
 * "this is real" signal and the longest paper trail of buyers).
 */
export async function findLongformWinners(opts: {
  minFdvUsd?: number;
  maxFdvUsd?: number;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  minAgeDays?: number;
  maxAgeDays?: number;
  limit?: number;
} = {}): Promise<LongformWinner[]> {
  const o = {
    minFdvUsd: opts.minFdvUsd ?? 3_000_000,
    maxFdvUsd: opts.maxFdvUsd ?? 500_000_000, // exclude truly massive caps where alpha is gone
    minLiquidityUsd: opts.minLiquidityUsd ?? 200_000,
    minVolume24hUsd: opts.minVolume24hUsd ?? 50_000,
    minAgeDays: opts.minAgeDays ?? 14,
    maxAgeDays: opts.maxAgeDays ?? 90,
    limit: opts.limit ?? 15,
  };
  log.info({ filters: o }, 'searching long-form winners');

  const [trending, boosted] = await Promise.all([fetchTrendingPairs(), fetchBoostedMints()]);
  log.info(
    { trendingPairs: trending.length, boosted: boosted.length },
    'pools fetched',
  );

  const enriched: DexPair[] = [...trending];
  const mintsToEnrich = Array.from(new Set(boosted));
  if (mintsToEnrich.length) {
    const enrich = await enrichMints(mintsToEnrich);
    enriched.push(...enrich);
  }

  // Keep deepest-liquidity pool per mint (we want the canonical pair)
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
  const candidates: LongformWinner[] = [];
  let droppedNoFdv = 0;
  let droppedSmallFdv = 0;
  let droppedHugeFdv = 0;
  let droppedLiq = 0;
  let droppedVol = 0;
  let droppedAge = 0;
  let droppedNoCreated = 0;

  for (const p of byMint.values()) {
    if (!p.fdv) {
      droppedNoFdv++;
      continue;
    }
    if (p.fdv < o.minFdvUsd) {
      droppedSmallFdv++;
      continue;
    }
    if (p.fdv > o.maxFdvUsd) {
      droppedHugeFdv++;
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
    if (!p.pairCreatedAt) {
      droppedNoCreated++;
      continue;
    }
    const ageDays = (now - p.pairCreatedAt) / 86_400_000;
    if (ageDays < o.minAgeDays || ageDays > o.maxAgeDays) {
      droppedAge++;
      continue;
    }
    candidates.push({
      mint: p.baseToken.address,
      symbol: p.baseToken.symbol,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
      liquidityUsd: liq,
      volume24hUsd: vol,
      fdvUsd: p.fdv,
      ageDays,
      pairCreatedAt: p.pairCreatedAt,
    });
  }

  // Sort by FDV desc — biggest winners get attention first.
  // Tie-break by smaller age (younger = more recent winners = fresher alpha).
  candidates.sort((a, b) => {
    if (b.fdvUsd !== a.fdvUsd) return b.fdvUsd - a.fdvUsd;
    return a.ageDays - b.ageDays;
  });

  const final = candidates.slice(0, o.limit);
  log.info(
    {
      pool: byMint.size,
      kept: final.length,
      droppedNoFdv,
      droppedSmallFdv,
      droppedHugeFdv,
      droppedLiq,
      droppedVol,
      droppedAge,
      droppedNoCreated,
      preview: final
        .slice(0, 8)
        .map((t) => `${t.symbol ?? t.mint.slice(0, 4)}($${(t.fdvUsd / 1e6).toFixed(1)}M,${t.ageDays.toFixed(0)}d)`)
        .join(', '),
    },
    'long-form winners selected',
  );
  return final;
}
