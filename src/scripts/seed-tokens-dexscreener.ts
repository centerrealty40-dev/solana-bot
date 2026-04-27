/**
 * Pull trending Solana token addresses from DexScreener (HTTP only, no QuickNode)
 * and INSERT missing rows into `tokens` so paper strategies / SQL see them.
 *
 * Does not create swaps; PumpPortal + collectors still own execution data.
 * metadata.source = dexscreener_seed (adjust paper filters if you need FV to include it).
 *
 *   npm run tokens:seed:dex
 *   SEED_DEXSCREENER_LIMIT=80 npm run tokens:seed:dex
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('seed-tokens-dexscreener');

const LIMIT = Math.min(200, Math.max(10, Number(process.env.SEED_DEXSCREENER_LIMIT || 80)));
const SLEEP_MS = Math.max(0, Number(process.env.SEED_DEXSCREENER_SLEEP_MS || 400));

interface DexProfile {
  chainId?: string;
  tokenAddress?: string;
  url?: string;
  icon?: string;
  header?: string;
  description?: string;
  symbol?: string;
  name?: string;
}

function base58Mint(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function seedTokensFromDexScreener(): Promise<{ seen: number; inserted: number }> {
  const sets: DexProfile[] = [];
  const urls = [
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-boosts/top/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ];
  for (const u of urls) {
    const j = await fetchJson<DexProfile[]>(u);
    if (j?.length) {
      sets.push(...j);
    }
    await sleep(SLEEP_MS);
  }

  const sol = sets.filter((p) => p.chainId === 'solana' && p.tokenAddress && base58Mint(p.tokenAddress));
  const uniq = new Map<string, DexProfile>();
  for (const p of sol) {
    if (p.tokenAddress && !uniq.has(p.tokenAddress)) {
      uniq.set(p.tokenAddress, p);
    }
  }
  const list = [...uniq.values()].slice(0, LIMIT);

  let inserted = 0;
  for (const p of list) {
    const mint = p.tokenAddress!;
    try {
      const ex = await db.select({ mint: schema.tokens.mint }).from(schema.tokens).where(eq(schema.tokens.mint, mint)).limit(1);
      if (ex.length > 0) {
        continue;
      }
      await db.insert(schema.tokens).values({
        mint,
        symbol: (p.symbol || '?').slice(0, 32),
        name: (p.name || p.description || 'unknown').slice(0, 128),
        decimals: 6,
        devWallet: null,
        firstSeenAt: new Date(),
        metadata: {
          source: 'dexscreener_seed',
          url: p.url,
          icon: p.icon,
          header: p.header,
        },
      });
      inserted += 1;
    } catch (e) {
      log.warn({ mint, err: String(e) }, 'insert skip');
    }
  }

  log.info({ candidates: list.length, inserted }, 'seed done');
  return { seen: list.length, inserted };
}

async function main() {
  const o = await seedTokensFromDexScreener();
  console.log(JSON.stringify(o));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
