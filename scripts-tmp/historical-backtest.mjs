// Historical Backtest — прогон 10 стратегий по накопленным данным в DB
//
// Источник: таблица swaps (PumpPortal WS, ~3.9M записей за 3 дня)
// Логика:
//   1. Найти все pump.fun launches за период
//   2. Посчитать метрики decision-window (2-7 мин после launch)
//   3. Применить V13 фильтры → виртуальные entries
//   4. Для каждого: entry_mc / peak_mc / exit_mc после 12h
//   5. Прогнать 10 стратегий → leaderboard
//
// Output: /opt/solana-alpha/data/historical-backtest.json

import pg from 'pg';
import fs from 'fs';
import 'dotenv/config';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const POSITION_USD = Number(process.env.POSITION_USD || 100);
const SOL_USD = Number(process.env.SOL_USD || 85);
const MIN_AGE_HOURS = Number(process.env.MIN_AGE_HOURS || 12); // launches минимум 12h назад чтобы был exit
const OUT_PATH = process.env.OUT_PATH || '/opt/solana-alpha/data/historical-backtest.json';

// V13 фильтры (синхронизировать с live-paper-trader.ts)
const FILTERS = {
  MIN_UNIQUE_BUYERS: 15,
  MIN_BUY_SOL: 3,
  MIN_BUY_SELL_RATIO: 1.0,
  MAX_TOP_BUYER_SHARE: 0.50,
};

// Те же 10 стратегий что и в strategy-simulator.mjs
const STRATEGIES = [
  { id: 'S01', name: '50@x2 / 50@x10',           tp: [[2,0.5],[10,0.5]],                 trail: null,                  sl: -0.5 },
  { id: 'S02', name: '30@x2 / 30@x10 / 30@x100', tp: [[2,0.3],[10,0.3],[100,0.3]],       trail: null,                  sl: -0.5 },
  { id: 'S03', name: '50@x2 + trail',            tp: [[2,0.5]],                          trail: {trigger:2, drop:0.4}, sl: -0.5 },
  { id: 'S04', name: 'full @ x2',                tp: [[2,1.0]],                          trail: null,                  sl: -0.3 },
  { id: 'S05', name: 'full @ x3 + trail',        tp: [[3,1.0]],                          trail: {trigger:1.5,drop:0.4},sl: -0.3 },
  { id: 'S06', name: 'only trail (x1.5/-30%)',   tp: [],                                 trail: {trigger:1.5,drop:0.3},sl: -0.5 },
  { id: 'S07', name: 'degen moon (20@x2,trail)', tp: [[2,0.2]],                          trail: {trigger:5, drop:0.5}, sl: -0.6 },
  { id: 'S08', name: '50@x2 / 50@x5 (tightSL)',  tp: [[2,0.5],[5,0.5]],                  trail: null,                  sl: -0.3 },
  { id: 'S09', name: 'no SL moon (30/30/40)',    tp: [[3,0.3],[10,0.3],[50,0.4]],        trail: null,                  sl: -0.9 },
  { id: 'S10', name: 'quick skim (50@1.5,50@3)', tp: [[1.5,0.5],[3,0.5]],                trail: {trigger:1.5,drop:0.3},sl: -0.3 },
];

function simulateTrade(strategy, entry_mc, peak_mc, exit_mc) {
  const peak_x = peak_mc / entry_mc;
  const exit_x = exit_mc > 0 ? exit_mc / entry_mc : 0.01;
  let position = 1.0;
  let realized = 0;
  let exitType = 'TIMEOUT';
  let anyLadderHit = false;

  const ladders = [...strategy.tp].sort((a, b) => a[0] - b[0]);
  for (const [x, pct] of ladders) {
    if (peak_x >= x && position > 0) {
      const sold = Math.min(pct, position);
      realized += sold * (x - 1);
      position -= sold;
      anyLadderHit = true;
      exitType = 'TP';
    }
  }
  if (strategy.trail && peak_x >= strategy.trail.trigger && position > 0) {
    const drop = (peak_x - exit_x) / peak_x;
    if (drop >= strategy.trail.drop) {
      const trail_x = peak_x * (1 - strategy.trail.drop);
      realized += position * (trail_x - 1);
      position = 0;
      exitType = 'TRAIL';
    }
  }
  if (position > 0 && exit_x <= 1 + strategy.sl) {
    realized += position * strategy.sl;
    position = 0;
    if (!anyLadderHit) exitType = 'SL';
  }
  if (position > 0) {
    realized += position * (exit_x - 1);
    if (!anyLadderHit) exitType = 'TIMEOUT';
  }
  return { pnl: realized, exitType };
}

