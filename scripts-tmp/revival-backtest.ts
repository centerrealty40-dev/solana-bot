/**
 * Backtest «Revival Sniper» strategy — v2
 *
 * v1 проблема: Helius events.swap ловит ~5% реальных сделок
 *              + mint-адрес видит подмножество (большинство трейдов идут через pool)
 *
 * v2 фикс:
 *   - Pool-адреса из Dexscreener (топ-3 по ликвидности)
 *   - Fetch tx истории каждого пула
 *   - Свопы реконструируем из tokenTransfers + nativeTransfers (как наш normalizer)
 *   - Пагинация останавливается по дате (revival ± окно)
 */

import 'dotenv/config';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing'); process.exit(1); }

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WSOL_MINT = SOL_MINT;

interface TokenSpec {
  name: string;
  mint: string;
  revivalDateIso: string;
  windowDaysBefore: number;
  windowDaysAfter: number;
}

const TOKENS: TokenSpec[] = [
  { name: 'TOKABU',   mint: 'H8xQ6poBjB9DTPMDTKWzWPrnxu4bDEhybxiouF8Ppump', revivalDateIso: '2026-04-15T00:00:00Z', windowDaysBefore: 14, windowDaysAfter: 5 },
  { name: 'JONATHAN', mint: 'EJmkht54g9zKws1C2qAVvjdhwKSy9suhdBsSDU6egcrL', revivalDateIso: '2026-04-02T00:00:00Z', windowDaysBefore: 14, windowDaysAfter: 5 },
  { name: 'PUMPCADE', mint: 'Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu', revivalDateIso: '2026-04-14T00:00:00Z', windowDaysBefore: 14, windowDaysAfter: 5 },
];

const MAX_PAGES_PER_POOL = 800;
const TOP_POOLS_PER_TOKEN = 3;
const TP             = 1.5;
const SL             = 0.8;
const TIMEOUT_MIN    = 60;
const ENTRY_DELAY_MIN = 5;
const SPIKE_VOL_X    = 5;
const SPIKE_PRICE_PCT = 20;
const BASELINE_DAYS  = 7;
const MIN_BASELINE_HOURS = 4;

interface Swap { ts: number; price: number; volSol: number; side: 'buy' | 'sell'; sig: string; }
interface Candle { ts: number; vwap: number; high: number; low: number; volSol: number; count: number; }
interface Trade {
  entryTs: number; entryPrice: number;
  exitTs: number;  exitPrice: number;
  reason: 'TP' | 'SL' | 'TIMEOUT';
  pnlPct: number;  rMultiple: number;
}

async function fetchHist(addr: string, before?: string, retries = 3): Promise<any[]> {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY!);
  u.searchParams.set('limit', '100');
  if (before) u.searchParams.set('before', before);
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(u.toString());
      if (r.status === 429) { await new Promise(res => setTimeout(res, 1500)); continue; }
      if (!r.ok) {
        if (i === retries - 1) console.error(`fetchHist ${addr.slice(0,8)} → ${r.status}`);
        await new Promise(res => setTimeout(res, 500));
        continue;
      }
      return await r.json() as any[];
    } catch (e) { await new Promise(res => setTimeout(res, 500)); }
  }
  return [];
}

interface DexPair {
  pairAddress: string;
  baseToken: { address: string };
  quoteToken: { address: string };
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
}

