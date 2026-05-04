import 'dotenv/config';
import { runScamFarmDetectivePass } from '../intel/scam-farm-detective/run-detective.js';

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

if (hasHelpFlag()) {
  console.log(`scam-farm-detective — SQL + optional RPC + Atlas write

Env (см. SCAM_FARM_* в .env.example):
  SCAM_FARM_DRY_RUN=0|1   (default 1)
  SCAM_FARM_WRITE_ATLAS=0|1
  SCAM_FARM_ENABLE_RPC=0|1  + SOLANA_RPC_HTTP_URL / QUICKNODE_HTTP_URL
  SCAM_FARM_MAX_SQL_ROWS, SCAM_FARM_LOOKBACK_DAYS, …

Runs one full pass (sync_fund / rug_cohort / orchestrate_split → scam_farm_candidates).
`);
  process.exit(0);
}

runScamFarmDetectivePass()
  .then((m) => {
    console.log(JSON.stringify({ ok: true, metrics: m }));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    process.exit(1);
  });
