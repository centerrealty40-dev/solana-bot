/**
 * R1: Token Authenticity Detector — Validation suite
 *
 * Цель:
 *   Доказать (или опровергнуть) что наш PUMPCADE-детектор воспроизводимо
 *   отличает «настоящие» (organic) launches от «мёртвых» (sybil/farm).
 *
 *   Один кейс PUMPCADE = анекдот, не способность. Нужно min 5+5.
 *
 * Метод:
 *   1. Собираем 2 группы токенов из последних 30 дней:
 *      - WINNERS: live tokens (current liq >= $50k, current vol24h >= $10k,
 *        возраст > 3 дней — успели «выжить»)
 *      - LOSERS:  died tokens (current liq < $5k, но pairCreatedAt < 14 дней
 *        назад — недавние, чтобы Helius мог их найти)
 *   2. Для каждого: первые 30 swap-buyers → funder check (как в pumpcade)
 *   3. Считаем cleanliness score для каждого
 *   4. Печатаем:
 *      - score per token (winners ↔ losers)
 *      - distribution: median cleanliness в каждой группе
 *      - confusion matrix при threshold 50, 70, 80
 *      - verdict
 *
 * Источник кандидатов:
 *   - WINNERS: Dexscreener token-boosts/top + filter by liq/age
 *   - LOSERS:  Dexscreener token-profiles/latest + filter by dead-liq
 *   - Можно переопределить через CLI args:
 *       --winners mint1,mint2,...
 *       --losers  mint3,mint4,...
 *
 * Запуск:
 *   npx tsx scripts-tmp/detector-validation.ts                  # auto
 *   npx tsx scripts-tmp/detector-validation.ts --n 5            # 5+5 instead of default 7+7
 *   npx tsx scripts-tmp/detector-validation.ts --winners A,B,C --losers D,E,F
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing'); process.exit(1); }

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYMENT_MINTS = new Set([SOL_MINT, USDC_MINT]);

// ─── Tunables ───────────────────────────────────────────────────────────────

const FIRST_BUYERS_N = 30;
const FUNDING_LOOKBACK_SEC = 3600;
const FUNDING_MAX_LAMPORTS = 50_000_000; // 0.05 SOL
const MAX_PAGES = 50;
const HELIUS_PAGE_DELAY_MS = 250;
const HELIUS_RETRIES = 4;
const FUNDER_CONCURRENCY = 2;

const WINNER_MIN_LIQ_USD = 50_000;
const WINNER_MIN_VOL24_USD = 10_000;
const WINNER_MIN_AGE_DAYS = 3;
const WINNER_MAX_AGE_DAYS = 30;

const LOSER_MAX_LIQ_USD = 10_000;
const LOSER_MIN_AGE_DAYS = 1;
const LOSER_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

// ─── CLI args ───────────────────────────────────────────────────────────────

interface Args {
  n: number;                   // size of each group (winners + losers)
  winners?: string[];          // manual mint override
  losers?: string[];
  losersFromDb: boolean;       // pull losers from our `swaps` DB by low liq
  losersFromFarms: boolean;    // pull losers as mints touched by farm-tagged wallets
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const csv = (s?: string) => s ? s.split(',').map(x => x.trim()).filter(Boolean) : undefined;
  return {
    n: Number(get('--n') ?? 7),
    winners: csv(get('--winners')),
    losers: csv(get('--losers')),
    losersFromDb: argv.includes('--losers-from-db'),
    losersFromFarms: argv.includes('--losers-from-farms'),
  };
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function fetchJson<T = any>(url: string, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function pMap<T, R>(items: T[], conc: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ─── Dexscreener candidate discovery ────────────────────────────────────────

interface DexPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  pairCreatedAt?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
}

interface DexProfile {
  chainId: string;
  tokenAddress: string;
}

async function fetchPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  // dexscreener tokens endpoint accepts up to 30 addresses comma-separated
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  for (const ch of chunks) {
    try {
      const j = await fetchJson<{ pairs?: DexPair[] }>(
        `https://api.dexscreener.com/latest/dex/tokens/${ch.join(',')}`
      );
      for (const p of (j.pairs ?? [])) {
        if (p.chainId !== 'solana') continue;
        const mint = p.baseToken?.address;
        if (!mint) continue;
        // pick the pair with biggest liquidity per mint
        const prev = out.get(mint);
        if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) out.set(mint, p);
      }
    } catch (e) {
      console.warn(`[dex] tokens ${ch.length} failed: ${(e as Error).message}`);
    }
    await sleep(300);
  }
  return out;
}

/**
 * Pull mints from our `swaps` table that:
 *   - had activity in the last 1-30 days (so age window is reasonable for Helius)
 *   - had at least N distinct wallets touch them (was a real trading episode)
 *   - are not SOL/USDC/major stablecoins
 * Returns ordered by recency. Caller must intersect with current liq < threshold.
 */
