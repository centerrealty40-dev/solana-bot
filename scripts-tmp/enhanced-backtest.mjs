// Enhanced Backtest:
//   1. 15 стратегий (S01-S15) на исторических данных DB
//   2. Math grid-search — перебор ~5K комбинаций TP/SL/trail для оптимума
//
// Output: /opt/solana-alpha/data/enhanced-backtest.json + console table

import pg from 'pg';
import fs from 'fs';
import 'dotenv/config';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const POSITION_USD = Number(process.env.POSITION_USD || 100);
const SOL_USD = Number(process.env.SOL_USD || 85);
const MIN_AGE_HOURS = Number(process.env.MIN_AGE_HOURS || 12);
const OUT_PATH = '/opt/solana-alpha/data/enhanced-backtest.json';

const FILTERS = { MIN_UNIQUE_BUYERS: 15, MIN_BUY_SOL: 3, MIN_BUY_SELL_RATIO: 1.0, MAX_TOP_BUYER_SHARE: 0.50 };

// ====================================================================
// 15 named strategies
// ====================================================================
function build_S11() {
  // 33%@x3, потом 10% каждые +10%: x3.3, x3.6, x4.0...
  const tp = [[3.0, 0.33]];
  let mul = 3.0;
  for (let i = 0; i < 6; i++) { mul *= 1.10; tp.push([+mul.toFixed(2), 0.10]); }
  return tp;
}
function build_S12() {
  // 50%@x2, потом 10% каждые +25%: x2.5, x3.13, x3.91...
  const tp = [[2.0, 0.50]];
  let mul = 2.0;
  for (let i = 0; i < 5; i++) { mul *= 1.25; tp.push([+mul.toFixed(2), 0.10]); }
  return tp;
}
const STRATEGIES = [
  { id: 'S01', name: '50@x2 / 50@x10',           tp: [[2,0.5],[10,0.5]],          trail: null,                 sl: -0.5 },
  { id: 'S02', name: '30@x2 / 30@x10 / 30@x100', tp: [[2,0.3],[10,0.3],[100,0.3]],trail: null,                 sl: -0.5 },
  { id: 'S03', name: '50@x2 + trail',            tp: [[2,0.5]],                   trail: {trigger:2,drop:0.4}, sl: -0.5 },
  { id: 'S04', name: 'full @ x2',                tp: [[2,1.0]],                   trail: null,                 sl: -0.3 },
  { id: 'S05', name: 'full @ x3 + trail',        tp: [[3,1.0]],                   trail: {trigger:1.5,drop:0.4},sl: -0.3 },
  { id: 'S06', name: 'only trail (1.5/-30%)',    tp: [],                          trail: {trigger:1.5,drop:0.3},sl: -0.5 },
  { id: 'S07', name: 'degen moon (20@x2,trail)', tp: [[2,0.2]],                   trail: {trigger:5,drop:0.5}, sl: -0.6 },
  { id: 'S08', name: '50@x2 / 50@x5 (tightSL)',  tp: [[2,0.5],[5,0.5]],           trail: null,                 sl: -0.3 },
  { id: 'S09', name: 'no SL moon (30/30/40)',    tp: [[3,0.3],[10,0.3],[50,0.4]], trail: null,                 sl: -0.9 },
  { id: 'S10', name: 'quick skim (50@1.5,50@3)', tp: [[1.5,0.5],[3,0.5]],         trail: {trigger:1.5,drop:0.3},sl: -0.3 },
  // НОВЫЕ — house money / fibonacci / geometric
  { id: 'S11', name: 'body@x3 + 10/+10%',        tp: build_S11(),                 trail: null,                 sl: -0.3 },
  { id: 'S12', name: 'body@x2 + 10/+25%',        tp: build_S12(),                 trail: null,                 sl: -0.3 },
  { id: 'S13', name: 'body@x3 + moon trail',     tp: [[3,0.33]],                  trail: {trigger:5,drop:0.3}, sl: -0.3 },
  { id: 'S14', name: 'fibonacci 20% x2/3/5/8/13',tp: [[2,0.2],[3,0.2],[5,0.2],[8,0.2],[13,0.2]], trail: null,  sl: -0.3 },
  { id: 'S15', name: 'geometric 25% x2/4/8/16',  tp: [[2,0.25],[4,0.25],[8,0.25],[16,0.25]],     trail: null,  sl: -0.3 },
];

