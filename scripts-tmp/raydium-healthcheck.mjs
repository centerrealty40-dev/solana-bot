import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const STALE_MAX_MIN = Number(process.env.RAYDIUM_HEALTH_MAX_STALE_MIN || 5);
const MIN_ROWS_LAST_10M = Number(process.env.RAYDIUM_HEALTH_MIN_ROWS_10M || 10);
const MIN_DISTINCT_PAIRS_10M = Number(process.env.RAYDIUM_HEALTH_MIN_PAIRS_10M || 3);

if (!process.env.DATABASE_URL) {
  console.error('[health] DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function fail(msg, meta = {}) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    component: 'raydium-healthcheck',
    msg,
    ...meta,
  }));
  process.exitCode = 1;
}

function ok(msg, meta = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    component: 'raydium-healthcheck',
    msg,
    ...meta,
  }));
}

async function main() {
  const sql = `
    WITH latest AS (
      SELECT MAX(ts) AS max_ts
      FROM raydium_pair_snapshots
    ),
    tenm AS (
      SELECT
        COUNT(*) AS rows_10m,
        COUNT(DISTINCT pair_address) AS pairs_10m
      FROM raydium_pair_snapshots
      WHERE ts >= now() - interval '10 minutes'
    )
    SELECT
      l.max_ts,
      EXTRACT(EPOCH FROM (now() - l.max_ts)) / 60.0 AS stale_min,
      t.rows_10m,
      t.pairs_10m
    FROM latest l
    CROSS JOIN tenm t
  `;

  const { rows } = await pool.query(sql);
  const row = rows[0] || {};
  const staleMin = Number(row.stale_min ?? Number.POSITIVE_INFINITY);
  const rows10m = Number(row.rows_10m ?? 0);
  const pairs10m = Number(row.pairs_10m ?? 0);

  let healthy = true;
  if (!row.max_ts) {
    healthy = false;
    fail('no snapshots found');
  }
  if (staleMin > STALE_MAX_MIN) {
    healthy = false;
    fail('stale data detected', { staleMin, thresholdMin: STALE_MAX_MIN });
  }
  if (rows10m < MIN_ROWS_LAST_10M) {
    healthy = false;
    fail('low row throughput in last 10m', {
      rows10m,
      minRows10m: MIN_ROWS_LAST_10M,
    });
  }
  if (pairs10m < MIN_DISTINCT_PAIRS_10M) {
    healthy = false;
    fail('low distinct pair count in last 10m', {
      pairs10m,
      minPairs10m: MIN_DISTINCT_PAIRS_10M,
    });
  }

  if (healthy) {
    ok('collector healthy', {
      latestTs: row.max_ts,
      staleMin: Number(staleMin.toFixed(2)),
      rows10m,
      pairs10m,
    });
  }
}

main()
  .catch((error) => {
    fail('healthcheck crashed', { error: String(error) });
    process.exitCode = 2;
  })
  .finally(async () => {
    await pool.end();
  });