async function fetchLosersFromDb(limit: number): Promise<{ mint: string; wallets: number; firstSeen: Date }[]> {
  try {
    const rows = await db.execute(dsql`
      SELECT base_mint AS mint,
             COUNT(DISTINCT wallet) AS wallets,
             MIN(block_time) AS first_seen,
             MAX(block_time) AS last_seen
      FROM swaps
      WHERE base_mint NOT IN (
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
      )
        AND block_time >= now() - interval '30 days'
        AND block_time <= now() - interval '1 days'
      GROUP BY base_mint
      HAVING COUNT(DISTINCT wallet) >= 5
      ORDER BY MIN(block_time) DESC
      LIMIT ${limit}
    `);
    return (rows as any[]).map(r => ({
      mint: r.mint,
      wallets: Number(r.wallets),
      firstSeen: new Date(r.first_seen),
    }));
  } catch (e) {
    console.warn(`[db] losers query failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Stronger losers source: mints where wallets tagged as scam/farm by our
 * `wallet-tagger` were among the early buyers. This gives us *active* sybil
 * operations (which our detector was actually built for), not passive failed
 * launches.
 *
 * Returns mints ordered by farm-buyer concentration (highest first).
 */
async function fetchLosersFromFarms(limit: number): Promise<{ mint: string; farmBuyers: number; totalBuyers: number; firstSeen: Date }[]> {
  try {
    const rows = await db.execute(dsql`
      WITH base AS (
        SELECT s.base_mint AS mint,
               s.wallet,
               s.block_time,
               wt.tag
        FROM swaps s
        JOIN wallet_tags wt ON wt.wallet = s.wallet
        WHERE wt.tag IN (
          'scam_operator', 'scam_payout', 'scam_treasury',
          'bot_farm_boss', 'bot_farm_distributor',
          'gas_distributor', 'terminal_distributor'
        )
          AND s.side = 'buy'
          AND s.base_mint NOT IN (
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
          )
          AND s.block_time >= now() - interval '30 days'
      )
      SELECT mint,
             COUNT(DISTINCT wallet) FILTER (WHERE tag IS NOT NULL) AS farm_buyers,
             COUNT(DISTINCT wallet) AS total_buyers,
             MIN(block_time) AS first_seen
      FROM base
      GROUP BY mint
      HAVING COUNT(DISTINCT wallet) FILTER (WHERE tag IS NOT NULL) >= 2
      ORDER BY COUNT(DISTINCT wallet) FILTER (WHERE tag IS NOT NULL) DESC
      LIMIT ${limit}
    `);
    return (rows as any[]).map(r => ({
      mint: r.mint,
      farmBuyers: Number(r.farm_buyers),
      totalBuyers: Number(r.total_buyers),
      firstSeen: new Date(r.first_seen),
    }));
  } catch (e) {
    console.warn(`[db] losers-from-farms query failed: ${(e as Error).message}`);
    return [];
  }
}

async function discoverCandidates(targetN: number): Promise<{ winners: DexPair[]; losers: DexPair[] }> {
  console.log('[discover] pulling boosted tokens (winners pool)...');
  let boosted: DexProfile[] = [];
  try {
    boosted = await fetchJson<DexProfile[]>('https://api.dexscreener.com/token-boosts/top/v1');
  } catch (e) { console.warn(`[dex] top-boosts failed: ${(e as Error).message}`); }
  const boostedSol = boosted.filter(p => p.chainId === 'solana').slice(0, 100);

  console.log('[discover] pulling latest profiles (losers pool)...');
  let profiles: DexProfile[] = [];
  try {
    profiles = await fetchJson<DexProfile[]>('https://api.dexscreener.com/token-profiles/latest/v1');
  } catch (e) { console.warn(`[dex] latest profiles failed: ${(e as Error).message}`); }
  const profilesSol = profiles.filter(p => p.chainId === 'solana').slice(0, 100);

  console.log('[discover] pulling latest boosted (extra pool)...');
  let boostedLatest: DexProfile[] = [];
  try {
    boostedLatest = await fetchJson<DexProfile[]>('https://api.dexscreener.com/token-boosts/latest/v1');
  } catch (e) { console.warn(`[dex] latest-boosts failed: ${(e as Error).message}`); }
  const boostedLatestSol = boostedLatest.filter(p => p.chainId === 'solana').slice(0, 100);

  const allMints = [...new Set([
    ...boostedSol.map(p => p.tokenAddress),
    ...profilesSol.map(p => p.tokenAddress),
    ...boostedLatestSol.map(p => p.tokenAddress),
  ])];
  console.log(`[discover] pulling pair data for ${allMints.length} candidates...`);
  const pairsByMint = await fetchPairs(allMints);

  const now = Date.now();
  const allPairs = [...pairsByMint.values()];

  const winners = allPairs
    .filter(p => {
      const age = p.pairCreatedAt ? now - p.pairCreatedAt : 0;
      const liq = p.liquidity?.usd ?? 0;
      const v24 = p.volume?.h24 ?? 0;
      return p.pairCreatedAt
        && age >= WINNER_MIN_AGE_DAYS * DAY_MS
        && age <= WINNER_MAX_AGE_DAYS * DAY_MS
        && liq >= WINNER_MIN_LIQ_USD
        && v24 >= WINNER_MIN_VOL24_USD;
    })
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    .slice(0, targetN * 3); // overprovision, we'll narrow later

  const losers = allPairs
    .filter(p => {
      const age = p.pairCreatedAt ? now - p.pairCreatedAt : 0;
      const liq = p.liquidity?.usd ?? 0;
      return p.pairCreatedAt
        && age >= LOSER_MIN_AGE_DAYS * DAY_MS
        && age <= LOSER_MAX_AGE_DAYS * DAY_MS
        && liq < LOSER_MAX_LIQ_USD;
    })
    .sort((a, b) => (a.pairCreatedAt ?? 0) - (b.pairCreatedAt ?? 0))
    .slice(0, targetN * 3);

  // shuffle and trim
  const sh = <T>(arr: T[]) => arr.map(v => [Math.random(), v] as [number, T]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  return {
    winners: sh(winners).slice(0, targetN),
    losers: sh(losers).slice(0, targetN),
  };
}

// ─── Helius: first buyers + funder check (lifted from pumpcade-backtest) ────

/**
 * Fetch a page of Helius parsed transactions for an address.
 * Retries on HTTP 429 with exponential backoff so rate-limit failures
 * don't silently masquerade as "no data".
 */
async function fetchHist(addr: string, limit = 100, before?: string): Promise<any[]> {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY!);
  u.searchParams.set('limit', String(limit));
  if (before) u.searchParams.set('before', before);

  let backoff = 1_000;
  for (let attempt = 0; attempt <= HELIUS_RETRIES; attempt++) {
    try {
      const r = await fetch(u.toString());
      if (r.status === 429) {
        if (attempt === HELIUS_RETRIES) {
          console.warn(`[helius] 429 after ${HELIUS_RETRIES + 1} attempts on ${addr.slice(0, 8)}…`);
          return [];
        }
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      if (!r.ok) {
        console.warn(`[helius] HTTP ${r.status} on ${addr.slice(0, 8)}… ${r.statusText}`);
        return [];
      }
      return await r.json() as any[];
    } catch (e) {
      if (attempt === HELIUS_RETRIES) {
        console.warn(`[helius] fetch error on ${addr.slice(0, 8)}…: ${(e as Error).message}`);
        return [];
      }
      await sleep(backoff);
      backoff *= 2;
    }
  }
  return [];
}

interface BuyerInfo {
  wallet: string;
  buyTs: number;
  funder?: string;
  funderAmount?: number;
  funderTsBefore?: number;
}

/**
 * Try to extract the buyer of `mint` from a Helius transaction.
 * Strategy:
 *   1. Primary: events.swap (works on Raydium / Jupiter / Meteora)
 *   2. Fallback: tokenTransfers showing `mint` arriving at a wallet that ALSO
 *      paid SOL or USDC out in the same tx (this catches pump.fun bonding-curve
 *      buys, which Helius doesn't classify as SWAP events).
 * Returns the buyer wallet, or null if this tx is not a buy of `mint`.
 */
function extractBuyer(tx: any, mint: string): string | null {
  // Primary: enhanced swap event
  const swap = tx.events?.swap;
  if (swap) {
    const out = swap.tokenOutputs?.[0];
    if (out?.mint === mint) {
      return out.userAccount ?? tx.feePayer ?? null;
    }
  }

  // Fallback: tokenTransfers + verify payment
  const tts = (tx.tokenTransfers ?? []) as any[];
  const candidates = tts.filter(t => t.mint === mint && (t.tokenAmount ?? 0) > 0 && t.toUserAccount);
  if (!candidates.length) return null;

  // for each potential buyer (recipient of `mint`), confirm they paid in this tx
  for (const c of candidates) {
    const buyer = c.toUserAccount as string;

    // a) paid native SOL
    const paidSol = (tx.nativeTransfers ?? []).some((n: any) =>
      n.fromUserAccount === buyer && (n.amount ?? 0) > 0
    );
    if (paidSol) return buyer;

    // b) paid WSOL or USDC via token transfer
    const paidPayment = tts.some(t =>
      t.fromUserAccount === buyer && PAYMENT_MINTS.has(t.mint) && (t.tokenAmount ?? 0) > 0
    );
    if (paidPayment) return buyer;
  }

  // Last resort: if there's exactly one recipient of `mint` and they're the feePayer,
  // it's almost certainly the buyer (pump.fun edge case where SOL routes through PDA).
  if (candidates.length === 1 && candidates[0].toUserAccount === tx.feePayer) {
    return tx.feePayer;
  }

  return null;
}

interface BuyerScanResult {
  buyers: BuyerInfo[];
  txsTotal: number;
  oldestReachedSec: number;   // 0 if no txs at all
  reachedLaunch: boolean;
  pages: number;
  source: string;             // 'pool' | 'mint' | 'pool→mint'
}

/**
 * Pull as much history as possible for `addr` (mint OR pool), back to launchMs.
 * Stops early when we've reached the launch window or pagination ends.
 */
async function pullHist(addr: string, launchSec: number): Promise<{ txs: any[]; pages: number; oldestSec: number }> {
  const all: any[] = [];
  let cursor: string | undefined;
  let pagesUsed = 0;
  let oldestSec = 0;
  for (let p = 0; p < MAX_PAGES; p++) {
    const txs = await fetchHist(addr, 100, cursor);
    pagesUsed = p + 1;
    if (!txs.length) break;
    all.push(...txs);
    oldestSec = txs[txs.length - 1]?.timestamp ?? 0;
    cursor = txs[txs.length - 1].signature;
    if (oldestSec <= launchSec) break;
    if (txs.length < 100) break;
    await sleep(HELIUS_PAGE_DELAY_MS);
  }
  return { txs: all, pages: pagesUsed, oldestSec };
}

/**
 * Get earliest buyers of `mint` within 1h of launch.
 * Strategy: prefer pool-address pagination (pool has only swap-related txs,
 * far fewer than mint, much higher chance to reach launch). Fall back to
 * mint pagination if pool gives nothing.
 */
async function getEarliestSwapBuyers(
  mint: string, pairAddress: string | undefined, launchMs: number, n: number,
): Promise<BuyerScanResult> {
  const launchSec = Math.floor(launchMs / 1000);
  const cutoffSec = launchSec + 3600;

  let source = 'mint';
  let { txs: all, pages, oldestSec } = pairAddress
    ? await pullHist(pairAddress, launchSec)
    : { txs: [] as any[], pages: 0, oldestSec: 0 };
  if (pairAddress) source = 'pool';

  // Fall back to mint pagination if pool gave nothing OR didn't reach launch
  if (all.length === 0 || (oldestSec > 0 && oldestSec > launchSec + 3600)) {
    const fallback = await pullHist(mint, launchSec);
    if (fallback.txs.length > all.length) {
      all = fallback.txs; pages = fallback.pages; oldestSec = fallback.oldestSec;
      source = pairAddress ? 'pool→mint' : 'mint';
    }
  }

  all.sort((a, b) => a.timestamp - b.timestamp);

  const buyers: BuyerInfo[] = [];
  const seen = new Set<string>();
  for (const tx of all) {
    if (tx.timestamp > cutoffSec) break;
    const buyer = extractBuyer(tx, mint);
    if (!buyer || seen.has(buyer)) continue;
    seen.add(buyer);
    buyers.push({ wallet: buyer, buyTs: tx.timestamp });
    if (buyers.length >= n) break;
  }
  return {
    buyers,
    txsTotal: all.length,
    oldestReachedSec: oldestSec,
    reachedLaunch: oldestSec > 0 && oldestSec <= launchSec,
    pages,
    source,
  };
}

async function annotateFunders(buyers: BuyerInfo[]): Promise<void> {
  await pMap(buyers, FUNDER_CONCURRENCY, async (buyer) => {
    const cutoffSec = buyer.buyTs - FUNDING_LOOKBACK_SEC;
    const txs = await fetchHist(buyer.wallet, 25);
    let best: { from: string; amount: number; ts: number } | undefined;
    for (const tx of txs) {
      if (tx.timestamp >= buyer.buyTs) continue;
      if (tx.timestamp < cutoffSec) continue;
      for (const t of tx.nativeTransfers ?? []) {
        if (t.toUserAccount !== buyer.wallet) continue;
        if (t.amount > FUNDING_MAX_LAMPORTS) continue;
        if (!best || t.amount > best.amount) {
          best = { from: t.fromUserAccount, amount: t.amount, ts: tx.timestamp };
        }
      }
    }
    if (best) {
      buyer.funder = best.from;
      buyer.funderAmount = best.amount / 1e9;
      buyer.funderTsBefore = buyer.buyTs - best.ts;
    }
  });
}

// ─── Scoring ────────────────────────────────────────────────────────────────

interface Score {
  group: 'WIN' | 'LOSE';
  mint: string;
  symbol: string;
  liquidityUsd: number;
  ageDays: number;
  buyersChecked: number;
  fundedCount: number;
  sharedFunderCount: number;
  topFunder?: string;
  cleanliness: number; // 0-100, higher = cleaner = looks more "real"
}

function score(group: 'WIN' | 'LOSE', pair: DexPair, buyers: BuyerInfo[]): Score {
  const checked = buyers.length;
  const ageDays = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / DAY_MS : 0;
  if (checked === 0) {
    return {
      group, mint: pair.baseToken.address, symbol: pair.baseToken.symbol,
      liquidityUsd: pair.liquidity?.usd ?? 0, ageDays,
      buyersChecked: 0, fundedCount: 0, sharedFunderCount: 0, cleanliness: -1,
    };
  }
  const funded = buyers.filter(b => b.funder);
  const fundedPct = funded.length / checked;
  const funderCounts = new Map<string, number>();
  for (const b of funded) funderCounts.set(b.funder!, (funderCounts.get(b.funder!) ?? 0) + 1);
  let topFunder: string | undefined;
  let topFunderCount = 0;
  for (const [f, c] of funderCounts) if (c > topFunderCount) { topFunder = f; topFunderCount = c; }
  const sharedFunderPct = topFunderCount >= 2 ? topFunderCount / checked : 0;
  const cleanliness = Math.max(0, 100 - Math.max(fundedPct, sharedFunderPct) * 100);
  return {
    group, mint: pair.baseToken.address, symbol: pair.baseToken.symbol,
    liquidityUsd: pair.liquidity?.usd ?? 0, ageDays,
    buyersChecked: checked, fundedCount: funded.length,
    sharedFunderCount: topFunderCount, topFunder, cleanliness,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function processOne(group: 'WIN' | 'LOSE', pair: DexPair, idx: number, total: number): Promise<Score> {
  const launchMs = pair.pairCreatedAt ?? Date.now() - DAY_MS * 7;
  process.stderr.write(`  [${group} ${idx + 1}/${total}] ${pair.baseToken.symbol.padEnd(10)} ${pair.baseToken.address.slice(0, 8)}… `);
  const r = await getEarliestSwapBuyers(pair.baseToken.address, pair.pairAddress, launchMs, FIRST_BUYERS_N);
  const oldestStr = r.oldestReachedSec
    ? new Date(r.oldestReachedSec * 1000).toISOString().slice(5, 16).replace('T', ' ')
    : 'none';
  const launchStr = new Date(launchMs).toISOString().slice(5, 16).replace('T', ' ');
  process.stderr.write(
    `src=${r.source} tx=${r.txsTotal} pg=${r.pages} oldest=${oldestStr} launch=${launchStr} reached=${r.reachedLaunch ? 'Y' : 'N'} buyers=${r.buyers.length} `,
  );
  if (r.buyers.length >= 5) {
    await annotateFunders(r.buyers);
    const funded = r.buyers.filter(b => b.funder).length;
    process.stderr.write(`funded=${funded} `);
  }
  const s = score(group, pair, r.buyers);
  process.stderr.write(`clean=${s.cleanliness < 0 ? 'NA' : s.cleanliness.toFixed(0)}\n`);
  return s;
}

function median(arr: number[]): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  const args = parseArgs();
  console.log('=== R1: Token Authenticity Detector — Validation ===\n');

  let winnerPairs: DexPair[];
  let loserPairs: DexPair[];

  if (args.winners?.length || args.losers?.length) {
    console.log('[manual] using user-provided mints, fetching pair data...');
    const ws = args.winners ?? [];
    const ls = args.losers ?? [];
    const all = [...ws, ...ls];
    const pairsByMint = await fetchPairs(all);
    winnerPairs = ws.map(m => pairsByMint.get(m)).filter(Boolean) as DexPair[];
    loserPairs = ls.map(m => pairsByMint.get(m)).filter(Boolean) as DexPair[];
    if (winnerPairs.length < ws.length) console.warn(`[manual] missing pair data for ${ws.length - winnerPairs.length} winners`);
    if (loserPairs.length < ls.length) console.warn(`[manual] missing pair data for ${ls.length - loserPairs.length} losers`);
  } else {
    const found = await discoverCandidates(args.n);
    winnerPairs = found.winners;
    loserPairs = found.losers;
  }

  if (args.losersFromDb) {
    console.log('[db] pulling extra loser candidates from our swaps history...');
    const extra = await fetchLosersFromDb(args.n * 3);
    if (extra.length) {
      const mints = extra.map(x => x.mint);
      const dexPairs = await fetchPairs(mints);
      const dbLosers: DexPair[] = [];
      for (const m of mints) {
        const p = dexPairs.get(m);
        if (!p) continue;
        const liq = p.liquidity?.usd ?? 0;
        if (liq <= LOSER_MAX_LIQ_USD) dbLosers.push(p);
      }
      console.log(`[db] +${dbLosers.length} losers from DB (active 1-30d ago, current liq <= $${LOSER_MAX_LIQ_USD})`);
      const seen = new Set(loserPairs.map(p => p.baseToken.address));
      for (const p of dbLosers) {
        if (seen.has(p.baseToken.address)) continue;
        loserPairs.push(p);
        seen.add(p.baseToken.address);
        if (loserPairs.length >= args.n) break;
      }
    }
  }

  if (args.losersFromFarms) {
    console.log('[db] pulling losers from farm-tagged buyers (HIGH-quality sybil mints)...');
    const farmMints = await fetchLosersFromFarms(args.n * 3);
    console.log(`[db] found ${farmMints.length} mints touched by farm-tagged wallets`);
    if (farmMints.length) {
      const mints = farmMints.map(x => x.mint);
      const dexPairs = await fetchPairs(mints);
      const seen = new Set(loserPairs.map(p => p.baseToken.address));
      let added = 0;
      for (const fm of farmMints) {
        if (seen.has(fm.mint)) continue;
        const p = dexPairs.get(fm.mint);
        if (!p) {
          // Mint exists in our swaps but Dexscreener has no pair info — likely fully dead.
          // Synthesize minimal pair so we can still try Helius lookup.
          const synth: DexPair = {
            chainId: 'solana',
            pairAddress: '',
            baseToken: { address: fm.mint, name: '?', symbol: `farm${added + 1}` },
            pairCreatedAt: fm.firstSeen.getTime(),
            liquidity: { usd: 0 },
          };
          loserPairs.push(synth);
        } else {
          loserPairs.push(p);
        }
        seen.add(fm.mint);
        added++;
        if (loserPairs.length >= args.n) break;
      }
      console.log(`[db] +${added} farm-losers added`);
    }
  }

  console.log(`\n--- WINNERS (${winnerPairs.length}) ---`);
  for (const p of winnerPairs) {
    const age = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / DAY_MS).toFixed(1) : '?';
    console.log(`  ${p.baseToken.address}  ${p.baseToken.symbol.padEnd(10)} liq=$${(p.liquidity?.usd ?? 0).toFixed(0).padStart(8)}  v24=$${(p.volume?.h24 ?? 0).toFixed(0).padStart(8)}  age=${age}d`);
  }
  console.log(`\n--- LOSERS (${loserPairs.length}) ---`);
  for (const p of loserPairs) {
    const age = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / DAY_MS).toFixed(1) : '?';
    console.log(`  ${p.baseToken.address}  ${p.baseToken.symbol.padEnd(10)} liq=$${(p.liquidity?.usd ?? 0).toFixed(0).padStart(8)}  age=${age}d`);
  }

  if (!winnerPairs.length || !loserPairs.length) {
    console.log('\n[abort] one or both groups empty. Try again or pass --winners/--losers manually.');
    return;
  }

  console.log(`\n=== STAGE: scoring ${winnerPairs.length + loserPairs.length} tokens via Helius ===\n`);
  const wScores: Score[] = [];
  for (let i = 0; i < winnerPairs.length; i++) wScores.push(await processOne('WIN', winnerPairs[i], i, winnerPairs.length));
  const lScores: Score[] = [];
  for (let i = 0; i < loserPairs.length; i++) lScores.push(await processOne('LOSE', loserPairs[i], i, loserPairs.length));

  const all = [...wScores, ...lScores].filter(s => s.cleanliness >= 0);

  console.log(`\n=== RESULTS — sorted by cleanliness ===\n`);
  all.sort((a, b) => b.cleanliness - a.cleanliness);
  console.log('rank  group  cleanliness  symbol      liq        age    buyers  funded  shared  topFunder');
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    console.log(
      `${String(i + 1).padStart(3)}.  ${s.group.padEnd(5)}  ${s.cleanliness.toFixed(1).padStart(5)}%      ` +
      `${s.symbol.padEnd(10)}  $${s.liquidityUsd.toFixed(0).padStart(7)}  ${s.ageDays.toFixed(1).padStart(4)}d  ` +
      `${String(s.buyersChecked).padStart(3)}     ${String(s.fundedCount).padStart(3)}     ${String(s.sharedFunderCount).padStart(3)}    ${(s.topFunder ?? '-').slice(0, 12)}`
    );
  }

  const wValid = wScores.filter(s => s.cleanliness >= 0);
  const lValid = lScores.filter(s => s.cleanliness >= 0);
  const wMed = median(wValid.map(s => s.cleanliness));
  const lMed = median(lValid.map(s => s.cleanliness));

  console.log(`\n=== SUMMARY ===\n`);
  console.log(`Group        n   median_clean   mean_clean`);
  const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  console.log(`WINNERS    ${String(wValid.length).padStart(3)}     ${wMed.toFixed(1).padStart(6)}%      ${mean(wValid.map(s => s.cleanliness)).toFixed(1).padStart(6)}%`);
  console.log(`LOSERS     ${String(lValid.length).padStart(3)}     ${lMed.toFixed(1).padStart(6)}%      ${mean(lValid.map(s => s.cleanliness)).toFixed(1).padStart(6)}%`);

  console.log(`\n=== CONFUSION MATRIX (clean >= threshold → predicted REAL) ===\n`);
  for (const t of [50, 70, 80, 90]) {
    const tp = wValid.filter(s => s.cleanliness >= t).length;
    const fn = wValid.length - tp;
    const fp = lValid.filter(s => s.cleanliness >= t).length;
    const tn = lValid.length - fp;
    const acc = (tp + tn) / (tp + fn + fp + tn) * 100;
    const prec = tp + fp > 0 ? tp / (tp + fp) * 100 : 0;
    const rec = tp + fn > 0 ? tp / (tp + fn) * 100 : 0;
    console.log(`threshold ${t}%:  TP=${tp} FN=${fn} FP=${fp} TN=${tn}  acc=${acc.toFixed(0)}%  precision=${prec.toFixed(0)}%  recall=${rec.toFixed(0)}%`);
  }

  console.log(`\n=== VERDICT ===`);
  const delta = wMed - lMed;
  if (Number.isNaN(delta)) {
    console.log('? Не хватает данных для вердикта');
  } else if (delta >= 30) {
    console.log(`✓ ОТЛИЧНО — winners чище losers на ${delta.toFixed(0)} п.п. медианы. Детектор работает.`);
  } else if (delta >= 15) {
    console.log(`~ СЛАБО — winners чище на ${delta.toFixed(0)} п.п., но граница размытая. Нужно подкрутить heuristic или больше выборки.`);
  } else if (delta >= 0) {
    console.log(`✗ ПОЧТИ НЕТ ПРЕИМУЩЕСТВА — разница ${delta.toFixed(0)} п.п. Гипотеза слабая.`);
  } else {
    console.log(`✗✗ ИНВЕРСИЯ — losers выглядят чище winners (${(-delta).toFixed(0)} п.п.). Гипотеза сломана / sampling bias.`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
