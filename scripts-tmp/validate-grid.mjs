// Validate Grid-Search Winner — проверка устойчивости к overfit
//
// 3 теста:
//   1. Time-split (70/30) — train на старых данных, test на новых
//   2. Bootstrap (100 random samples) — как часто всплывает один winner
//   3. Top-10 stability — топ-10 train на train vs test
//
// Conclusion: deployer-ready / не доверять

import pg from 'pg';
import 'dotenv/config';
import fs from 'fs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const POSITION_USD = 100;
const SOL_USD = 85;
const FILTERS = { MIN_UNIQUE_BUYERS: 15, MIN_BUY_SOL: 3, MIN_BUY_SELL_RATIO: 1.0, MAX_TOP_BUYER_SHARE: 0.50 };
const MIN_AGE_HOURS = 12;
const BOOTSTRAP_RUNS = 100;
const OUT_PATH = '/opt/solana-alpha/data/validate-grid.json';

// ====================================================================
// simulator (тот же что в enhanced-backtest)
// ====================================================================
function simulateTrade(strategy, entry_mc, peak_mc, exit_mc) {
  const peak_x = peak_mc / entry_mc;
  const exit_x = exit_mc > 0 ? exit_mc / entry_mc : 0.01;
  let position = 1.0, realized = 0, anyLadder = false;
  for (const [x, pct] of [...strategy.tp].sort((a, b) => a[0] - b[0])) {
    if (peak_x >= x && position > 0) {
      const sold = Math.min(pct, position); realized += sold * (x - 1); position -= sold; anyLadder = true;
    }
  }
  if (strategy.trail && peak_x >= strategy.trail.trigger && position > 0) {
    if ((peak_x - exit_x) / peak_x >= strategy.trail.drop) {
      realized += position * (peak_x * (1 - strategy.trail.drop) - 1); position = 0;
    }
  }
  if (position > 0 && exit_x <= 1 + strategy.sl) { realized += position * strategy.sl; position = 0; }
  if (position > 0) realized += position * (exit_x - 1);
  return realized;
}

function evalStrategy(strategy, rows) {
  let sum = 0, wins = 0;
  for (const r of rows) {
    const pnl = simulateTrade(strategy, Number(r.entry_mc), Number(r.peak_mc), Number(r.exit_mc));
    sum += pnl; if (pnl > 0) wins++;
  }
  return {
    sum_pnl_usd: +(sum * POSITION_USD).toFixed(2),
    avg_pnl_pct: +(sum / rows.length * 100).toFixed(2),
    win_rate_pct: +(wins / rows.length * 100).toFixed(1),
    trades: rows.length,
  };
}

function generateGrid() {
  const grid = [];
  const TP1_X = [1.5, 2.0, 2.5, 3.0];
  const TP1_PCT = [0.25, 0.33, 0.50, 0.67, 1.0];
  const TP2_X = [3.0, 5.0, 8.0, 13.0, 0];
  const TP2_PCT = [0.25, 0.50, 1.0];
  const SL = [-0.2, -0.3, -0.4, -0.5];
  const TRAIL_TRIG = [0, 1.5, 2.0, 3.0];
  const TRAIL_DROP = [0.3, 0.4];

  for (const tp1x of TP1_X) for (const tp1p of TP1_PCT) {
    for (const tp2x of TP2_X) for (const tp2p of TP2_PCT) {
      if (tp2x > 0 && tp2x <= tp1x) continue;
      if (tp2x === 0 && tp2p !== TP2_PCT[0]) continue;
      if (tp1p + (tp2x > 0 ? tp2p : 0) > 1.001) continue;
      for (const sl of SL) for (const trig of TRAIL_TRIG) for (const drop of TRAIL_DROP) {
        if (trig === 0 && drop !== TRAIL_DROP[0]) continue;
        const tp = [[tp1x, tp1p]];
        if (tp2x > 0) tp.push([tp2x, tp2p]);
        const trail = trig > 0 ? { trigger: trig, drop } : null;
        grid.push({ tp, trail, sl });
      }
    }
  }
  return grid;
}

function serializeStrategy(s) {
  const tp = s.tp.map(([x, p]) => `${x}@${(p*100).toFixed(0)}%`).join('+');
  const tr = s.trail ? `T${s.trail.trigger}/${(s.trail.drop*100).toFixed(0)}` : '—';
  return `${tp}|SL${(s.sl*100).toFixed(0)}|${tr}`;
}

