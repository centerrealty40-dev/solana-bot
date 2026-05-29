/**
 * dca_frontrun (paper) — isolated PM2 profile. Product prefix: salpha-dcabot.
 *
 * Start:
 *   pm2 start ecosystem.dcabot.cjs --only salpha-dcabot-paper
 *   pm2 save
 *
 * Logs:
 *   pm2 logs salpha-dcabot-paper --lines 150
 *
 * PAPER ONLY: never signs/sends transactions, no wallet key is loaded. The dashboard binds
 * to 127.0.0.1 and is reachable only over the private VPN.
 */
const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });

module.exports = {
  apps: [
    {
      name: 'salpha-dcabot-paper',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/dcabot.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        DCABOT_ENABLED: process.env.DCABOT_ENABLED || '1',
        // DB: shared Neon (same as the watcher). Reuses SA_PG_DSN / DATABASE_URL from .env.
        // RPC for vault liveness checks (Helius primary, optional QuickNode fallback).
        DCABOT_RPC_URL: process.env.DCABOT_RPC_URL || process.env.SA_RPC_HTTP_URL || process.env.HELIUS_RPC_URL || '',
        DCABOT_RPC_FALLBACK_URL: process.env.DCABOT_RPC_FALLBACK_URL || process.env.SA_RPC_FALLBACK_URL || '',
        // Paper bank + agreed trading spec.
        DCABOT_BANK_USD: process.env.DCABOT_BANK_USD || '1000',
        DCABOT_MIN_GAIN_PCT: process.env.DCABOT_MIN_GAIN_PCT || '3',
        DCABOT_BASE_ENTRY_USD: process.env.DCABOT_BASE_ENTRY_USD || '300',
        DCABOT_AVG_DOWN_STEP_PCT: process.env.DCABOT_AVG_DOWN_STEP_PCT || '5',
        DCABOT_AVG_DOWN_USD: process.env.DCABOT_AVG_DOWN_USD || '300',
        DCABOT_AVG_DOWN_MAX_ADDS: process.env.DCABOT_AVG_DOWN_MAX_ADDS || '0',
        DCABOT_TP_STEP_PCT: process.env.DCABOT_TP_STEP_PCT || '5',
        DCABOT_TP_SELL_FRACTION: process.env.DCABOT_TP_SELL_FRACTION || '0.2',
        DCABOT_EXIT_FIRST_CYCLES_BEFORE: process.env.DCABOT_EXIT_FIRST_CYCLES_BEFORE || '2',
        DCABOT_EXIT_SECOND_CYCLES_BEFORE: process.env.DCABOT_EXIT_SECOND_CYCLES_BEFORE || '1',
        DCABOT_EXIT_FIRST_FRACTION: process.env.DCABOT_EXIT_FIRST_FRACTION || '0.5',
        DCABOT_BIG_CYCLE_HOLD_USD: process.env.DCABOT_BIG_CYCLE_HOLD_USD || '10000',
        DCABOT_EARLY_CANCEL_LOSS_FIRST_FRACTION: process.env.DCABOT_EARLY_CANCEL_LOSS_FIRST_FRACTION || '0.5',
        DCABOT_EARLY_CANCEL_DELAY_MIN: process.env.DCABOT_EARLY_CANCEL_DELAY_MIN || '10',
        DCABOT_TICK_MS: process.env.DCABOT_TICK_MS || '15000',
        DCABOT_SIGNAL_SOURCE: process.env.DCABOT_SIGNAL_SOURCE || 'swap_exec_dca',
        DCABOT_SIGNAL_LOOKBACK_MIN: process.env.DCABOT_SIGNAL_LOOKBACK_MIN || '240',
        DCABOT_DASH_HOST: process.env.DCABOT_DASH_HOST || '127.0.0.1',
        DCABOT_DASH_PORT: process.env.DCABOT_DASH_PORT || '8645',
      },
    },
  ],
};
