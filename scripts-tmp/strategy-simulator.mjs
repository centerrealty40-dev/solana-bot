// Strategy Simulator — ФАЗА 1 (на peak-данных)
//
// Прогоняет 10 стратегий выхода по closed trades в paper-trades.jsonl.
// Для каждой стратегии считает суммарный PnL, win rate, breakdown.
//
// Output: /opt/solana-alpha/data/strategies-leaderboard.json
//
// Запускается по cron каждые 5 минут (или вручную).
//
// Approximation: без timeline предполагаем peak случился ДО возможного SL/trail.
// → laddered TP на peak, потом trail (если armed), потом SL, потом exit.

import fs from 'fs';
import path from 'path';

const STORE_PATH = process.env.PAPER_TRADES_PATH || '/opt/solana-alpha/data/paper-trades.jsonl';
const OUT_PATH = process.env.LEADERBOARD_PATH || '/opt/solana-alpha/data/strategies-leaderboard.json';
const POSITION_USD = Number(process.env.POSITION_USD || 100);

// ====================================================================
// 10 стратегий-кандидатов
// ====================================================================
const STRATEGIES = [
  { id: 'S01', name: '50@x2 / 50@x10',           tp: [[2,0.5],[10,0.5]],                 trail: null,                  sl: -0.5 },
  { id: 'S02', name: '30@x2 / 30@x10 / 30@x100', tp: [[2,0.3],[10,0.3],[100,0.3]],       trail: null,                  sl: -0.5 },
  { id: 'S03', name: '50@x2 + trail',            tp: [[2,0.5]],                          trail: {trigger:2, drop:0.4}, sl: -0.5 },
  { id: 'S04', name: 'full @ x2',                tp: [[2,1.0]],                          trail: null,                  sl: -0.3 },
  { id: 'S05', name: 'full @ x3 + trail',        tp: [[3,1.0]],                          trail: {trigger:1.5,drop:0.4},sl: -0.3 },
  { id: 'S06', name: 'only trail (x1.5/-30%)',   tp: [],                                 trail: {trigger:1.5,drop:0.3},sl: -0.5 },
  { id: 'S07', name: 'degen moon (20@x2, trail)',tp: [[2,0.2]],                          trail: {trigger:5, drop:0.5}, sl: -0.6 },
  { id: 'S08', name: '50@x2 / 50@x5 (tight SL)', tp: [[2,0.5],[5,0.5]],                  trail: null,                  sl: -0.3 },
  { id: 'S09', name: 'no SL moon (30/30/40)',    tp: [[3,0.3],[10,0.3],[50,0.4]],        trail: null,                  sl: -0.9 },
  { id: 'S10', name: 'quick skim (50@1.5,50@3)', tp: [[1.5,0.5],[3,0.5]],                trail: {trigger:1.5,drop:0.3},sl: -0.3 },
];

// ====================================================================
// Симуляция одной сделки одной стратегией
// returns: { pnl: <fraction, e.g. 0.5 = +50%>, exitType: 'TP|TRAIL|SL|TIMEOUT' }
// ====================================================================
function simulateTrade(strategy, entry_mc, peak_mc, exit_mc) {
  const peak_x = peak_mc / entry_mc;
  const exit_x = exit_mc > 0 ? exit_mc / entry_mc : 0.01; // защита от 0 (NO_DATA)
  
  let position = 1.0;
  let realized = 0;
  let exitType = 'TIMEOUT';
  
  const ladders = [...strategy.tp].sort((a, b) => a[0] - b[0]);
  
  // 1. Laddered TPs — если peak дошёл до x, продаём pct по этой цене
  let anyLadderHit = false;
  for (const [x, pct] of ladders) {
    if (peak_x >= x && position > 0) {
      const sold = Math.min(pct, position);
      realized += sold * (x - 1);
      position -= sold;
      anyLadderHit = true;
      exitType = 'TP';
    }
  }
  
  // 2. Trail (если armed и упало с peak больше чем drop)
  if (strategy.trail && peak_x >= strategy.trail.trigger && position > 0) {
    const drop_from_peak = (peak_x - exit_x) / peak_x;
    if (drop_from_peak >= strategy.trail.drop) {
      const trail_x = peak_x * (1 - strategy.trail.drop);
      realized += position * (trail_x - 1);
      position = 0;
      exitType = 'TRAIL';
    }
  }
  
  // 3. SL (если ушли в минус и ladders/trail не сработали)
  if (position > 0 && exit_x <= 1 + strategy.sl) {
    realized += position * strategy.sl;
    position = 0;
    if (!anyLadderHit) exitType = 'SL';
  }
  
  // 4. Остаток продаём по exit_x (timeout/no-data)
  if (position > 0) {
    realized += position * (exit_x - 1);
    if (!anyLadderHit) exitType = 'TIMEOUT';
  }
  
  return { pnl: realized, exitType };
}