async function findPools(mint: string): Promise<{ pool: string; liq: number }[]> {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${mint}`);
  const j = await r.json() as any;
  const pairs: DexPair[] = (j.pairs ?? []).filter((p: any) =>
    p.chainId === 'solana' &&
    (p.baseToken?.address === mint || p.quoteToken?.address === mint)
  );
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pairs.slice(0, TOP_POOLS_PER_TOKEN).map(p => ({ pool: p.pairAddress, liq: p.liquidity?.usd ?? 0 }));
}

/**
 * Reconstruct a swap from a tx by looking at token + native transfers.
 * For our target mint we want: how much SOL was paid/received, how much mint was received/paid.
 * Returns null if tx doesn't look like a buy/sell of this mint.
 */
function extractSwap(tx: any, mint: string): Omit<Swap, 'sig'> | null {
  const tokenTransfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];
  if (!tokenTransfers.length) return null;

  // Sum token movements per wallet (positive = received, negative = sent) for our mint
  const mintNetByWallet = new Map<string, number>();
  for (const t of tokenTransfers) {
    if (t.mint !== mint) continue;
    const amt = Number(t.tokenAmount ?? 0);
    if (!isFinite(amt) || amt === 0) continue;
    if (t.fromUserAccount) mintNetByWallet.set(t.fromUserAccount, (mintNetByWallet.get(t.fromUserAccount) ?? 0) - amt);
    if (t.toUserAccount)   mintNetByWallet.set(t.toUserAccount,   (mintNetByWallet.get(t.toUserAccount)   ?? 0) + amt);
  }

  // Sum native SOL movements per wallet
  const solNetByWallet = new Map<string, number>();
  for (const n of nativeTransfers) {
    const amt = Number(n.amount ?? 0) / 1e9;
    if (n.fromUserAccount) solNetByWallet.set(n.fromUserAccount, (solNetByWallet.get(n.fromUserAccount) ?? 0) - amt);
    if (n.toUserAccount)   solNetByWallet.set(n.toUserAccount,   (solNetByWallet.get(n.toUserAccount)   ?? 0) + amt);
  }
  // Also account for WSOL transfers as SOL
  for (const t of tokenTransfers) {
    if (t.mint !== WSOL_MINT) continue;
    const amt = Number(t.tokenAmount ?? 0);
    if (t.fromUserAccount) solNetByWallet.set(t.fromUserAccount, (solNetByWallet.get(t.fromUserAccount) ?? 0) - amt);
    if (t.toUserAccount)   solNetByWallet.set(t.toUserAccount,   (solNetByWallet.get(t.toUserAccount)   ?? 0) + amt);
  }

  // Find a wallet that swapped — got tokens and lost SOL (BUY) or vice versa (SELL).
  // Take the largest absolute movement.
  let best: { wallet: string; tokDelta: number; solDelta: number; side: 'buy' | 'sell' } | null = null;
  for (const [wallet, tokDelta] of mintNetByWallet) {
    const solDelta = solNetByWallet.get(wallet) ?? 0;
    if (Math.abs(tokDelta) < 1e-9) continue;
    if (tokDelta > 0 && solDelta < -0.0001) {
      const candidate = { wallet, tokDelta, solDelta, side: 'buy' as const };
      if (!best || Math.abs(tokDelta) > Math.abs(best.tokDelta)) best = candidate;
    } else if (tokDelta < 0 && solDelta > 0.0001) {
      const candidate = { wallet, tokDelta, solDelta, side: 'sell' as const };
      if (!best || Math.abs(tokDelta) > Math.abs(best.tokDelta)) best = candidate;
    }
  }
  if (!best) return null;
  const solAmt = Math.abs(best.solDelta);
  const tokAmt = Math.abs(best.tokDelta);
  if (solAmt < 0.001 || tokAmt < 1e-9) return null;
  return { ts: tx.timestamp, price: solAmt / tokAmt, volSol: solAmt, side: best.side };
}

async function fetchPoolSwaps(pool: string, mint: string, fromTsSec: number, toTsSec: number): Promise<Swap[]> {
  const swaps: Swap[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < MAX_PAGES_PER_POOL; p++) {
    const txs = await fetchHist(pool, cursor);
    if (!txs.length) break;
    let oldestInPage = Number.MAX_SAFE_INTEGER;
    for (const tx of txs) {
      oldestInPage = Math.min(oldestInPage, tx.timestamp);
      if (tx.timestamp > toTsSec) continue;
      if (tx.timestamp < fromTsSec) continue;
      const s = extractSwap(tx, mint);
      if (s) swaps.push({ ...s, sig: tx.signature });
    }
    cursor = txs[txs.length - 1].signature;
    if (p % 10 === 9) process.stderr.write(`    pool ${pool.slice(0,8)} page ${p+1}, swaps=${swaps.length}, oldest=${new Date(oldestInPage * 1000).toISOString()}\n`);
    if (oldestInPage < fromTsSec) break;
    if (txs.length < 100) break;
  }
  return swaps;
}

function bucketize(swaps: Swap[]): Candle[] {
  if (!swaps.length) return [];
  swaps.sort((a, b) => a.ts - b.ts);
  const byMin = new Map<number, Candle>();
  for (const s of swaps) {
    const m = Math.floor(s.ts / 60) * 60;
    let c = byMin.get(m);
    if (!c) { c = { ts: m, vwap: s.price, high: s.price, low: s.price, volSol: 0, count: 0 }; byMin.set(m, c); }
    c.vwap = (c.vwap * c.volSol + s.price * s.volSol) / (c.volSol + s.volSol);
    c.high = Math.max(c.high, s.price);
    c.low  = Math.min(c.low, s.price);
    c.volSol += s.volSol;
    c.count++;
  }
  const minTs = Math.floor(swaps[0].ts / 60) * 60;
  const maxTs = Math.floor(swaps[swaps.length - 1].ts / 60) * 60;
  const all: Candle[] = [];
  let prevPrice = swaps[0].price;
  for (let t = minTs; t <= maxTs; t += 60) {
    const c = byMin.get(t);
    if (c) { all.push(c); prevPrice = c.vwap; }
    else   all.push({ ts: t, vwap: prevPrice, high: prevPrice, low: prevPrice, volSol: 0, count: 0 });
  }
  return all;
}

function findSpike(candles: Candle[]): number {
  for (let i = 60; i < candles.length; i++) {
    const w = candles.slice(i - 60, i);
    const vol1h = w.reduce((s, c) => s + c.volSol, 0);
    if (vol1h <= 0) continue;
    const firstWithTrades = w.find(c => c.count > 0);
    const lastWithTrades  = [...w].reverse().find(c => c.count > 0);
    if (!firstWithTrades || !lastWithTrades) continue;
    const priceStart = firstWithTrades.vwap;
    const priceEnd   = lastWithTrades.vwap;
    if (priceStart <= 0) continue;
    const priceChangePct = ((priceEnd - priceStart) / priceStart) * 100;

    const baselineEnd = i - 60;
    const baselineStart = Math.max(0, baselineEnd - 60 * 24 * BASELINE_DAYS);
    const baseline = candles.slice(baselineStart, baselineEnd);
    if (baseline.length < MIN_BASELINE_HOURS * 60) continue;
    const baselineHourlyVol = baseline.reduce((s, c) => s + c.volSol, 0) / (baseline.length / 60);

    let volX: number;
    if (baselineHourlyVol === 0) {
      if (vol1h < 5) continue;
      volX = Infinity;
    } else {
      volX = vol1h / baselineHourlyVol;
    }

    if (volX >= SPIKE_VOL_X && priceChangePct >= SPIKE_PRICE_PCT) {
      return i;
    }
  }
  return -1;
}

function simulate(candles: Candle[], spikeIdx: number): Trade | undefined {
  const entryStartIdx = spikeIdx + ENTRY_DELAY_MIN;
  if (entryStartIdx >= candles.length) return undefined;
  let entryIdx = -1;
  let entryPrice = 0;
  for (let j = entryStartIdx; j < Math.min(entryStartIdx + 10, candles.length); j++) {
    if (candles[j].count > 0) { entryIdx = j; entryPrice = candles[j].vwap; break; }
  }
  if (entryIdx < 0) return undefined;
  const tpPx = entryPrice * TP;
  const slPx = entryPrice * SL;
  for (let j = entryIdx + 1; j < Math.min(entryIdx + 1 + TIMEOUT_MIN, candles.length); j++) {
    const c = candles[j];
    if (c.count === 0) continue;
    if (c.high >= tpPx) {
      const pnl = ((tpPx - entryPrice) / entryPrice) * 100;
      return { entryTs: candles[entryIdx].ts, entryPrice, exitTs: c.ts, exitPrice: tpPx, reason: 'TP', pnlPct: pnl, rMultiple: pnl / 20 };
    }
    if (c.low <= slPx) {
      const pnl = ((slPx - entryPrice) / entryPrice) * 100;
      return { entryTs: candles[entryIdx].ts, entryPrice, exitTs: c.ts, exitPrice: slPx, reason: 'SL', pnlPct: pnl, rMultiple: pnl / 20 };
    }
  }
  const lastIdx = Math.min(entryIdx + TIMEOUT_MIN, candles.length - 1);
  const exitPrice = candles[lastIdx].vwap;
  const pnl = ((exitPrice - entryPrice) / entryPrice) * 100;
  return { entryTs: candles[entryIdx].ts, entryPrice, exitTs: candles[lastIdx].ts, exitPrice, reason: 'TIMEOUT', pnlPct: pnl, rMultiple: pnl / 20 };
}

async function main() {
  const results: { name: string; trade?: Trade; spike?: number; n_swaps: number; n_candles: number; pools: string[] }[] = [];

  for (const tok of TOKENS) {
    console.log(`\n=== ${tok.name} ===`);
    console.log(`mint: ${tok.mint}`);
    const revivalSec = Math.floor(new Date(tok.revivalDateIso).getTime() / 1000);
    const fromSec = revivalSec - tok.windowDaysBefore * 24 * 3600;
    const toSec   = revivalSec + tok.windowDaysAfter * 24 * 3600;
    console.log(`Window: ${new Date(fromSec * 1000).toISOString()} → ${new Date(toSec * 1000).toISOString()}`);

    process.stderr.write(`  Discovering pools via Dexscreener...\n`);
    const pools = await findPools(tok.mint);
    console.log(`Pools found: ${pools.length}`);
    for (const p of pools) console.log(`  ${p.pool}  liq=$${p.liq.toFixed(0)}`);
    if (!pools.length) {
      console.log(`No pools found, skipping`);
      results.push({ name: tok.name, n_swaps: 0, n_candles: 0, pools: [] });
      continue;
    }

    const allSwaps: Swap[] = [];
    for (const p of pools) {
      process.stderr.write(`  Fetching pool ${p.pool.slice(0,8)}…\n`);
      const ps = await fetchPoolSwaps(p.pool, tok.mint, fromSec, toSec);
      process.stderr.write(`    +${ps.length} swaps\n`);
      allSwaps.push(...ps);
    }
    const dedup = new Map<string, Swap>();
    for (const s of allSwaps) {
      const key = `${s.sig}_${s.side}_${s.volSol.toFixed(4)}`;
      if (!dedup.has(key)) dedup.set(key, s);
    }
    const swaps = [...dedup.values()];
    console.log(`Swaps total (deduped): ${swaps.length}`);

    if (swaps.length < 100) {
      console.log(`Too few swaps for analysis`);
      results.push({ name: tok.name, n_swaps: swaps.length, n_candles: 0, pools: pools.map(p => p.pool) });
      continue;
    }
    const candles = bucketize(swaps);
    console.log(`Candles: ${candles.length} (${(candles.length / 60 / 24).toFixed(1)} days coverage)`);
    console.log(`Range: ${new Date(candles[0].ts * 1000).toISOString()} → ${new Date(candles[candles.length-1].ts * 1000).toISOString()}`);

    const spikeIdx = findSpike(candles);
    if (spikeIdx < 0) {
      console.log(`No spike matching vol≥${SPIKE_VOL_X}x AND price≥+${SPIKE_PRICE_PCT}% in 1h`);
      results.push({ name: tok.name, n_swaps: swaps.length, n_candles: candles.length, pools: pools.map(p => p.pool) });
      continue;
    }
    const spikeTs = candles[spikeIdx].ts;
    console.log(`Spike detected: ${new Date(spikeTs * 1000).toISOString()} (candle #${spikeIdx})`);

    const trade = simulate(candles, spikeIdx);
    if (!trade) {
      console.log(`Could not simulate (no liquidity post-spike)`);
      results.push({ name: tok.name, spike: spikeIdx, n_swaps: swaps.length, n_candles: candles.length, pools: pools.map(p => p.pool) });
      continue;
    }
    console.log(`Entry: ${new Date(trade.entryTs * 1000).toISOString()} @ ${trade.entryPrice.toExponential(3)} SOL/token`);
    console.log(`Exit:  ${new Date(trade.exitTs  * 1000).toISOString()} @ ${trade.exitPrice .toExponential(3)} (${trade.reason})`);
    console.log(`P&L: ${trade.pnlPct.toFixed(1)}%   R: ${trade.rMultiple.toFixed(2)}`);
    results.push({ name: tok.name, trade, spike: spikeIdx, n_swaps: swaps.length, n_candles: candles.length, pools: pools.map(p => p.pool) });
  }

  console.log(`\n\n========== AGGREGATE ==========`);
  const trades = results.map(r => r.trade).filter((t): t is Trade => !!t);
  if (trades.length === 0) { console.log('No trades simulated'); return; }
  const wins = trades.filter(t => t.pnlPct > 0);
  const winRate = wins.length / trades.length * 100;
  const avgPnl = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const avgR   = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  console.log(`Trades:     ${trades.length}`);
  console.log(`Win rate:   ${winRate.toFixed(0)}% (${wins.length}/${trades.length})`);
  console.log(`Avg P&L:    ${avgPnl.toFixed(1)}%`);
  console.log(`Avg R:      ${avgR.toFixed(2)}`);
  console.log(`Sum P&L:    ${totalPnl.toFixed(1)}% (на $100/трейд = $${totalPnl.toFixed(0)} с ${trades.length} трейдов)`);
  console.log(`\nIndividual:`);
  for (const r of results) {
    if (r.trade) console.log(`  ${r.name.padEnd(10)}: ${r.trade.reason.padEnd(8)} ${r.trade.pnlPct >= 0 ? '+' : ''}${r.trade.pnlPct.toFixed(1)}%`);
    else console.log(`  ${r.name.padEnd(10)}: NO_TRADE (${r.n_swaps} swaps, spike=${r.spike != null ? 'yes' : 'no'})`);
  }
  console.log(`\n=== ВЕРДИКТ ===`);
  if (winRate >= 60 && avgR >= 0.8) console.log('✓ Стратегия имеет edge — стоит расширять выборку и строить live-систему');
  else if (winRate >= 40 || avgR >= 0.4) console.log('~ Edge неоднозначен — нужны более точные правила входа/выхода');
  else console.log('✗ Стратегия в текущем виде не работает — пересматриваем правила');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
