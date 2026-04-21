/**
 * Backtest: «Token Authenticity Detector»
 *
 * Гипотеза: настоящий runner-токен имеет органических первых покупателей,
 * копии (sybil-фабрики) — синтетических.
 *
 * Метод:
 *   1. Берём через Dexscreener все токены с тикером «PUMPCADE» на Solana
 *   2. Фильтруем по окну создания: 14-апр-2026 ± 48h (момент анонса Pumpcade)
 *   3. Для каждого: первые 30 swap-покупателей из Helius
 *   4. Для каждого buyer'а: был ли он профинансирован < 0.05 SOL за час до покупки
 *   5. Cleanliness = % buyer'ов БЕЗ малого funding'а ровно перед покупкой
 *      + штраф за совпадение funder'а у нескольких buyer'ов одного токена
 *   6. Ранжируем — top-1 должен совпасть с известным настоящим:
 *      Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu
 */

import 'dotenv/config';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing'); process.exit(1); }

const QUERY = 'PUMPCADE';
const KNOWN_REAL = 'Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu';
const EVENT_TIME_MS = new Date('2026-04-14T00:00:00Z').getTime();
const WINDOW_MS = 48 * 3600 * 1000;
const MAX_CANDIDATES = 25;
const FIRST_BUYERS_N = 30;
const FUNDING_LOOKBACK_SEC = 3600;
const FUNDING_MAX_LAMPORTS = 50_000_000; // 0.05 SOL

interface DexPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  pairCreatedAt?: number;
  liquidity?: { usd?: number };
  fdv?: number;
}

interface BuyerInfo {
  wallet: string;
  buyTs: number;
  funder?: string;
  funderAmount?: number;
  funderTsBefore?: number;
}

async function fetchDex(query: string): Promise<DexPair[]> {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
  const j = await r.json() as any;
  return (j.pairs ?? []).filter((p: DexPair) => p.chainId === 'solana');
}

async function fetchHist(addr: string, limit = 100, before?: string): Promise<any[]> {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY!);
  u.searchParams.set('limit', String(limit));
  if (before) u.searchParams.set('before', before);
  try {
    const r = await fetch(u.toString());
    if (!r.ok) return [];
    return await r.json() as any[];
  } catch { return []; }
}

