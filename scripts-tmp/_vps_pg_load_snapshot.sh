#!/usr/bin/env bash
# One-shot PG health for collectors (run on VPS as root or salpha).
set -euo pipefail
cd /opt/solana-alpha
sudo -u salpha node << 'NODE'
const fs = require('fs');
const { Client } = require('pg');
function parseDatabaseUrl() {
  const raw = fs.readFileSync('.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL missing in .env');
  let v = line.slice('DATABASE_URL='.length).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}
(async () => {
  const c = new Client({ connectionString: parseDatabaseUrl() });
  await c.connect();
  const db = await c.query(
    `SELECT pg_database_size(current_database())::bigint AS db_bytes,
            (SELECT COALESCE(sum(numbackends), 0)::bigint FROM pg_stat_database) AS backends`,
  );
  console.log('db:', JSON.stringify(db.rows[0]));
  const tabs = await c.query(
    `SELECT relname, n_live_tup::bigint AS est_rows,
            n_tup_ins::bigint AS ins_total, n_tup_upd::bigint AS upd_total
     FROM pg_stat_user_tables
     WHERE relname LIKE '%pair_snapshots%'
     ORDER BY n_live_tup DESC`,
  );
  console.log('tables:', JSON.stringify(tabs.rows, null, 0));
  const hour = await c.query(`
    SELECT 'meteora' AS dex, count(*)::bigint AS rows_1h FROM meteora_pair_snapshots WHERE created_at > now() - interval '1 hour'
    UNION ALL SELECT 'raydium', count(*)::bigint FROM raydium_pair_snapshots WHERE created_at > now() - interval '1 hour'
    UNION ALL SELECT 'pumpswap', count(*)::bigint FROM pumpswap_pair_snapshots WHERE created_at > now() - interval '1 hour'
    UNION ALL SELECT 'orca', count(*)::bigint FROM orca_pair_snapshots WHERE created_at > now() - interval '1 hour'
    UNION ALL SELECT 'moonshot', count(*)::bigint FROM moonshot_pair_snapshots WHERE created_at > now() - interval '1 hour'
  `);
  console.log('inserts_1h:', JSON.stringify(hour.rows));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
NODE
