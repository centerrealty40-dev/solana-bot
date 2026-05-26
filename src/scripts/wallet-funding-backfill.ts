/**
 * W6.12 S04 — проставление `wallets.funding_source` / `funding_ts` из первого входа SOL в `money_flows`.
 *
 *   npm run wallet-funding:backfill
 *   npm run wallet-funding:backfill -- --dry-run
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const databaseUrl = process.env.DATABASE_URL || process.env.SA_PG_DSN;
  if (!databaseUrl) {
    console.error('[fatal] DATABASE_URL or SA_PG_DSN required');
    process.exit(1);
  }
  if (process.env.SA_FUNDING_BACKFILL_ENABLED !== '1' && !dryRun) {
    console.error('[fatal] SA_FUNDING_BACKFILL_ENABLED=1 required (or pass --dry-run)');
    process.exit(1);
  }

  const lookbackDays = envNum('SA_FUNDING_LOOKBACK_DAYS', 30);
  const batch = envNum('SA_FUNDING_BATCH_SIZE', 5000);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const countSql = `
      SELECT count(*)::int AS c FROM (
        SELECT DISTINCT ON (mf.target_wallet)
          mf.target_wallet AS addr
        FROM money_flows mf
        WHERE mf.asset = 'SOL'
          AND mf.source_wallet IS NOT NULL
          AND mf.target_wallet IS NOT NULL
          AND mf.source_wallet <> mf.target_wallet
          AND mf.tx_time > now() - ($1::int * interval '1 day')
        ORDER BY mf.target_wallet, mf.tx_time ASC
      ) q
      INNER JOIN wallets w ON w.address = q.addr AND w.funding_source IS NULL`;

    const cnt = await pool.query(countSql, [lookbackDays]);
    const eligible = cnt.rows[0]?.c ?? 0;

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            component: 'wallet-funding-backfill',
            dryRun: true,
            lookbackDays,
            batchCap: batch,
            walletsEligible: eligible,
          },
          null,
          2,
        ),
      );
      return;
    }

    const upd = await pool.query(
      `UPDATE wallets w
       SET funding_source = x.funder,
           funding_ts = x.ft,
           updated_at = now()
       FROM (
         SELECT DISTINCT ON (mf.target_wallet)
           mf.target_wallet AS addr,
           mf.source_wallet AS funder,
           mf.tx_time AS ft
         FROM money_flows mf
         WHERE mf.asset = 'SOL'
           AND mf.source_wallet IS NOT NULL
           AND mf.target_wallet IS NOT NULL
           AND mf.source_wallet <> mf.target_wallet
           AND mf.tx_time > now() - ($1::int * interval '1 day')
         ORDER BY mf.target_wallet, mf.tx_time ASC
         LIMIT $2::int
       ) x
       WHERE w.address = x.addr AND w.funding_source IS NULL`,
      [lookbackDays, batch],
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          component: 'wallet-funding-backfill',
          rowsUpdated: upd.rowCount ?? 0,
          lookbackDays,
          batchCap: batch,
          walletsEligibleApprox: eligible,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
