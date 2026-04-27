import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const LOOKBACK_HOURS = Number(process.env.ORCA_BACKTEST_LOOKBACK_HOURS || 72);
const MIN_POINTS_PER_PAIR = Number(process.env.ORCA_BACKTEST_MIN_POINTS || 20);
const MIN_LIQUIDITY_USD = Number(process.env.ORCA_BACKTEST_MIN_LIQ_USD || 5_000);
const ENTRY_DELAY_MIN = Number(process.env.ORCA_ENTRY_DELAY_MIN || 10);
const RUG_DROP_PCT = Number(process.env.ORCA_RUG_DROP_PCT || 50);
const REPORT_OUT_PATH = process.env.ORCA_BACKTEST_OUT || '/opt/solana-alpha/data/orca-backtest-report.json';
const RPC_FEATURES = ['holders', 'largest_accounts', 'authorities', 'tx_burst'];

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function toMs(hours) {
  return hours * 60 * 60 * 1000;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractAuthorityCandidates(authoritiesData) {
  const out = new Set();
  if (!authoritiesData || typeof authoritiesData !== 'object') return out;

  const flattened = JSON.stringify(authoritiesData).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
  for (const addr of flattened) out.add(addr);
  return out;
}

function calcPairMetrics(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (sorted.length < MIN_POINTS_PER_PAIR) return null;

  const first = sorted[0];
  const firstTs = new Date(first.ts).getTime();
  const firstLiq = Number(first.liquidity_usd ?? 0);
  if (!(firstLiq >= MIN_LIQUIDITY_USD)) return null;

  const entryTs = firstTs + ENTRY_DELAY_MIN * 60_000;
  const entryRow = sorted.find((row) => new Date(row.ts).getTime() >= entryTs);
  const entryPrice = safeNumber(entryRow?.price_usd);
  if (!(entryPrice > 0)) return null;

  const rugWindowEnd = entryTs + toMs(1);
  const runnerWindowEnd = entryTs + toMs(12);

  let minPrice60m = entryPrice;
  let maxPrice12h = entryPrice;

  for (const row of sorted) {
    const ts = new Date(row.ts).getTime();
    const px = safeNumber(row.price_usd);
    if (!(px > 0)) continue;
    if (ts >= entryTs && ts <= rugWindowEnd && px < minPrice60m) {
      minPrice60m = px;
    }
    if (ts >= entryTs && ts <= runnerWindowEnd && px > maxPrice12h) {
      maxPrice12h = px;
    }
  }

  const rugDropPct60m = ((minPrice60m / entryPrice) - 1) * 100;
  const runnerX12h = maxPrice12h / entryPrice;

  return {
    pair_address: first.pair_address,
    base_mint: first.base_mint,
    quote_mint: first.quote_mint,
    snapshots: sorted.length,
    first_ts: first.ts,
    launch_ts: first.launch_ts,
    last_ts: sorted[sorted.length - 1].ts,
    entry_ts: entryRow.ts,
    entry_price_usd: entryPrice,
    first_liquidity_usd: firstLiq,
    rug_drop_pct_60m: Number(rugDropPct60m.toFixed(2)),
    runner_x_12h: Number(runnerX12h.toFixed(3)),
    rug_like_60m: rugDropPct60m <= -RUG_DROP_PCT,
    runner_like_3x_12h: runnerX12h >= 3,
    runner_like_5x_12h: runnerX12h >= 5,
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
      liquidity_usd,
      launch_ts
    FROM orca_pair_snapshots
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
    const key = row.pair_address;
    if (!key) continue;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(row);
  }
  return byPair;
}

async function loadLatestRpcFeatures(mints) {
  if (mints.length === 0) return new Map();
  const sql = `
    WITH ranked AS (
      SELECT
        mint,
        feature_type,
        data,
        feature_ts,
        ROW_NUMBER() OVER (
          PARTITION BY mint, feature_type
          ORDER BY feature_ts DESC
        ) AS rn
      FROM rpc_features
      WHERE mint = ANY($1)
        AND feature_type = ANY($2)
    )
    SELECT mint, feature_type, data, feature_ts
    FROM ranked
    WHERE rn = 1
  `;
  const { rows } = await pool.query(sql, [mints, RPC_FEATURES]);
  const byMint = new Map();
  for (const row of rows) {
    if (!byMint.has(row.mint)) byMint.set(row.mint, {});
    byMint.get(row.mint)[row.feature_type] = {
      data: row.data,
      feature_ts: row.feature_ts,
    };
  }
  return byMint;
}

async function loadDenylistWallets() {
  const tableExistsSql = `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'rug_wallet_denylist'
    ) AS exists
  `;
  const tableExists = await pool.query(tableExistsSql);
  if (!tableExists.rows[0]?.exists) return new Set();

  const colsSql = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'rug_wallet_denylist'
    ORDER BY ordinal_position
  `;
  const { rows: cols } = await pool.query(colsSql);
  const preferred = ['wallet', 'wallet_address', 'address', 'owner', 'pubkey'];
  const selected = preferred.find((c) => cols.some((x) => x.column_name === c)) ?? cols[0]?.column_name;
  if (!selected) return new Set();

  const walletsSql = `SELECT ${selected} AS wallet FROM rug_wallet_denylist`;
  const { rows } = await pool.query(walletsSql);
  return new Set(rows.map((r) => String(r.wallet ?? '').trim()).filter(Boolean));
}

function printSummary(summary) {
  console.log('\n=== ORCA BACKTEST (SCAFFOLD, NO TRADING) ===');
  console.log(`lookback_hours=${summary.lookback_hours}`);
  console.log(`candidate_count=${summary.candidate_count}`);
  console.log(`rug_like_rate_60m_pct=${summary.rug_like_rate_60m_pct.toFixed(2)}%`);
  console.log(`runner_like_rate_12h_3x_pct=${summary.runner_like_rate_12h_3x_pct.toFixed(2)}%`);
  console.log(`runner_like_rate_12h_5x_pct=${summary.runner_like_rate_12h_5x_pct.toFixed(2)}%`);
  console.log(`denylist_overlap_candidates=${summary.denylist_overlap_candidates}`);
  console.log(`rpc_feature_coverage_pct=${summary.rpc_feature_coverage_pct.toFixed(2)}%`);
}

async function main() {
  const raw = await loadSnapshots();
  const byPair = groupByPair(raw);

  const pairMetrics = [];
  for (const rows of byPair.values()) {
    const metric = calcPairMetrics(rows);
    if (metric) pairMetrics.push(metric);
  }

  const uniqueMints = [...new Set(pairMetrics.map((m) => m.base_mint))];
  const featureMap = await loadLatestRpcFeatures(uniqueMints);
  const denylistWallets = await loadDenylistWallets();

  for (const metric of pairMetrics) {
    const features = featureMap.get(metric.base_mint) ?? {};
    metric.rpc_features = features;
    metric.rpc_feature_count = Object.keys(features).length;
    metric.rpc_feature_coverage = RPC_FEATURES.reduce((acc, f) => {
      acc[f] = Boolean(features[f]);
      return acc;
    }, {});

    const authorityCandidates = extractAuthorityCandidates(features.authorities?.data);
    const overlap = [...authorityCandidates].filter((addr) => denylistWallets.has(addr));
    metric.denylist_wallet_overlap = overlap;
    metric.has_denylist_overlap = overlap.length > 0;
  }

  const candidateCount = pairMetrics.length;
  const rugLike = pairMetrics.filter((m) => m.rug_like_60m);
  const runner3x = pairMetrics.filter((m) => m.runner_like_3x_12h);
  const runner5x = pairMetrics.filter((m) => m.runner_like_5x_12h);
  const denyOverlap = pairMetrics.filter((m) => m.has_denylist_overlap);
  const rpcCovered = pairMetrics.filter((m) => m.rpc_feature_count > 0);
  const rpcFullCoverage = pairMetrics.filter((m) => m.rpc_feature_count === RPC_FEATURES.length);

  const summary = {
    generated_at: new Date().toISOString(),
    lookback_hours: LOOKBACK_HOURS,
    thresholds: {
      min_points_per_pair: MIN_POINTS_PER_PAIR,
      min_liquidity_usd: MIN_LIQUIDITY_USD,
      entry_delay_min: ENTRY_DELAY_MIN,
      rug_like_drop_threshold_pct: -RUG_DROP_PCT,
      runner_like_12h_thresholds: ['>=3x', '>=5x'],
    },
    candidate_count: candidateCount,
    rug_like_count_60m: rugLike.length,
    rug_like_rate_60m_pct: candidateCount ? (rugLike.length / candidateCount) * 100 : 0,
    runner_like_count_12h_3x: runner3x.length,
    runner_like_count_12h_5x: runner5x.length,
    runner_like_rate_12h_3x_pct: candidateCount ? (runner3x.length / candidateCount) * 100 : 0,
    runner_like_rate_12h_5x_pct: candidateCount ? (runner5x.length / candidateCount) * 100 : 0,
    denylist_overlap_candidates: denyOverlap.length,
    denylist_overlap_rate_pct: candidateCount ? (denyOverlap.length / candidateCount) * 100 : 0,
    rpc_feature_covered_candidates: rpcCovered.length,
    rpc_feature_full_coverage_candidates: rpcFullCoverage.length,
    rpc_feature_coverage_pct: candidateCount ? (rpcCovered.length / candidateCount) * 100 : 0,
    rpc_feature_full_coverage_pct: candidateCount ? (rpcFullCoverage.length / candidateCount) * 100 : 0,
    top_rug_like_pairs: rugLike
      .sort((a, b) => a.rug_drop_pct_60m - b.rug_drop_pct_60m)
      .slice(0, 20),
    top_runner_like_3x_pairs: runner3x
      .sort((a, b) => b.runner_x_12h - a.runner_x_12h)
      .slice(0, 20),
    top_runner_like_5x_pairs: runner5x
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