function findWinner(grid, rows) {
  let best = null;
  for (const s of grid) {
    const ev = evalStrategy(s, rows);
    if (!best || ev.sum_pnl_usd > best.sum_pnl_usd) best = { ...s, ...ev };
  }
  return best;
}

// ====================================================================
// load data — переиспользуем тот же SQL
// ====================================================================
async function loadRows() {
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
  const { rows } = await pool.query(sql, [SOL_USD, FILTERS.MIN_UNIQUE_BUYERS, FILTERS.MIN_BUY_SOL, FILTERS.MIN_BUY_SELL_RATIO, FILTERS.MAX_TOP_BUYER_SHARE]);
  return rows;
}

// ====================================================================
// MAIN
// ====================================================================
async function main() {
  console.log('[init] loading data...');
  const t0 = Date.now();
  const rows = await loadRows();
  console.log(`[loaded] ${rows.length} trades in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  if (rows.length < 50) { console.log('Слишком мало trades для validation'); await pool.end(); return; }

  const grid = generateGrid();
  console.log(`[grid] ${grid.length} combinations\n`);

  // ============================================================
  // TEST 1: Time-split (70/30)
  // ============================================================
  console.log('=== TEST 1: TIME-SPLIT 70/30 ===');
  const splitIdx = Math.floor(rows.length * 0.7);
  const train = rows.slice(0, splitIdx);
  const test = rows.slice(splitIdx);
  console.log(`train: ${train.length} (oldest), test: ${test.length} (newest)\n`);

  const trainResults = grid.map(s => ({ ...s, ...evalStrategy(s, train) }));
  trainResults.sort((a, b) => b.sum_pnl_usd - a.sum_pnl_usd);
  const trainWinner = trainResults[0];
  const testOnTrainWinner = evalStrategy(trainWinner, test);

  console.log(`TRAIN winner: ${serializeStrategy(trainWinner)}`);
  console.log(`  on TRAIN (${train.length} trades): +$${trainWinner.sum_pnl_usd} (avg ${trainWinner.avg_pnl_pct >= 0 ? '+' : ''}${trainWinner.avg_pnl_pct}%, win ${trainWinner.win_rate_pct}%)`);
  console.log(`  on TEST  (${test.length} trades): ${testOnTrainWinner.sum_pnl_usd >= 0 ? '+' : ''}$${testOnTrainWinner.sum_pnl_usd} (avg ${testOnTrainWinner.avg_pnl_pct >= 0 ? '+' : ''}${testOnTrainWinner.avg_pnl_pct}%, win ${testOnTrainWinner.win_rate_pct}%)`);

  const trainAvg = trainWinner.avg_pnl_pct;
  const testAvg = testOnTrainWinner.avg_pnl_pct;
  const overfitRatio = trainAvg > 0 ? testAvg / trainAvg : 0;
  console.log(`overfit-ratio: ${overfitRatio.toFixed(2)} (${overfitRatio > 0.7 ? 'GOOD' : overfitRatio > 0.3 ? 'WARN' : 'BAD'})`);

  // ============================================================
  // TEST 2: Top-10 stability
  // ============================================================
  console.log(`\n=== TEST 2: TOP-10 TRAIN → TEST ===`);
  const top10 = trainResults.slice(0, 10);
  console.log(`${'rk'.padEnd(3)} ${'config'.padEnd(40)} ${'train$'.padStart(8)} ${'test$'.padStart(8)} ${'ratio'.padStart(7)}`);
  let stableCount = 0;
  for (let i = 0; i < top10.length; i++) {
    const t = top10[i];
    const testEv = evalStrategy(t, test);
    const ratio = t.avg_pnl_pct > 0 ? testEv.avg_pnl_pct / t.avg_pnl_pct : 0;
    if (testEv.sum_pnl_usd > 0) stableCount++;
    const ts = (t.sum_pnl_usd >= 0 ? '+' : '') + t.sum_pnl_usd.toFixed(0);
    const es = (testEv.sum_pnl_usd >= 0 ? '+' : '') + testEv.sum_pnl_usd.toFixed(0);
    console.log(`${String(i+1).padEnd(3)} ${serializeStrategy(t).padEnd(40).slice(0,40)} ${ts.padStart(8)} ${es.padStart(8)} ${ratio.toFixed(2).padStart(7)}`);
  }
  console.log(`profitable on test: ${stableCount}/10`);

  // ============================================================
  // TEST 3: Bootstrap (100 random samples с возвратом)
  // ============================================================
  console.log(`\n=== TEST 3: BOOTSTRAP (${BOOTSTRAP_RUNS} samples) ===`);
  const winnerCounts = {};
  for (let i = 0; i < BOOTSTRAP_RUNS; i++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(Math.random() * rows.length)]);
    const w = findWinner(grid, sample);
    const key = serializeStrategy(w);
    winnerCounts[key] = (winnerCounts[key] || 0) + 1;
    if ((i + 1) % 20 === 0) process.stdout.write(`  [${i+1}/${BOOTSTRAP_RUNS}]\n`);
  }
  const sortedBoot = Object.entries(winnerCounts).sort((a, b) => b[1] - a[1]);
  console.log('\nTop-10 bootstrap winners:');
  console.log(`${'rk'.padEnd(3)} ${'config'.padEnd(40)} ${'count'.padStart(7)} ${'%'.padStart(6)}`);
  sortedBoot.slice(0, 10).forEach(([k, v], i) => {
    console.log(`${String(i+1).padEnd(3)} ${k.padEnd(40).slice(0,40)} ${String(v).padStart(7)} ${(v/BOOTSTRAP_RUNS*100).toFixed(0).padStart(5)}%`);
  });

  const topBootstrapShare = sortedBoot[0][1] / BOOTSTRAP_RUNS;

  // ============================================================
  // CONCLUSIONS
  // ============================================================
  console.log(`\n=== CONCLUSIONS ===`);
  const conclusions = [];
  if (overfitRatio >= 0.7) conclusions.push(`✓ Time-split: устойчив (test/train ratio = ${overfitRatio.toFixed(2)})`);
  else if (overfitRatio >= 0.3) conclusions.push(`⚠ Time-split: WARN (ratio ${overfitRatio.toFixed(2)}; работа есть, но overfit risk)`);
  else conclusions.push(`✗ Time-split: BAD (ratio ${overfitRatio.toFixed(2)}; явный overfit на train)`);

  if (stableCount >= 8) conclusions.push(`✓ Top-10 stability: ${stableCount}/10 прибыльны на test`);
  else if (stableCount >= 5) conclusions.push(`⚠ Top-10 stability: ${stableCount}/10 — средне`);
  else conclusions.push(`✗ Top-10 stability: только ${stableCount}/10 прибыльны на test`);

  if (topBootstrapShare >= 0.3) conclusions.push(`✓ Bootstrap: top winner появляется в ${(topBootstrapShare*100).toFixed(0)}% sample (стабильно)`);
  else if (topBootstrapShare >= 0.1) conclusions.push(`⚠ Bootstrap: top winner в ${(topBootstrapShare*100).toFixed(0)}% sample (средне)`);
  else conclusions.push(`✗ Bootstrap: top winner всего в ${(topBootstrapShare*100).toFixed(0)}% sample (рандом-эффект)`);

  conclusions.forEach(c => console.log(c));

  const passed = conclusions.filter(c => c.startsWith('✓')).length;
  console.log(`\n→ ${passed}/3 тестов пройдено.`);
  if (passed === 3) console.log('  🟢 ВЕРДИКТ: можно деплоить (winner устойчив)');
  else if (passed === 2) console.log('  🟡 ВЕРДИКТ: осторожно (1 тест провален; деплоить можно но мониторить)');
  else console.log('  🔴 ВЕРДИКТ: НЕ ДЕПЛОИТЬ (overfit; нужна большая выборка)');

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    total_trades: rows.length,
    train_test_split: { train: train.length, test: test.length },
    train_winner: { config: serializeStrategy(trainWinner), train: trainWinner, test: testOnTrainWinner, overfit_ratio: overfitRatio },
    top10_stability: { profitable_on_test: stableCount, of: 10 },
    bootstrap: { runs: BOOTSTRAP_RUNS, top: sortedBoot.slice(0, 10).map(([k, v]) => ({ config: k, count: v, pct: +(v/BOOTSTRAP_RUNS*100).toFixed(1) })) },
    conclusions,
    verdict: passed === 3 ? 'DEPLOY' : passed === 2 ? 'CAREFUL_DEPLOY' : 'DO_NOT_DEPLOY',
  }, null, 2));
  console.log(`\n→ ${OUT_PATH}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