// ====================================================================
// simulator (общий для backtest и grid-search)
// ====================================================================
function simulateTrade(strategy, entry_mc, peak_mc, exit_mc) {
  const peak_x = peak_mc / entry_mc;
  const exit_x = exit_mc > 0 ? exit_mc / entry_mc : 0.01;
  let position = 1.0, realized = 0, exitType = 'TIMEOUT', anyLadder = false;
  for (const [x, pct] of [...strategy.tp].sort((a, b) => a[0] - b[0])) {
    if (peak_x >= x && position > 0) {
      const sold = Math.min(pct, position);
      realized += sold * (x - 1); position -= sold; anyLadder = true; exitType = 'TP';
    }
  }
  if (strategy.trail && peak_x >= strategy.trail.trigger && position > 0) {
    if ((peak_x - exit_x) / peak_x >= strategy.trail.drop) {
      realized += position * (peak_x * (1 - strategy.trail.drop) - 1); position = 0; exitType = 'TRAIL';
    }
  }
  if (position > 0 && exit_x <= 1 + strategy.sl) {
    realized += position * strategy.sl; position = 0; if (!anyLadder) exitType = 'SL';
  }
  if (position > 0) {
    realized += position * (exit_x - 1); if (!anyLadder) exitType = 'TIMEOUT';
  }
  return { pnl: realized, exitType };
}

function evalStrategy(strategy, rows) {
  const exits = { TP: 0, TRAIL: 0, SL: 0, TIMEOUT: 0 }; let wins = 0; const pnls = [];
  for (const r of rows) {
    const sim = simulateTrade(strategy, Number(r.entry_mc), Number(r.peak_mc), Number(r.exit_mc));
    pnls.push(sim.pnl); exits[sim.exitType]++; if (sim.pnl > 0) wins++;
  }
  const sum = pnls.reduce((s, p) => s + p, 0);
  const avg = sum / pnls.length;
  return {
    trades: pnls.length, wins,
    win_rate_pct: +(wins / pnls.length * 100).toFixed(1),
    sum_pnl_usd: +(sum * POSITION_USD).toFixed(2),
    avg_pnl_pct: +(avg * 100).toFixed(2),
    best_pnl_pct: +(Math.max(...pnls) * 100).toFixed(0),
    worst_pnl_pct: +(Math.min(...pnls) * 100).toFixed(0),
    exits,
  };
}

