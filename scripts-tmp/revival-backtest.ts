/**
 * Backtest «Revival Sniper» strategy — v3
 *
 * v1 проблема: Helius events.swap ловит ~5% сделок (мы получали 756 swaps вместо тысяч)
 * v2 проблема: Helius на pool-адресах даёт другую структуру → парсер ловил 0 swaps из 16k txs
 *
 * v3 решение: используем GeckoTerminal публичный API
 *   - даёт готовые минутные OHLCV свечи для любого pool на Solana
 *   - без auth, без парсинга raw транзакций
 *   - ~43 запроса = 30 дней истории токена
 *
 * Метод стратегии без изменений:
 *   - Spike: 1h vol >= 5x baseline AND price change >= +20%
 *   - Entry: T+5min на VWAP минуты
 *   - Exit: TP +50% / SL -20% / timeout 60min
 */

import 'dotenv/config';

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

const TP             = 1.5;
const SL             = 0.8;
const TIMEOUT_MIN    = 60;
const ENTRY_DELAY_MIN = 5;
const SPIKE_VOL_X    = 5;
const SPIKE_PRICE_PCT = 20;
const BASELINE_DAYS  = 7;
const MIN_BASELINE_HOURS = 4;

interface Candle { ts: number; open: number; high: number; low: number; close: number; volUsd: number; }
interface Trade {
  entryTs: number; entryPrice: number;
  exitTs: number;  exitPrice: number;
  reason: 'TP' | 'SL' | 'TIMEOUT';
  pnlPct: number;  rMultiple: number;
}

interface DexPair {
  pairAddress: string;
  baseToken: { address: string };
  quoteToken: { address: string };
  liquidity?: { usd?: number };
}

async function findBestPool(mint: string): Promise<{ pool: string; liq: number } | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${mint}`);
    const j = await r.json() as any;
    const pairs: DexPair[] = (j.pairs ?? []).filter((p: any) =>
      p.chainId === 'solana' &&
      (p.baseToken?.address === mint || p.quoteToken?.address === mint)
    );
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (!pairs.length) return null;
    return { pool: pairs[0].pairAddress, liq: pairs[0].liquidity?.usd ?? 0 };
  } catch (e) { return null; }
}

async function fetchOhlcvPage(pool: string, beforeTsSec?: number): Promise<Candle[]> {
  const u = new URL(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute`);
  u.searchParams.set('aggregate', '1');
  u.searchParams.set('limit', '1000');
  if (beforeTsSec) u.searchParams.set('before_timestamp', String(beforeTsSec));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
      if (r.status === 429) { await new Promise(res => setTimeout(res, 2500)); continue; }
      if (!r.ok) {
        if (attempt === 2) console.error(`gecko ${pool.slice(0,8)} → ${r.status}: ${(await r.text()).slice(0,200)}`);
        await new Promise(res => setTimeout(res, 800));
        continue;
      }
      const j = await r.json() as any;
      const list: any[] = j?.data?.attributes?.ohlcv_list ?? [];
      return list.map(([ts, open, high, low, close, volUsd]) => ({
        ts, open, high, low, close, volUsd,
      }));
    } catch (e) { await new Promise(res => setTimeout(res, 800)); }
  }
  return [];
}

async function fetchAllCandles(pool: string, fromTsSec: number, toTsSec: number): Promise<Candle[]> {
  const all = new Map<number, Candle>();
  let beforeTs: number | undefined = toTsSec + 60;
  for (let page = 0; page < 60; page++) {
    const candles = await fetchOhlcvPage(pool, beforeTs);
    if (!candles.length) break;
    let oldestSeen = Number.MAX_SAFE_INTEGER;
    for (const c of candles) {
      if (c.ts > toTsSec) continue;
      if (c.ts < fromTsSec) continue;
      all.set(c.ts, c);
      oldestSeen = Math.min(oldestSeen, c.ts);
    }
    const minOfPage = Math.min(...candles.map(c => c.ts));
    process.stderr.write(`    page ${page+1}, got ${candles.length} candles (oldest in window: ${new Date(oldestSeen * 1000).toISOString()}, page minTs: ${new Date(minOfPage * 1000).toISOString()})\n`);
    if (minOfPage <= fromTsSec) break;
    beforeTs = minOfPage;
    if (candles.length < 1000) break;
    await new Promise(res => setTimeout(res, 600)); // rate limit safety
  }
  return [...all.values()].sort((a, b) => a.ts - b.ts);
}

function fillGaps(candles: Candle[]): Candle[] {
  if (!candles.length) return [];
  const result: Candle[] = [];
  let prev = candles[0];
  result.push(prev);
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    while (result[result.length - 1].ts + 60 < cur.ts) {
      const last = result[result.length - 1];
      result.push({ ts: last.ts + 60, open: last.close, high: last.close, low: last.close, close: last.close, volUsd: 0 });
    }
    result.push(cur);
    prev = cur;
  }
  return result;
}

