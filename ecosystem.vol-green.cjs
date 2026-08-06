/**
 * LERA-only PM2 docs for vol-green-bot.
 *
 * PM2 6 often does NOT parse this file as an ecosystem — prefer:
 *   chmod +x scripts/vol-green-pm2-entry.sh
 *   pm2 start scripts/vol-green-pm2-entry.sh --name vol-green-bot --interpreter bash
 *
 * Wallet: FxQfFTmj… (copy-8zkg.keypair.json)
 * Entry: Volume Awakening / green-tape
 * Exit: mild-dip W9.1 stack (arm 8 / giveback 6 / never-arm / vol-fade)
 * RPC: Helius from .env
 */
const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });

const JUPITER_API_KEY_PM2 = (process.env.JUPITER_API_KEY || '').trim();
const PM2_JUPITER_KEY_ENV = JUPITER_API_KEY_PM2 ? { JUPITER_API_KEY: JUPITER_API_KEY_PM2 } : {};
const HELIUS_API_KEY_PM2 = (process.env.HELIUS_API_KEY || '').trim();
const HELIUS_RPC_URL_PM2 = (
  process.env.HELIUS_RPC_URL ||
  (HELIUS_API_KEY_PM2 ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_PM2}` : '') ||
  (process.env.SA_RPC_HTTP_URL || '').trim()
).trim();

const DEXSCREENER_GATE_ENV = {
  DEXSCREENER_GLOBAL_RATE_LIMIT: '1',
  DEXSCREENER_GLOBAL_MAX_RPM: '120',
  DEXSCREENER_GATE_ENABLED: '1',
  DEXSCREENER_MAX_RPM: '120',
};

module.exports = {
  apps: [
    {
      name: 'vol-green-bot',
      cwd: root,
      script: path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/scripts/vol-green-bot.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autostart: true,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 8000,
      merge_logs: true,
      time: true,
      env: {
        ...PM2_JUPITER_KEY_ENV,
        JUPITER_GLOBAL_MAX_RPS: '9',
        ...DEXSCREENER_GATE_ENV,
        NODE_ENV: 'production',
        VOL_GREEN_APP_NAME: 'vol-green-bot',
        VOL_GREEN_ENTRY_MODE: 'awakening',
        VOL_GREEN_EXECUTION_MODE: 'live',
        VOL_GREEN_WALLET_SECRET: path.join(root, 'data/live/copy-8zkg.keypair.json'),
        VOL_GREEN_WALLET_PUBKEY: 'FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX',
        VOL_GREEN_POSITION_USD: '5',
        VOL_GREEN_MAX_OPEN_POSITIONS: '0',
        VOL_GREEN_JOURNAL_PATH: path.join(root, 'data/volgreen/journal.jsonl'),
        VOL_GREEN_STATE_PATH: path.join(root, 'data/volgreen/state.json'),
        VOL_GREEN_HOT_MINTS_PATH: path.join(root, 'data/volgreen/hot-mints.json'),
        VOL_GREEN_PRICE_RING_PATH: path.join(root, 'data/volgreen/price-ring.json'),
        VOL_GREEN_EXIT_ARM_PCT: '8',
        VOL_GREEN_EXIT_GIVEBACK_PCT: '6',
        VOL_GREEN_EXIT_NEVER_ARM_PATIENCE_MS: '0',
        VOL_GREEN_EXIT_NEVER_ARM_DEAD_MIN_MS: '900000',
        VOL_GREEN_EXIT_NEVER_ARM_DEAD_PNL_PCT: '15',
        VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_MIN_MS: '600000',
        VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_RATIO: '0.35',
        VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD: '500',
        VOL_GREEN_EXIT_NEVER_ARM_MAX_HOLD_MS: '5400000',
        VOL_GREEN_SLIPPAGE_BPS: '500',
        VOL_GREEN_MAX_CHASE_PCT: '4',
        VOL_GREEN_ALLOWED_DEX_IDS: 'pumpswap,pumpfun,raydium',
        VOL_GREEN_DISCOVER_SOURCES: 'stream,boosts,profiles',
        VOL_GREEN_STREAM: '1',
        VOL_GREEN_MIN_FEE_SOL_RESERVE: '0.02',
        LIVE_BUY_MAX_PRICE_IMPACT_PCT: '1',
        LIVE_JUPITER_SWAP_PRIORITY_LEVEL: 'medium',
        LIVE_JUPITER_PRIORITY_MAX_SOL: '0.00005',
        ...(HELIUS_API_KEY_PM2 ? { HELIUS_API_KEY: HELIUS_API_KEY_PM2 } : {}),
        ...(HELIUS_RPC_URL_PM2
          ? {
              HELIUS_RPC_URL: HELIUS_RPC_URL_PM2,
              VOL_GREEN_RPC_URL: HELIUS_RPC_URL_PM2,
              MILD_DIP_RPC_URL: HELIUS_RPC_URL_PM2,
              SA_RPC_HTTP_URL: HELIUS_RPC_URL_PM2,
              SOLANA_RPC_HTTP_URL: HELIUS_RPC_URL_PM2,
              SOLANA_RPC_HELIUS_PREFER: '1',
            }
          : {}),
      },
    },
  ],
};