// ====================================================================
// MAIN
// ====================================================================
async function main() {
  console.log('[init] fetching virtual entries from DB...');
  const sql = `
    WITH launches AS (
      SELECT base_mint, MIN(block_time) AS launch_ts FROM swaps
      WHERE source = 'pumpportal' AND base_mint NOT LIKE 'So111%' AND price_usd > 0 AND price_usd < 1000
      GROUP BY base_mint HAVING MIN(block_time) < NOW() - INTERVAL '${MIN_AGE_HOURS} hours'
    ),
    window_buys AS (
      SELECT l.base_mint, l.launch_ts, COUNT(DISTINCT s.wallet) AS unique_buyers,
             SUM(s.amount_usd) / $1 AS buy_sol,
             MAX(per_w.amt_sol) / NULLIF(SUM(per_w.amt_sol), 0) AS top_buyer_share
      FROM launches l
      JOIN swaps s ON s.base_mint = l.base_mint
        AND s.block_time BETWEEN l.launch_ts + interval '2 minutes' AND l.launch_ts + interval '7 minutes'
        AND s.side = 'buy'
      JOIN LATERAL (
        SELECT s2.wallet, SUM(s2.amount_usd) / $1 AS amt_sol FROM swaps s2
        WHERE s2.base_mint = l.base_mint
          AND s2.block_time BETWEEN l.launch_ts + interval '2 minutes' AND l.launch_ts + interval '7 minutes'
          AND s2.side = 'buy' GROUP BY s2.wallet
      ) per_w ON per_w.wallet = s.wallet
      GROUP BY l.base_mint, l.launch_ts
    ),
    window_sells AS (
      SELECT l.base_mint, COALESCE(SUM(s.amount_usd) / $1, 0) AS sell_sol FROM launches l
      LEFT JOIN swaps s ON s.base_mint = l.base_mint
        AND s.block_time BETWEEN l.launch_ts + interval '2 minutes' AND l.launch_ts + interval '7 minutes'
        AND s.side = 'sell'
      GROUP BY l.base_mint
    ),
    candidates AS (
      SELECT b.base_mint, b.launch_ts, b.unique_buyers, b.buy_sol,
             COALESCE(s.sell_sol, 0) AS sell_sol, b.top_buyer_share
      FROM window_buys b LEFT JOIN window_sells s ON s.base_mint = b.base_mint
      WHERE b.unique_buyers >= $2 AND b.buy_sol >= $3
        AND b.buy_sol >= COALESCE(s.sell_sol, 0) * $4 AND b.top_buyer_share <= $5
    ),
    entries AS (
      SELECT c.*,
        (SELECT price_usd * 1e9 FROM swaps WHERE base_mint = c.base_mint
         AND block_time <= c.launch_ts + interval '7 minutes' AND price_usd > 0
         ORDER BY block_time DESC LIMIT 1) AS entry_mc
      FROM candidates c
    ),
    finals AS (
      SELECT e.*,
        (SELECT MAX(price_usd) * 1e9 FROM swaps WHERE base_mint = e.base_mint
         AND block_time > e.launch_ts + interval '7 minutes'
         AND block_time <= e.launch_ts + interval '12 hours' AND price_usd > 0) AS peak_mc,
        (SELECT price_usd * 1e9 FROM swaps WHERE base_mint = e.base_mint
         AND block_time <= e.launch_ts + interval '12 hours' AND price_usd > 0
         ORDER BY block_time DESC LIMIT 1) AS exit_mc
      FROM entries e WHERE e.entry_mc > 0
    )
    SELECT * FROM finals WHERE peak_mc IS NOT NULL AND exit_mc IS NOT NULL ORDER BY launch_ts;
  `;
  const t0 = Date.now();
  const { rows } = await pool.query(sql, [SOL_USD, FILTERS.MIN_UNIQUE_BUYERS, FILTERS.MIN_BUY_SOL, FILTERS.MIN_BUY_SELL_RATIO, FILTERS.MAX_TOP_BUYER_SHARE]);
  console.log(`[sql] ${rows.length} virtual entries in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  if (!rows.length) { console.log('No data'); await pool.end(); return; }

  // 1. NAMED STRATEGIES
  const named = STRATEGIES.map(s => ({ ...s, ...evalStrategy(s, rows) }));
  named.sort((a, b) => b.sum_pnl_usd - a.sum_pnl_usd);

  console.log(`=== NAMED STRATEGIES (${rows.length} trades) ===`);
  console.log(`${'rk'.padEnd(3)} ${'id'.padEnd(5)} ${'name'.padEnd(36)} ${'win%'.padStart(6)} ${'sum$'.padStart(9)} ${'avg%'.padStart(8)} ${'TP/TR/SL/TO'}`);
  named.forEach((s, i) => {
    const sumStr = (s.sum_pnl_usd>=0?'+':'') + s.sum_pnl_usd.toFixed(0);
    const avgStr = (s.avg_pnl_pct>=0?'+':'') + s.avg_pnl_pct.toFixed(1) + '%';
    console.log(`${String(i+1).padEnd(3)} ${s.id.padEnd(5)} ${s.name.padEnd(36).slice(0,36)} ${s.win_rate_pct.toFixed(1).padStart(6)} ${sumStr.padStart(9)} ${avgStr.padStart(8)}  ${s.exits.TP}/${s.exits.TRAIL}/${s.exits.SL}/${s.exits.TIMEOUT}`);
  });

  // 2. GRID-SEARCH — перебор TP1/TP2/SL/trail комбинаций
  console.log(`\n=== GRID-SEARCH (math optimization) ===`);
  const grid = [];
  const TP1_X = [1.5, 2.0, 2.5, 3.0];
  const TP1_PCT = [0.25, 0.33, 0.50, 0.67, 1.0];
  const TP2_X = [3.0, 5.0, 8.0, 13.0, 0]; // 0 = нет TP2
  const TP2_PCT = [0.25, 0.50, 1.0];
  const SL = [-0.2, -0.3, -0.4, -0.5];
  const TRAIL_TRIG = [0, 1.5, 2.0, 3.0]; // 0 = нет trail
  const TRAIL_DROP = [0.3, 0.4];

  let count = 0;
  for (const tp1x of TP1_X) for (const tp1p of TP1_PCT) {
    for (const tp2x of TP2_X) for (const tp2p of TP2_PCT) {
      if (tp2x > 0 && tp2x <= tp1x) continue; // TP2 должен быть выше TP1
      if (tp2x === 0 && tp2p !== TP2_PCT[0]) continue; // skip duplicates когда нет TP2
      if (tp1p + (tp2x > 0 ? tp2p : 0) > 1.001) continue; // суммарный sell > 100%
      for (const sl of SL) for (const trig of TRAIL_TRIG) for (const drop of TRAIL_DROP) {
        if (trig === 0 && drop !== TRAIL_DROP[0]) continue;
        const tp = [[tp1x, tp1p]];
        if (tp2x > 0) tp.push([tp2x, tp2p]);
        const trail = trig > 0 ? { trigger: trig, drop } : null;
        const cfg = { tp, trail, sl };
        const ev = evalStrategy(cfg, rows);
        grid.push({ ...cfg, ...ev });
        count++;
      }
    }
  }
  console.log(`evaluated ${count} combinations`);

  grid.sort((a, b) => b.sum_pnl_usd - a.sum_pnl_usd);
  const top20 = grid.slice(0, 20);

  console.log(`\n=== TOP-20 GRID-SEARCH WINNERS ===`);
  console.log(`${'rk'.padEnd(3)} ${'TP1'.padEnd(11)} ${'TP2'.padEnd(11)} ${'SL'.padStart(5)} ${'trail'.padEnd(11)} ${'win%'.padStart(6)} ${'sum$'.padStart(9)} ${'avg%'.padStart(8)}`);
  top20.forEach((g, i) => {
    const tp1 = `${g.tp[0][0]}x@${(g.tp[0][1]*100).toFixed(0)}%`.padEnd(11);
    const tp2 = g.tp[1] ? `${g.tp[1][0]}x@${(g.tp[1][1]*100).toFixed(0)}%`.padEnd(11) : '—'.padEnd(11);
    const slStr = (g.sl*100).toFixed(0) + '%';
    const tr = g.trail ? `${g.trail.trigger}x/-${g.trail.drop*100}%`.padEnd(11) : '—'.padEnd(11);
    const sumStr = (g.sum_pnl_usd>=0?'+':'') + g.sum_pnl_usd.toFixed(0);
    const avgStr = (g.avg_pnl_pct>=0?'+':'') + g.avg_pnl_pct.toFixed(1)+'%';
    console.log(`${String(i+1).padEnd(3)} ${tp1} ${tp2} ${slStr.padStart(5)} ${tr} ${g.win_rate_pct.toFixed(1).padStart(6)} ${sumStr.padStart(9)} ${avgStr.padStart(8)}`);
  });

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    trades: rows.length,
    filters: FILTERS,
    named: named,
    grid_search: { evaluated: count, top20 },
    optimal: top20[0],
  }, null, 2));
  console.log(`\n→ ${OUT_PATH}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
