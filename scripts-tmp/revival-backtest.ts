/**
 * Backtest «Revival Sniper» strategy
 *
 * Гипотеза: старый токен (>30d) который внезапно пробуждается
 * с большим объёмом, можно купить на T+5min от volume-spike
 * и закрыть с TP +50% / SL -20% / timeout 60min с положительным EV.
 *
 * Метод:
 *   1. Качаем все swaps через Helius enhanced
 *   2. Восстанавливаем 1-minute candles (vwap, hi/lo, vol)
 *   3. Скользящим окном ищем 1h где: vol >= SPIKE_VOL_X × baseline_hourly_vol(7d)
 *      AND price_change >= SPIKE_PRICE_PCT
 *   4. Заходим на T+ENTRY_DELAY_MIN
 *   5. Симулируем выход по TP/SL/timeout на VWAP минутных свеч
 */

import 'dotenv/config';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing'); process.exit(1); }

const TOKENS = [
  { name: 'TOKABU',   mint: 'H8xQ6poBjB9DTPMDTKWzWPrnxu4bDEhybxiouF8Ppump' },
  { name: 'JONATHAN', mint: 'EJmkht54g9zKws1C2qAVvjdhwKSy9suhdBsSDU6egcrL' },
  { name: 'PUMPCADE', mint: 'Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu' },
];

const MAX_PAGES = 200;            // up to 20k txs per token
const TP             = 1.5;        // +50%
const SL             = 0.8;        // -20%
const TIMEOUT_MIN    = 60;
const ENTRY_DELAY_MIN = 5;
const SPIKE_VOL_X    = 5;
const SPIKE_PRICE_PCT = 20;
const BASELINE_DAYS  = 7;
const MIN_BASELINE_HOURS = 4;     // need at least some baseline to compute X

interface Swap { ts: number; price: number; volSol: number; side: 'buy' | 'sell'; }
interface Candle { ts: number; vwap: number; high: number; low: number; volSol: number; count: number; }
interface Trade {
  entryTs: number; entryPrice: number;
  exitTs: number;  exitPrice: number;
  reason: 'TP' | 'SL' | 'TIMEOUT';
  pnlPct: number;  rMultiple: number;
}

function getTokenDecAmount(t: any): number {
  if (!t) return 0;
  if (t.rawTokenAmount?.tokenAmount && t.rawTokenAmount.decimals != null) {
    return Number(t.rawTokenAmount.tokenAmount) / Math.pow(10, t.rawTokenAmount.decimals);
  }
  if (typeof t.tokenAmount === 'number') return t.tokenAmount;
  if (typeof t.tokenAmount === 'string') return Number(t.tokenAmount);
  return 0;
}

async function fetchHist(addr: string, before?: string): Promise<any[]> {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY!);
  u.searchParams.set('limit', '100');
  if (before) u.searchParams.set('before', before);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u.toString());
      if (r.status === 429) { await new Promise(res => setTimeout(res, 1500)); continue; }
      if (!r.ok) return [];
      return await r.json() as any[];
    } catch { await new Promise(res => setTimeout(res, 500)); }
  }
  return [];
}

async function fetchAllSwaps(mint: string): Promise<Swap[]> {
  const swaps: Swap[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < MAX_PAGES; p++) {
    const txs = await fetchHist(mint, cursor);
    if (!txs.length) break;
    for (const tx of txs) {
      const s = tx.events?.swap;
      if (!s) continue;
      const out = s.tokenOutputs?.find((t: any) => t.mint === mint);
      const inp = s.tokenInputs?.find((t: any) => t.mint === mint);
      const nIn  = s.nativeInput?.amount ? Number(s.nativeInput.amount) / 1e9 : 0;
      const nOut = s.nativeOutput?.amount ? Number(s.nativeOutput.amount) / 1e9 : 0;
      let side: 'buy' | 'sell' | undefined;
      let solAmt = 0; let tokAmt = 0;
      if (out && nIn > 0) { side = 'buy'; solAmt = nIn; tokAmt = getTokenDecAmount(out); }
      else if (inp && nOut > 0) { side = 'sell'; solAmt = nOut; tokAmt = getTokenDecAmount(inp); }
      if (!side || solAmt <= 0 || tokAmt <= 0) continue;
      swaps.push({ ts: tx.timestamp, price: solAmt / tokAmt, volSol: solAmt, side });
    }
    cursor = txs[txs.length - 1].signature;
    if (p % 10 === 9) process.stderr.write(`page ${p+1}/${MAX_PAGES}, swaps=${swaps.length}\n`);
    if (txs.length < 100) break;
  }
  swaps.sort((a, b) => a.ts - b.ts);
  return swaps;
}

function bucketize(swaps: Swap[]): Candle[] {
  if (!swaps.length) return [];
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
  const results: { name: string; trade?: Trade; spike?: number; n_swaps: number; n_candles: number; spike_ts?: number }[] = [];
  for (const tok of TOKENS) {
    console.log(`\n=== ${tok.name} ===`);
    console.log(`mint: ${tok.mint}`);
    process.stderr.write(`Fetching swaps...\n`);
    const swaps = await fetchAllSwaps(tok.mint);
    console.log(`Swaps total: ${swaps.length}`);
    if (swaps.length < 50) {
      console.log(`Too few swaps for analysis`);
      results.push({ name: tok.name, n_swaps: swaps.length, n_candles: 0 });
      continue;
    }
    const candles = bucketize(swaps);
    console.log(`Candles: ${candles.length} (${(candles.length / 60 / 24).toFixed(1)} days coverage)`);
    console.log(`Range: ${new Date(candles[0].ts * 1000).toISOString()} → ${new Date(candles[candles.length-1].ts * 1000).toISOString()}`);

    const spikeIdx = findSpike(candles);
    if (spikeIdx < 0) {
      console.log(`No spike matching vol≥${SPIKE_VOL_X}x AND price≥+${SPIKE_PRICE_PCT}% in 1h`);
      results.push({ name: tok.name, n_swaps: swaps.length, n_candles: candles.length });
      continue;
    }
    const spikeTs = candles[spikeIdx].ts;
    console.log(`Spike detected at: ${new Date(spikeTs * 1000).toISOString()} (candle #${spikeIdx})`);

    const trade = simulate(candles, spikeIdx);
    if (!trade) {
      console.log(`Could not simulate (no liquidity post-spike)`);
      results.push({ name: tok.name, spike: spikeIdx, spike_ts: spikeTs, n_swaps: swaps.length, n_candles: candles.length });
      continue;
    }
    console.log(`Entry: ${new Date(trade.entryTs * 1000).toISOString()} @ ${trade.entryPrice.toExponential(3)} SOL/token`);
    console.log(`Exit:  ${new Date(trade.exitTs  * 1000).toISOString()} @ ${trade.exitPrice .toExponential(3)} (${trade.reason})`);
    console.log(`P&L: ${trade.pnlPct.toFixed(1)}%   R: ${trade.rMultiple.toFixed(2)}`);
    results.push({ name: tok.name, trade, spike: spikeIdx, spike_ts: spikeTs, n_swaps: swaps.length, n_candles: candles.length });
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
