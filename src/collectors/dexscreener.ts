import WebSocket from 'ws';
import { request } from 'undici';
import { child } from '../core/logger.js';
import { db, schema } from '../core/db/client.js';
import { sql as dsql } from 'drizzle-orm';
import { isQuoteMint } from '../core/constants.js';

const log = child('dexscreener');

const HTTP_BASE = 'https://api.dexscreener.com/latest/dex';

/**
 * DexScreener public REST: search top trending tokens on Solana.
 * Used as a cheap "trending" feed since their WS endpoint is undocumented.
 *
 * Returns a list of pair objects with priceUsd, volume, liquidity.
 */
export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  volume?: { h24?: number; h1?: number; m5?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  pairCreatedAt?: number;
}

export async function getTopSolanaPairs(query = 'solana'): Promise<DexScreenerPair[]> {
  try {
    const res = await request(`${HTTP_BASE}/search?q=${encodeURIComponent(query)}`, {
      method: 'GET',
    });
    if (res.statusCode !== 200) {
      log.warn({ status: res.statusCode }, 'dexscreener search non-200');
      return [];
    }
    const json = (await res.body.json()) as { pairs?: DexScreenerPair[] };
    return (json.pairs ?? []).filter((p) => p.chainId === 'solana');
  } catch (err) {
    log.warn({ err }, 'dexscreener search failed');
    return [];
  }
}

export async function getPairsByMints(mints: string[]): Promise<DexScreenerPair[]> {
  if (mints.length === 0) return [];
  try {
    const url = `${HTTP_BASE}/tokens/${mints.slice(0, 30).join(',')}`;
    const res = await request(url, { method: 'GET' });
    if (res.statusCode !== 200) return [];
    const json = (await res.body.json()) as { pairs?: DexScreenerPair[] };
    return (json.pairs ?? []).filter((p) => p.chainId === 'solana');
  } catch (err) {
    log.warn({ err }, 'dexscreener tokens failed');
    return [];
  }
}

/**
 * Persist trending pairs to the tokens table and a price_samples row.
 * Picks the deepest-liquidity pair per base mint to avoid honeypot pairs.
 */
export async function persistDexScreenerSnapshot(pairs: DexScreenerPair[]): Promise<number> {
  if (pairs.length === 0) return 0;
  const byMint = new Map<string, DexScreenerPair>();
  for (const p of pairs) {
    if (isQuoteMint(p.baseToken.address)) continue;
    const liq = p.liquidity?.usd ?? 0;
    const cur = byMint.get(p.baseToken.address);
    if (!cur || (cur.liquidity?.usd ?? 0) < liq) byMint.set(p.baseToken.address, p);
  }
  if (byMint.size === 0) return 0;

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const [mint, p] of byMint) {
      await tx
        .insert(schema.tokens)
        .values({
          mint,
          symbol: p.baseToken.symbol,
          name: p.baseToken.name,
          fdvUsd: p.fdv ?? null,
          liquidityUsd: p.liquidity?.usd ?? null,
          volume24hUsd: p.volume?.h24 ?? null,
          primaryPair: p.pairAddress,
          updatedAt: now,
          firstSeenAt: p.pairCreatedAt ? new Date(p.pairCreatedAt) : now,
        })
        .onConflictDoUpdate({
          target: schema.tokens.mint,
          set: {
            symbol: p.baseToken.symbol,
            name: p.baseToken.name,
            fdvUsd: p.fdv ?? null,
            liquidityUsd: p.liquidity?.usd ?? null,
            volume24hUsd: p.volume?.h24 ?? null,
            primaryPair: p.pairAddress,
            updatedAt: now,
          },
        });

      const priceUsd = parseFloat(p.priceUsd ?? '0');
      const vol5m = p.volume?.m5 ?? 0;
      if (priceUsd > 0) {
        await tx
          .insert(schema.priceSamples)
          .values({ mint, ts: now, priceUsd, volumeUsd5m: vol5m })
          .onConflictDoNothing();
      }
    }
  });
  return byMint.size;
}

/**
 * Long-running poller. Calls DexScreener every `intervalSec` and persists trending pairs.
 *
 * Note: DexScreener's WebSocket is undocumented and rate-limited; their REST is officially
 * 300 req/min on /tokens/. We use a polite ~10 req/min schedule.
 */
export class DexScreenerPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly intervalSec: number = 60,
    private readonly queries: string[] = ['solana', 'meme', 'sol'],
  ) {}

  start(): void {
    log.info({ intervalSec: this.intervalSec }, 'starting DexScreener poller');
    const tick = async () => {
      try {
        const all: DexScreenerPair[] = [];
        for (const q of this.queries) {
          all.push(...(await getTopSolanaPairs(q)));
          await new Promise((r) => setTimeout(r, 1000));
        }
        const inserted = await persistDexScreenerSnapshot(all);
        log.debug({ inserted }, 'DexScreener tick');
      } catch (err) {
        log.warn({ err }, 'DexScreener tick failed');
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Optional: open a "live" pseudo-WebSocket via DexScreener's frontend WSS.
 * It is unofficial; if it ever breaks, we fall back to the REST poller.
 */
export class DexScreenerWS {
  private ws: WebSocket | null = null;
  private reconnectMs = 1000;

  constructor(
    private readonly chain = 'solana',
    private readonly onTick: (pairs: DexScreenerPair[]) => Promise<void> | void,
  ) {}

  connect(): void {
    const url = `wss://io.dexscreener.com/dex/screener/v4/pairs/h24/1?rankBy[key]=trendingScoreH6&rankBy[order]=desc&filters[chainIds][0]=${this.chain}`;
    log.info({ url }, 'connecting DexScreener WS');
    const ws = new WebSocket(url, {
      headers: {
        Origin: 'https://dexscreener.com',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      },
    });
    this.ws = ws;
    ws.on('open', () => {
      log.info('DexScreener WS connected');
      this.reconnectMs = 1000;
    });
    ws.on('message', (raw) => {
      try {
        const json = JSON.parse(String(raw)) as { pairs?: DexScreenerPair[] };
        if (json.pairs?.length) void this.onTick(json.pairs);
      } catch {
        // The endpoint sometimes sends ping frames; ignore.
      }
    });
    ws.on('close', () => {
      log.warn({ reconnectMs: this.reconnectMs }, 'DexScreener WS closed; reconnecting');
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    });
    ws.on('error', (err) => {
      log.warn({ err: String(err) }, 'DexScreener WS error');
    });
  }

  close(): void {
    this.ws?.close();
  }
}

/**
 * Returns an array of recently-active token mints we have seen swaps in,
 * useful as a default "universe" for hypotheses that operate on hot tokens.
 */
export async function getActiveTokenUniverse(minTradesLastHour = 5): Promise<string[]> {
  const since = new Date(Date.now() - 60 * 60_000);
  const rows = await db
    .select({
      mint: schema.swaps.baseMint,
      cnt: dsql<number>`count(*)::int`.as('cnt'),
    })
    .from(schema.swaps)
    .where(dsql`${schema.swaps.blockTime} >= ${since}`)
    .groupBy(schema.swaps.baseMint)
    .having(dsql`count(*) >= ${minTradesLastHour}`)
    .limit(500);
  return rows.map((r) => r.mint);
}
