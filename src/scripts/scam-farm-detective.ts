/**
 * Scam-farm / orchestrated-ring detector (DB-first, review → confirm → Wallet Atlas).
 *
 * Env (see .env.example):
 *   SCAM_FARM_DRY_RUN=1              default: no DB writes to candidates; atlas still dry inside write fn
 *   SCAM_FARM_WRITE_ATLAS=0          set 1 on server after review
 *   SCAM_FARM_LOOKBACK_DAYS=14
 *   SCAM_FARM_FUNDING_WINDOW_SEC=300
 *   SCAM_FARM_STRONG_SCORE=80
 *   SCAM_FARM_CONFIRM_WRITE_SCORE=75
 *   SCAM_FARM_ENABLE_RPC=0
 *   SCAM_FARM_RPC_BUDGET=20
 *   SOLANA_RPC_HTTP_URL=             QuickNode/JSON-RPC https (with ENABLE_RPC); never commit key
 *   SCAM_FARM_LOG_PATH=data/logs/scam-farm-detective.log
 *   SCAM_FARM_UPDATE_PRIMARY=0
 *
 * Scheduler (server, user salpha):
 *   every 4h: cron zero minutes, every 4 hours (see SCAM_FARM_CRON in .env.example);
 *   cd /opt/solana-alpha and SCAM_FARM_DRY_RUN=0 npm run scam-farm:detect
 *   or PM2: npm run scam-farm:loop (node-cron, same env in ecosystem)
 */
import 'dotenv/config';
import cron from 'node-cron';
import { runScamFarmDetectivePass } from '../intel/scam-farm-detective/run-detective.js';
import { loadScamFarmConfig } from '../intel/scam-farm-detective/config.js';
import { child } from '../core/logger.js';

const log = child('scam-farm-detective-cli');

const useLoop = process.argv.includes('--loop');

async function one(): Promise<void> {
  try {
    const m = await runScamFarmDetectivePass();
    log.info(m, 'done');
  } catch (e) {
    log.error({ err: String(e) }, 'run failed');
    process.exit(1);
  }
}

if (!useLoop) {
  void one().then(() => process.exit(0));
} else {
  const expr = process.env.SCAM_FARM_CRON ?? '0 */4 * * *';
  if (!cron.validate(expr)) {
    log.error({ expr }, 'invalid SCAM_FARM_CRON');
    process.exit(1);
  }
  loadScamFarmConfig();
  void one();
  cron.schedule(expr, () => {
    void one();
  });
  log.info({ expr }, 'scam-farm-detective scheduler started');
}