async function pMap<T, R>(items: T[], conc: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Walk Helius pages from newest to oldest until we cover the launch window. */
async function getEarliestSwapBuyers(mint: string, launchMs: number, n: number): Promise<BuyerInfo[]> {
  const launchSec = Math.floor(launchMs / 1000);
  const cutoffSec = launchSec + 3600;
  const all: any[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < 30; p++) {
    const txs = await fetchHist(mint, 100, cursor);
    if (!txs.length) break;
    all.push(...txs);
    const oldestSec = txs[txs.length - 1]?.timestamp ?? 0;
    cursor = txs[txs.length - 1].signature;
    if (oldestSec <= launchSec) break;
    if (txs.length < 100) break;
  }
  all.sort((a, b) => a.timestamp - b.timestamp);

  const buyers: BuyerInfo[] = [];
  const seen = new Set<string>();
  for (const tx of all) {
    if (tx.timestamp > cutoffSec) break;
    const swap = tx.events?.swap;
    if (!swap) continue;
    const out = swap.tokenOutputs?.[0];
    if (out?.mint !== mint) continue;
    const buyer = out.userAccount ?? tx.feePayer;
    if (!buyer || seen.has(buyer)) continue;
    seen.add(buyer);
    buyers.push({ wallet: buyer, buyTs: tx.timestamp });
    if (buyers.length >= n) break;
  }
  return buyers;
}

/** For each buyer find: was there a small native SOL transfer TO them within an hour before the buy. */
async function annotateFunders(buyers: BuyerInfo[]): Promise<void> {
  await pMap(buyers, 6, async (buyer) => {
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

interface Score {
  mint: string;
  symbol: string;
  name: string;
  buyersChecked: number;
  fundedCount: number;
  sharedFunderCount: number;
  topFunder?: string;
  topFunderShare: number;
  cleanliness: number;
  liquidityUsd?: number;
  pairCreatedAt?: number;
}

function score(mint: string, symbol: string, name: string, buyers: BuyerInfo[], liq?: number, createdAt?: number): Score {
  const checked = buyers.length;
  if (checked === 0) {
    return { mint, symbol, name, buyersChecked: 0, fundedCount: 0, sharedFunderCount: 0, topFunderShare: 0, cleanliness: 0, liquidityUsd: liq, pairCreatedAt: createdAt };
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
    mint, symbol, name,
    buyersChecked: checked,
    fundedCount: funded.length,
    sharedFunderCount: topFunderCount,
    topFunder,
    topFunderShare: sharedFunderPct,
    cleanliness,
    liquidityUsd: liq,
    pairCreatedAt: createdAt,
  };
}

async function main() {
  console.log(`\n=== STAGE 1: discovery via Dexscreener ===\n`);
  const pairs = await fetchDex(QUERY);
  console.log(`Solana pairs matching "${QUERY}": ${pairs.length}`);

  const dedupByMint = new Map<string, DexPair>();
  for (const p of pairs) {
    if (!p.baseToken?.address) continue;
    const prev = dedupByMint.get(p.baseToken.address);
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
      dedupByMint.set(p.baseToken.address, p);
    }
  }
  let candidates = [...dedupByMint.values()];

  const lo = EVENT_TIME_MS - WINDOW_MS;
  const hi = EVENT_TIME_MS + WINDOW_MS;
  const inWindow = candidates.filter(p => p.pairCreatedAt && p.pairCreatedAt >= lo && p.pairCreatedAt <= hi);
  const known = candidates.find(p => p.baseToken.address === KNOWN_REAL);
  if (known && !inWindow.find(p => p.baseToken.address === KNOWN_REAL)) inWindow.push(known);

  console.log(`Created in window 14-apr ±48h: ${inWindow.length}`);
  inWindow.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  candidates = inWindow.slice(0, MAX_CANDIDATES);
  console.log(`Will analyze top-${candidates.length} by liquidity\n`);
  for (const c of candidates) {
    const created = c.pairCreatedAt ? new Date(c.pairCreatedAt).toISOString() : '?';
    console.log(`  ${c.baseToken.address}  ${c.baseToken.symbol.padEnd(10)} ${(c.baseToken.name ?? '').slice(0,30).padEnd(30)} liq=$${(c.liquidity?.usd ?? 0).toFixed(0).padStart(8)}  ${created}${c.baseToken.address === KNOWN_REAL ? '  <-- known REAL' : ''}`);
  }

  console.log(`\n=== STAGE 2: extract first ${FIRST_BUYERS_N} buyers per candidate ===\n`);
  const allScores: Score[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const launchMs = c.pairCreatedAt ?? EVENT_TIME_MS;
    process.stderr.write(`[${i+1}/${candidates.length}] ${c.baseToken.symbol} ${c.baseToken.address.slice(0,8)}… `);
    const buyers = await getEarliestSwapBuyers(c.baseToken.address, launchMs, FIRST_BUYERS_N);
    process.stderr.write(`buyers=${buyers.length} `);
    if (buyers.length >= 5) {
      await annotateFunders(buyers);
      const funded = buyers.filter(b => b.funder).length;
      process.stderr.write(`funded=${funded} `);
    }
    const s = score(c.baseToken.address, c.baseToken.symbol, c.baseToken.name ?? '', buyers, c.liquidity?.usd, c.pairCreatedAt);
    allScores.push(s);
    process.stderr.write(`clean=${s.cleanliness.toFixed(0)}\n`);
  }

  console.log(`\n=== STAGE 3: ranking by cleanliness ===\n`);
  allScores.sort((a, b) => b.cleanliness - a.cleanliness);
  console.log('rank  cleanliness  mint                                          symbol      buyers  funded  shared  topFunder       liq');
  for (let i = 0; i < allScores.length; i++) {
    const s = allScores[i];
    const marker = s.mint === KNOWN_REAL ? '  <<< REAL' : '';
    console.log(
      `${String(i+1).padStart(3)}.  ${s.cleanliness.toFixed(1).padStart(5)}%      ${s.mint}  ${s.symbol.padEnd(10)}  ${String(s.buyersChecked).padStart(3)}     ${String(s.fundedCount).padStart(3)}    ${String(s.sharedFunderCount).padStart(3)}    ${(s.topFunder ?? '-').slice(0,12).padEnd(13)}  $${(s.liquidityUsd ?? 0).toFixed(0)}${marker}`
    );
  }

  const realRank = allScores.findIndex(s => s.mint === KNOWN_REAL) + 1;
  console.log(`\n=== VERDICT ===`);
  console.log(`Известный настоящий PUMPCADE = ${KNOWN_REAL}`);
  console.log(`Его место в нашем рейтинге чистоты: #${realRank} из ${allScores.length}`);
  if (realRank === 1) console.log('✓ Детектор сработал ИДЕАЛЬНО — top-1 это настоящий');
  else if (realRank <= 3) console.log('~ Детектор сработал с шумом — настоящий в топ-3');
  else console.log('✗ Детектор НЕ сработал — настоящий не в топ-3, гипотеза слабая');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