function findSpike(candles: Candle[]): number {
  for (let i = 60; i < candles.length; i++) {
    const w = candles.slice(i - 60, i);
    const vol1h = w.reduce((s, c) => s + c.volUsd, 0);
    if (vol1h <= 0) continue;
    const priceStart = w[0].open || w[0].close;
    const priceEnd   = w[w.length - 1].close;
    if (priceStart <= 0) continue;
    const priceChangePct = ((priceEnd - priceStart) / priceStart) * 100;

    const baselineEnd = i - 60;
    const baselineStart = Math.max(0, baselineEnd - 60 * 24 * BASELINE_DAYS);
    const baseline = candles.slice(baselineStart, baselineEnd);
    if (baseline.length < MIN_BASELINE_HOURS * 60) continue;
    const baselineHourlyVol = baseline.reduce((s, c) => s + c.volUsd, 0) / (baseline.length / 60);

    let volX: number;
    if (baselineHourlyVol === 0) {
      if (vol1h < 500) continue;
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
    if (candles[j].volUsd > 0 || candles[j].close > 0) {
      entryIdx = j;
      entryPrice = (candles[j].open + candles[j].close) / 2;
      break;
    }
  }
  if (entryIdx < 0) return undefined;
  const tpPx = entryPrice * TP;
  const slPx = entryPrice * SL;
  for (let j = entryIdx + 1; j < Math.min(entryIdx + 1 + TIMEOUT_MIN, candles.length); j++) {
    const c = candles[j];
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
  const exitPrice = candles[lastIdx].close;
  const pnl = ((exitPrice - entryPrice) / entryPrice) * 100;
  return { entryTs: candles[entryIdx].ts, entryPrice, exitTs: candles[lastIdx].ts, exitPrice, reason: 'TIMEOUT', pnlPct: pnl, rMultiple: pnl / 20 };
}

async function main() {
  const results: { name: string; trade?: Trade; spike?: number; n_candles: number; pool?: string }[] = [];

  for (const tok of TOKENS) {
    console.log(`\n=== ${tok.name} ===`);
    console.log(`mint: ${tok.mint}`);
    const revivalSec = Math.floor(new Date(tok.revivalDateIso).getTime() / 1000);
    const fromSec = revivalSec - tok.windowDaysBefore * 24 * 3600;
    const toSec   = revivalSec + tok.windowDaysAfter * 24 * 3600;
    console.log(`Window: ${new Date(fromSec * 1000).toISOString()} → ${new Date(toSec * 1000).toISOString()}`);

    const pool = await findBestPool(tok.mint);
    if (!pool) { console.log(`No pool found, skip`); results.push({ name: tok.name, n_candles: 0 }); continue; }
    console.log(`Pool: ${pool.pool}  liq=$${pool.liq.toFixed(0)}`);

    process.stderr.write(`  Fetching OHLCV...\n`);
    let candles = await fetchAllCandles(pool.pool, fromSec, toSec);
    console.log(`Candles raw: ${candles.length}`);
    if (candles.length < 100) {
      console.log(`Too few candles, skip`);
      results.push({ name: tok.name, n_candles: candles.length, pool: pool.pool });
      continue;
    }
    candles = fillGaps(candles);
    console.log(`Candles filled: ${candles.length}  (${(candles.length / 60 / 24).toFixed(1)} days)`);
    console.log(`Range: ${new Date(candles[0].ts * 1000).toISOString()} → ${new Date(candles[candles.length-1].ts * 1000).toISOString()}`);

    const spikeIdx = findSpike(candles);
    if (spikeIdx < 0) {
      console.log(`No spike: vol >= ${SPIKE_VOL_X}x baseline AND price >= +${SPIKE_PRICE_PCT}% in 1h`);
      results.push({ name: tok.name, n_candles: candles.length, pool: pool.pool });
      continue;
    }
    const spikeTs = candles[spikeIdx].ts;
    console.log(`Spike: ${new Date(spikeTs * 1000).toISOString()} (candle #${spikeIdx})`);

    const trade = simulate(candles, spikeIdx);
    if (!trade) { console.log(`No trade simulated`); results.push({ name: tok.name, spike: spikeIdx, n_candles: candles.length, pool: pool.pool }); continue; }
    console.log(`Entry: ${new Date(trade.entryTs * 1000).toISOString()} @ $${trade.entryPrice.toExponential(3)}`);
    console.log(`Exit:  ${new Date(trade.exitTs  * 1000).toISOString()} @ $${trade.exitPrice .toExponential(3)} (${trade.reason})`);
    console.log(`P&L: ${trade.pnlPct.toFixed(1)}%   R: ${trade.rMultiple.toFixed(2)}`);
    results.push({ name: tok.name, trade, spike: spikeIdx, n_candles: candles.length, pool: pool.pool });
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
    else console.log(`  ${r.name.padEnd(10)}: NO_TRADE (candles=${r.n_candles}, spike=${r.spike != null ? 'yes' : 'no'})`);
  }
  console.log(`\n=== ВЕРДИКТ ===`);
  if (winRate >= 60 && avgR >= 0.8) console.log('✓ Стратегия имеет edge — стоит расширять выборку и строить live-систему');
  else if (winRate >= 40 || avgR >= 0.4) console.log('~ Edge неоднозначен — нужны более точные правила входа/выхода');
  else console.log('✗ Стратегия в текущем виде не работает — пересматриваем правила');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
