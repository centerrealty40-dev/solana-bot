/**
 * DCA watcher as isolated PM2 profile (safe to reload separately).
 *
 * Start:
 *   pm2 start ecosystem.dca-watch.cjs --only dca-telegram-watch
 *   pm2 save
 *
 * Logs:
 *   pm2 logs dca-telegram-watch --lines 150
 */
const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });

module.exports = {
  apps: [
    {
      name: 'dca-telegram-watch',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/dca-telegram-watch.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        // Wallets to monitor (comma-separated Solana pubkeys)
        DCA_WATCH_WALLETS:
          process.env.DCA_WATCH_WALLETS ||
          'trfb53BmkHNeoqaa3REgqnrbwUZqAFYdjTkivkJ6aWg,G5ZGRWwFRYUi5PL1fXXTktfdysRxTaYeDeoG4UM5jMba',
        // Prefer explicit watch RPC, then SA_RPC_HTTP_URL from .env
        DCA_WATCH_RPC_URL: process.env.DCA_WATCH_RPC_URL || process.env.SA_RPC_HTTP_URL || '',
        DCA_WATCH_POLL_INTERVAL_MS: process.env.DCA_WATCH_POLL_INTERVAL_MS || '20000',
        DCA_WATCH_SIGNATURE_LIMIT: process.env.DCA_WATCH_SIGNATURE_LIMIT || '20',
        DCA_WATCH_DISCOVERY_SIGNATURE_LIMIT: process.env.DCA_WATCH_DISCOVERY_SIGNATURE_LIMIT || '100',
        DCA_WATCH_DISCOVERY_MAX_PAGES: process.env.DCA_WATCH_DISCOVERY_MAX_PAGES || '10',
        DCA_WATCH_STATE_PATH: process.env.DCA_WATCH_STATE_PATH || path.join(root, 'data/dca-watch-state.json'),
        // Per-watcher telegram override; if empty, watcher falls back to TELEGRAM_* env
        DCA_WATCH_TELEGRAM_BOT_TOKEN: process.env.DCA_WATCH_TELEGRAM_BOT_TOKEN || '',
        DCA_WATCH_TELEGRAM_CHAT_ID: process.env.DCA_WATCH_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '',
        DCA_WATCH_SETUP_MIN_USD: process.env.DCA_WATCH_SETUP_MIN_USD || '0',
        DCA_WATCH_CYCLE_TIER_SMALL_USD: process.env.DCA_WATCH_CYCLE_TIER_SMALL_USD || '200',
        DCA_WATCH_CYCLE_TIER_SMALL_MIN_CYCLES: process.env.DCA_WATCH_CYCLE_TIER_SMALL_MIN_CYCLES || '5',
        DCA_WATCH_CYCLE_TIER_LARGE_USD: process.env.DCA_WATCH_CYCLE_TIER_LARGE_USD || '2000',
        DCA_WATCH_CYCLE_TIER_LARGE_MIN_CYCLES: process.env.DCA_WATCH_CYCLE_TIER_LARGE_MIN_CYCLES || '2',
        DCA_WATCH_DEFAULT_CYCLE_SEC: process.env.DCA_WATCH_DEFAULT_CYCLE_SEC || '120',
        DCA_WATCH_TARGET_CYCLES: process.env.DCA_WATCH_TARGET_CYCLES || '100',
        DCA_WATCH_SWAP_EXEC_ENABLED: process.env.DCA_WATCH_SWAP_EXEC_ENABLED || '1',
        DCA_WATCH_SWAP_EXEC_MIN_CYCLE_USD: process.env.DCA_WATCH_SWAP_EXEC_MIN_CYCLE_USD || '100',
        DCA_WATCH_SWAP_EXEC_DEFAULT_FREQ_SEC: process.env.DCA_WATCH_SWAP_EXEC_DEFAULT_FREQ_SEC || '60',
        DCA_WATCH_SWAP_EXEC_EST_CYCLES: process.env.DCA_WATCH_SWAP_EXEC_EST_CYCLES || '60',
      },
    },
  ],
};