// ====================================================================
// Загрузка closed trades из paper-trades.jsonl
// ====================================================================
function loadClosedTrades() {
  if (!fs.existsSync(STORE_PATH)) return { trades: [], lastReset: null };
  
  const lines = fs.readFileSync(STORE_PATH, 'utf8').split('\n');
  const opens = new Map();
  const peaks = new Map(); // mint -> max peak_mc
  const closes = [];
  let lastReset = null;
  
  for (const ln of lines) {
    if (!ln) continue;
    if (ln.includes('"kind":"tick"')) continue; // пропускаем ticks (если есть)
    if (ln.includes('"kind":"eval"')) continue;
    let e;
    try { e = JSON.parse(ln); } catch { continue; }
    
    if (e.kind === 'reset') lastReset = e;
    else if (e.kind === 'open') opens.set(e.mint, e);
    else if (e.kind === 'peak') {
      const cur = peaks.get(e.mint) || 0;
      if (e.peakMcUsd > cur) peaks.set(e.mint, e.peakMcUsd);
    }
    else if (e.kind === 'close') {
      const o = opens.get(e.mint);
      if (!o) continue;
      const peakFromEvents = peaks.get(e.mint) || 0;
      const peakMc = Math.max(e.peakMcUsd || 0, peakFromEvents, o.peakMcUsd || 0);
      closes.push({
        mint: e.mint,
        symbol: e.symbol || o.symbol,
        entryTs: o.entryTs,
        exitTs: e.exitTs,
        entryMc: o.entryMcUsd,
        peakMc: peakMc || o.entryMcUsd,
        exitMc: e.exitMcUsd || 0,
        liveExit: e.exitReason,
        livePnlPct: e.pnlPct,
        durationMin: e.durationMin,
      });
    }
  }
  
  // фильтруем сделки только после reset (если есть)
  const sinceTs = lastReset ? lastReset.ts : 0;
  const filtered = closes.filter(c => c.exitTs >= sinceTs);
  
  return { trades: filtered, lastReset, totalAll: closes.length };
}

// ====================================================================
// MAIN
// ====================================================================
function quantile(arr, q) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

function main() {
  const { trades, lastReset, totalAll } = loadClosedTrades();
  console.log(`[loaded] ${trades.length} trades since reset (${totalAll} total)`);
  
  if (trades.length === 0) {
    fs.writeFileSync(OUT_PATH, JSON.stringify({
      updated_at: new Date().toISOString(),
      trades_analyzed: 0,
      since: lastReset ? new Date(lastReset.ts).toISOString() : null,
      message: 'No closed trades since reset yet. Wait for sa-paper to close some positions.',
      strategies: STRATEGIES.map(s => ({ id: s.id, name: s.name, config: s, trades: 0 })),
    }, null, 2));
    return;
  }
  
  const results = STRATEGIES.map(strategy => {
    const pnls = [];
    const exits = { TP: 0, TRAIL: 0, SL: 0, TIMEOUT: 0 };
    let wins = 0;
    let bestTrade = null, worstTrade = null;
    
    for (const t of trades) {
      const r = simulateTrade(strategy, t.entryMc, t.peakMc, t.exitMc);
      pnls.push(r.pnl);
      exits[r.exitType]++;
      if (r.pnl > 0) wins++;
      if (!bestTrade || r.pnl > bestTrade.pnl) bestTrade = { ...t, pnl: r.pnl, exitType: r.exitType };
      if (!worstTrade || r.pnl < worstTrade.pnl) worstTrade = { ...t, pnl: r.pnl, exitType: r.exitType };
    }
    
    const sum = pnls.reduce((s, p) => s + p, 0);
    const avg = sum / pnls.length;
    const totalUsd = sum * POSITION_USD; // PnL в долларах при $100/trade
    const sumUsdInvested = pnls.length * POSITION_USD;
    const roi_pct = sumUsdInvested > 0 ? (totalUsd / sumUsdInvested) * 100 : 0;
    
    return {
      id: strategy.id,
      name: strategy.name,
      config: strategy,
      trades: pnls.length,
      wins,
      win_rate_pct: +(wins / pnls.length * 100).toFixed(1),
      sum_pnl_usd: +totalUsd.toFixed(2),
      avg_pnl_pct: +(avg * 100).toFixed(1),
      median_pnl_pct: +(quantile(pnls, 0.5) * 100).toFixed(1),
      best_pnl_pct: +(Math.max(...pnls) * 100).toFixed(0),
      worst_pnl_pct: +(Math.min(...pnls) * 100).toFixed(0),
      roi_pct: +roi_pct.toFixed(1),
      exits,
      best_trade: bestTrade ? { symbol: bestTrade.symbol, mint: bestTrade.mint, pnl_pct: +(bestTrade.pnl * 100).toFixed(0), exit: bestTrade.exitType } : null,
    };
  });
  
  // sort by sum_pnl_usd DESC
  results.sort((a, b) => b.sum_pnl_usd - a.sum_pnl_usd);
  
  const out = {
    updated_at: new Date().toISOString(),
    trades_analyzed: trades.length,
    since: lastReset ? new Date(lastReset.ts).toISOString() : null,
    position_usd: POSITION_USD,
    note: 'Phase 1: simulation on (entry_mc, peak_mc, exit_mc) without full price timeline. SL/trail are approximations. Phase 2 (with ticks) will be more accurate.',
    strategies: results,
  };
  
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  
  // короткий summary в stdout
  console.log(`\n=== Strategy Leaderboard (${trades.length} trades) ===`);
  console.log(`${'rank'.padEnd(5)} ${'id'.padEnd(5)} ${'name'.padEnd(35)} ${'trades'.padStart(7)} ${'win%'.padStart(6)} ${'sum$'.padStart(10)} ${'avg%'.padStart(8)}`);
  results.forEach((s, i) => {
    const rank = String(i + 1).padEnd(5);
    const id = s.id.padEnd(5);
    const name = s.name.padEnd(35).slice(0, 35);
    const t = String(s.trades).padStart(7);
    const wr = s.win_rate_pct.toFixed(1).padStart(6);
    const sumStr = (s.sum_pnl_usd >= 0 ? '+' : '') + s.sum_pnl_usd.toFixed(2);
    const sum = sumStr.padStart(10);
    const avgStr = (s.avg_pnl_pct >= 0 ? '+' : '') + s.avg_pnl_pct.toFixed(1) + '%';
    const avg = avgStr.padStart(8);
    console.log(`${rank} ${id} ${name} ${t} ${wr} ${sum} ${avg}`);
  });
  console.log(`\n→ ${OUT_PATH}`);
}

main();
