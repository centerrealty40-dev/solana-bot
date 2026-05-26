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
        DCA_WATCH_DISCOVERY_ENABLED: process.env.DCA_WATCH_DISCOVERY_ENABLED || '0',
        DCA_WATCH_DISCOVERY_PROGRAMS:
          process.env.DCA_WATCH_DISCOVERY_PROGRAMS ||
          'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4,proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u,DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH',
        DCA_WATCH_DISCOVERY_SIGNATURE_LIMIT: process.env.DCA_WATCH_DISCOVERY_SIGNATURE_LIMIT || '25',
        DCA_WATCH_MAX_DISCOVERED_WALLETS: process.env.DCA_WATCH_MAX_DISCOVERED_WALLETS || '50',
        DCA_WATCH_DISCOVERED_WALLET_TTL_MS: process.env.DCA_WATCH_DISCOVERED_WALLET_TTL_MS || '604800000',
        DCA_WATCH_SEEN_SIG_TTL_MS: process.env.DCA_WATCH_SEEN_SIG_TTL_MS || '86400000',
        DCA_WATCH_SOL_USD: process.env.DCA_WATCH_SOL_USD || '165',
        DCA_WATCH_TARGET_CYCLES: process.env.DCA_WATCH_TARGET_CYCLES || '100',
        DCA_WATCH_STATE_PATH: process.env.DCA_WATCH_STATE_PATH || path.join(root, 'data/dca-watch-state.json'),
        // Per-watcher telegram override; if empty, watcher falls back to TELEGRAM_* env
        DCA_WATCH_TELEGRAM_BOT_TOKEN: process.env.DCA_WATCH_TELEGRAM_BOT_TOKEN || '',
        DCA_WATCH_TELEGRAM_CHAT_ID: process.env.DCA_WATCH_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '',
      },
    },
  ],
};