async function main() {
  console.log('[init] DB connected, fetching launches...');

  // Шаг 1: launches + decision-window метрики (одним SQL)
  const sql = `
    WITH launches AS (
      SELECT base_mint, MIN(block_time) AS launch_ts
      FROM swaps
      WHERE source = 'pumpportal'
        AND base_mint NOT LIKE 'So111%'
        AND price_usd > 0 AND price_usd < 1000
      GROUP BY base_mint
      HAVING MIN(block_time) < NOW() - INTERVAL '${MIN_AGE_HOURS} hours'
    ),
    -- метрики окна 2-7 мин после launch
    window_buys AS (
      SELECT
        l.base_mint, l.launch_ts,
        COUNT(DISTINCT s.wallet) AS unique_buyers,
        SUM(s.amount_usd) / $1 AS buy_sol,
        MAX(per_wallet.amt_sol) / NULLIF(SUM(per_wallet.amt_sol), 0) AS top_buyer_share
      FROM launches l
      JOIN swaps s ON s.base_mint = l.base_mint
        AND s.block_time BETWEEN l.launch_ts + interval '2 minutes'
                             AND l.launch_ts + interval '7 minutes'
        AND s.side = 'buy'
      JOIN LATERAL (
        SELECT s2.wallet, SUM(s2.amount_usd) / $1 AS amt_sol
        FROM swaps s2
        WHERE s2.base_mint = l.base_mint
          AND s2.block_time BETWEEN l.launch_ts + interval '2 minutes'
                                AND l.launch_ts + interval '7 minutes'
          AND s2.side = 'buy'
        GROUP BY s2.wallet
      ) per_wallet ON per_wallet.wallet = s.wallet
      GROUP BY l.base_mint, l.launch_ts
    ),
    window_sells AS (
      SELECT
        l.base_mint,
        COALESCE(SUM(s.amount_usd) / $1, 0) AS sell_sol
      FROM launches l
      LEFT JOIN swaps s ON s.base_mint = l.base_mint
        AND s.block_time BETWEEN l.launch_ts + interval '2 minutes'
                             AND l.launch_ts + interval '7 minutes'
        AND s.side = 'sell'
      GROUP BY l.base_mint
    ),
    candidates AS (
      SELECT b.base_mint, b.launch_ts, b.unique_buyers, b.buy_sol,
             COALESCE(s.sell_sol, 0) AS sell_sol, b.top_buyer_share
      FROM window_buys b
      LEFT JOIN window_sells s ON s.base_mint = b.base_mint
      WHERE b.unique_buyers >= $2
        AND b.buy_sol >= $3
        AND b.buy_sol >= COALESCE(s.sell_sol, 0) * $4
        AND b.top_buyer_share <= $5
    ),
    -- entry_mc: цена в конце decision window (7 мин)
    entries AS (
      SELECT c.*,
        (SELECT price_usd * 1e9 FROM swaps
         WHERE base_mint = c.base_mint
           AND block_time <= c.launch_ts + interval '7 minutes'
           AND price_usd > 0
         ORDER BY block_time DESC LIMIT 1) AS entry_mc
      FROM candidates c
    ),
    -- peak_mc и exit_mc после entry
    finals AS (
      SELECT e.*,
        (SELECT MAX(price_usd) * 1e9 FROM swaps
         WHERE base_mint = e.base_mint
           AND block_time > e.launch_ts + interval '7 minutes'
           AND block_time <= e.launch_ts + interval '12 hours'
           AND price_usd > 0) AS peak_mc,
        (SELECT price_usd * 1e9 FROM swaps
         WHERE base_mint = e.base_mint
           AND block_time <= e.launch_ts + interval '12 hours'
           AND price_usd > 0
         ORDER BY block_time DESC LIMIT 1) AS exit_mc
      FROM entries e
      WHERE e.entry_mc > 0
    )
    SELECT * FROM finals
    WHERE peak_mc IS NOT NULL AND exit_mc IS NOT NULL
    ORDER BY launch_ts;
  `;

  const t0 = Date.now();
  const { rows } = await pool.query(sql, [
    SOL_USD,
    FILTERS.MIN_UNIQUE_BUYERS,
    FILTERS.MIN_BUY_SOL,
    FILTERS.MIN_BUY_SELL_RATIO,
    FILTERS.MAX_TOP_BUYER_SHARE,
  ]);
  console.log(`[sql] ${rows.length} virtual entries (V13 passed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (rows.length === 0) {
    console.log('Нет данных. Возможно фильтры слишком строгие или launches слишком свежие.');
    await pool.end();
    return;
  }

  // statistics о peaks
  const peakDist = { '<1.5x':0, '1.5-2x':0, '2-5x':0, '5-10x':0, '10-50x':0, '>50x':0 };
  for (const r of rows) {
    const x = r.peak_mc / r.entry_mc;
    if (x < 1.5) peakDist['<1.5x']++;
    else if (x < 2) peakDist['1.5-2x']++;
    else if (x < 5) peakDist['2-5x']++;
    else if (x < 10) peakDist['5-10x']++;
    else if (x < 50) peakDist['10-50x']++;
    else peakDist['>50x']++;
  }
  console.log('[peaks] distribution:', peakDist);

  // Шаг 2: симуляция 10 стратегий
  const results = STRATEGIES.map(strategy => {
    const pnls = [];
    const exits = { TP: 0, TRAIL: 0, SL: 0, TIMEOUT: 0 };
    let wins = 0;
    let bestTrade = null, worstTrade = null;
    for (const r of rows) {
      const sim = simulateTrade(strategy, Number(r.entry_mc), Number(r.peak_mc), Number(r.exit_mc));
      pnls.push(sim.pnl);
      exits[sim.exitType]++;
      if (sim.pnl > 0) wins++;
      if (!bestTrade || sim.pnl > bestTrade.pnl) bestTrade = { mint: r.base_mint, peak_x: (r.peak_mc/r.entry_mc).toFixed(1), pnl: sim.pnl, exitType: sim.exitType };
      if (!worstTrade || sim.pnl < worstTrade.pnl) worstTrade = { mint: r.base_mint, peak_x: (r.peak_mc/r.entry_mc).toFixed(1), pnl: sim.pnl, exitType: sim.exitType };
    }
    const sum = pnls.reduce((s, p) => s + p, 0);
    const avg = sum / pnls.length;
    const sumUsd = sum * POSITION_USD;
    const invested = pnls.length * POSITION_USD;
    const roi_pct = invested > 0 ? (sumUsd / invested) * 100 : 0;
    return {
      id: strategy.id,
      name: strategy.name,
      config: strategy,
      trades: pnls.length,
      wins,
      win_rate_pct: +(wins / pnls.length * 100).toFixed(1),
      sum_pnl_usd: +sumUsd.toFixed(2),
      avg_pnl_pct: +(avg * 100).toFixed(1),
      best_pnl_pct: +(Math.max(...pnls) * 100).toFixed(0),
      worst_pnl_pct: +(Math.min(...pnls) * 100).toFixed(0),
      roi_pct: +roi_pct.toFixed(1),
      exits,
      best_trade: bestTrade && { mint: bestTrade.mint.slice(0,8), peak_x: bestTrade.peak_x, pnl_pct: +(bestTrade.pnl*100).toFixed(0), exit: bestTrade.exitType },
    };
  });
  results.sort((a, b) => b.sum_pnl_usd - a.sum_pnl_usd);

  const out = {
    generated_at: new Date().toISOString(),
    source: 'historical backtest (DB swaps, pumpportal source)',
    period: { trades: rows.length, oldest: rows[0]?.launch_ts, newest: rows[rows.length-1]?.launch_ts },
    filters: FILTERS,
    position_usd: POSITION_USD,
    sol_usd: SOL_USD,
    peak_distribution: peakDist,
    strategies: results,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  console.log(`\n=== HISTORICAL BACKTEST LEADERBOARD (${rows.length} trades) ===`);
  console.log(`${'rk'.padEnd(3)} ${'id'.padEnd(5)} ${'name'.padEnd(33)} ${'win%'.padStart(6)} ${'sum$'.padStart(10)} ${'avg%'.padStart(8)} ${'best%'.padStart(8)} ${'worst%'.padStart(8)} ${'TP/TR/SL/TO'}`);
  results.forEach((s, i) => {
    const rk = String(i+1).padEnd(3);
    const id = s.id.padEnd(5);
    const name = s.name.padEnd(33).slice(0,33);
    const wr = s.win_rate_pct.toFixed(1).padStart(6);
    const sumStr = (s.sum_pnl_usd>=0?'+':'') + s.sum_pnl_usd.toFixed(0);
    const sum = sumStr.padStart(10);
    const avgStr = (s.avg_pnl_pct>=0?'+':'') + s.avg_pnl_pct.toFixed(1) + '%';
    const avg = avgStr.padStart(8);
    const best = ('+' + s.best_pnl_pct + '%').padStart(8);
    const worst = (s.worst_pnl_pct + '%').padStart(8);
    const ex = `${s.exits.TP}/${s.exits.TRAIL}/${s.exits.SL}/${s.exits.TIMEOUT}`;
    console.log(`${rk} ${id} ${name} ${wr} ${sum} ${avg} ${best} ${worst}  ${ex}`);
  });
  console.log(`\n→ ${OUT_PATH}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
