import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const LOOKBACK_HOURS = Number(process.env.METEORA_BACKTEST_LOOKBACK_HOURS || 72);
const MIN_POINTS_PER_PAIR = Number(process.env.METEORA_BACKTEST_MIN_POINTS || 20);
const MIN_LIQUIDITY_USD = Number(process.env.METEORA_BACKTEST_MIN_LIQ_USD || 5_000);
const RUG_DROP_PCT = Number(process.env.METEORA_BACKTEST_RUG_DROP_PCT || 70); // drop from local peak in 60m
const RUNNER_MULTIPLIER = Number(process.env.METEORA_BACKTEST_RUNNER_MULTIPLIER || 3);
const REPORT_OUT_PATH = process.env.METEORA_BACKTEST_OUT || '/opt/solana-alpha/data/meteora-backtest-report.json';

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function toMs(hours) {
  return hours * 60 * 60 * 1000;
}

function calcPairMetrics(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const first = sorted[0];
  const firstTs = new Date(first.ts).getTime();
  const firstPrice = Number(first.price_usd);

  if (!(firstPrice > 0)) return null;
  if (sorted.length < MIN_POINTS_PER_PAIR) return null;
  if (Number(first.liquidity_usd ?? 0) < MIN_LIQUIDITY_USD) return null;

  const rugWindowEnd = firstTs + toMs(1);
  const runnerWindowEnd = firstTs + toMs(12);

  let maxPrice60m = firstPrice;
  let minPrice60m = firstPrice;
  let maxPrice12h = firstPrice;

  for (const row of sorted) {
    const ts = new Date(row.ts).getTime();
    const px = Number(row.price_usd);
    if (!(px > 0)) continue;
    if (ts <= rugWindowEnd) {
      if (px > maxPrice60m) maxPrice60m = px;
      if (px < minPrice60m) minPrice60m = px;
    }
    if (ts <= runnerWindowEnd && px > maxPrice12h) {
      maxPrice12h = px;
    }
  }

  const rugDropPct60m = maxPrice60m > 0 ? ((maxPrice60m - minPrice60m) / maxPrice60m) * 100 : 0;
  const runnerX12h = firstPrice > 0 ? maxPrice12h / firstPrice : 0;

  return {
    pair_address: first.pair_address,
    base_mint: first.base_mint,
    quote_mint: first.quote_mint,
    snapshots: sorted.length,
    first_ts: first.ts,
    last_ts: sorted[sorted.length - 1].ts,
    first_price_usd: firstPrice,
    first_liquidity_usd: Number(first.liquidity_usd ?? 0),
    rug_drop_pct_60m: Number(rugDropPct60m.toFixed(2)),
    runner_x_12h: Number(runnerX12h.toFixed(3)),
    rug_like: rugDropPct60m >= RUG_DROP_PCT,
    runner_like: runnerX12h >= RUNNER_MULTIPLIER,
  };
}

async function loadSnapshots() {
  const sql = `
    SELECT
      ts,
      pair_address,
      base_mint,
      quote_mint,
      price_usd,
      liquidity_usd
    FROM meteora_pair_snapshots
    WHERE ts >= now() - ($1::text || ' hours')::interval
      AND price_usd IS NOT NULL
    ORDER BY pair_address, ts
  `;
  const { rows } = await pool.query(sql, [String(LOOKBACK_HOURS)]);
  return rows;
}

function groupByPair(rows) {
  const byPair = new Map();
  for (const row of rows) {
    const pair = row.pair_address;
    if (!pair) continue;
    if (!byPair.has(pair)) byPair.set(pair, []);
    byPair.get(pair).push(row);
  }
  return byPair;
}

function printSummary(summary) {
  console.log('\n=== METEORA BACKTEST (METRICS ONLY) ===');
  console.log(`lookback_hours=${summary.lookback_hours}`);
  console.log(`candidate_count=${summary.candidate_count}`);
  console.log(`rug_like_drop_60m_count=${summary.rug_like_drop_60m_count}`);
  console.log(`runner_like_3x_12h_count=${summary.runner_like_3x_12h_count}`);
  console.log(`rug_rate_pct=${summary.rug_rate_pct.toFixed(2)}%`);
  console.log(`runner_rate_pct=${summary.runner_rate_pct.toFixed(2)}%`);
}

async function main() {
  const raw = await loadSnapshots();
  const byPair = groupByPair(raw);

  const pairMetrics = [];
  for (const rows of byPair.values()) {
    const m = calcPairMetrics(rows);
    if (m) pairMetrics.push(m);
  }

  const candidateCount = pairMetrics.length;
  const rugLike = pairMetrics.filter((m) => m.rug_like);
  const runnerLike = pairMetrics.filter((m) => m.runner_like);

  const summary = {
    generated_at: new Date().toISOString(),
    lookback_hours: LOOKBACK_HOURS,
    thresholds: {
      min_points_per_pair: MIN_POINTS_PER_PAIR,
      min_liquidity_usd: MIN_LIQUIDITY_USD,
      rug_drop_pct_60m: RUG_DROP_PCT,
      runner_multiplier_12h: RUNNER_MULTIPLIER,
    },
    candidate_count: candidateCount,
    rug_like_drop_60m_count: rugLike.length,
    runner_like_3x_12h_count: runnerLike.length,
    rug_rate_pct: candidateCount ? (rugLike.length / candidateCount) * 100 : 0,
    runner_rate_pct: candidateCount ? (runnerLike.length / candidateCount) * 100 : 0,
    top_rug_like_pairs: rugLike
      .sort((a, b) => b.rug_drop_pct_60m - a.rug_drop_pct_60m)
      .slice(0, 20),
    top_runner_like_pairs: runnerLike
      .sort((a, b) => b.runner_x_12h - a.runner_x_12h)
      .slice(0, 20),
  };

  const outDir = path.dirname(REPORT_OUT_PATH);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(REPORT_OUT_PATH, JSON.stringify(summary, null, 2));

  printSummary(summary);
  console.log(`report_path=${REPORT_OUT_PATH}`);
}

main()
  .catch((error) => {
    console.error(`[fatal] ${String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
