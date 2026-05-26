/**
 * W6.12 S01 — JSON-отчёт по `sa_qn_global_daily`.
 *
 *   node scripts-tmp/sa-qn-global-report.mjs
 *   SA_QN_REPORT_DATE=2026-05-05 node scripts-tmp/sa-qn-global-report.mjs
 */
import 'dotenv/config';
import pg from 'pg';
import {
  qnGlobalReadSnapshot,
  qnGlobalDailyCapCredits,
  qnCreditsPerRpc,
} from './sa-qn-global-budget-lib.mjs';

const { Pool } = pg;

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.SA_PG_DSN;
  if (!connectionString) {
    console.error('[fatal] DATABASE_URL or SA_PG_DSN required');
    process.exit(1);
  }
  const usageDate = process.env.SA_QN_REPORT_DATE?.trim() || undefined;
  const pool = new Pool({ connectionString });
  try {
    const snap = await qnGlobalReadSnapshot(pool, usageDate);
    console.log(
      JSON.stringify(
        {
          component: 'sa-qn-global-report',
          ...snap,
          creditsCapEnv: qnGlobalDailyCapCredits(),
          creditsPerRpcAssumed: qnCreditsPerRpc(),
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
