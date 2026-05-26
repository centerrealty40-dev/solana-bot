/**
 * Документация env для `market-pullback-telegram-watch`.
 * Канонический PM2-профиль: `ecosystem.config.cjs` (apps `market-pullback-telegram-watch`).
 * Этот файл — справочник; на VPS не стартуй отдельно, только `pm2 reload ecosystem.config.cjs`.
 */
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'market-pullback-telegram-watch',
      cwd: root,
      script: 'npm',
      args: 'run --silent market-pullback-telegram-watch',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PULLBACK_ALERT_SIGNAL_MODE: 'local_high_retrace',
        PULLBACK_ALERT_POLL_INTERVAL_MS: '20000',
        PULLBACK_ALERT_POLL_SEND_DEDUPE_MS: '120000',
        PULLBACK_ALERT_MINT_COOLDOWN_MINUTES: '30',
        PULLBACK_ALERT_SCAN_MINUTES: '360',
        PULLBACK_ALERT_MIN_RETRACE_FROM_PEAK_PCT: '6',
        PULLBACK_ALERT_MIN_HOLDERS: '1000',
        PULLBACK_ALERT_HOLDER_NULL_SOFT: '1',
        PULLBACK_ALERT_MIN_AGE_HOURS: '8',
        PULLBACK_ALERT_MAX_ROWS_PER_TABLE: '800',
        PULLBACK_ALERT_MIN_LIQ_USD: '0',
        PULLBACK_ALERT_MIN_MARKET_CAP_USD: '1000000',
        PULLBACK_ALERT_MIN_VOL_5M_USD: '0',
        PULLBACK_ALERT_DRY_RUN: '0',
        PULLBACK_ALERT_MAX_NEWER_BAR_AGE_MINUTES: '25',
        PULLBACK_ALERT_DISPLAY_TZ: 'Europe/Moscow',
        PULLBACK_ALERT_CANONICAL_POOL_BY_MAX_LIQ: '1',
        PULLBACK_ALERT_TELEGRAM_CHAT_ID: '-1003504887486',
      },
    },
  ],
};
