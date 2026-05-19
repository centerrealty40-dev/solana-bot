/**
 * Документация env для `retrace-alert-watch`.
 * Канонический PM2-профиль: `ecosystem.config.cjs` (apps `retrace-alert-watch`).
 * Этот файл — справочник; на VPS не стартуй отдельно, только `pm2 reload ecosystem.config.cjs`.
 */
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'retrace-alert-watch',
      cwd: root,
      script: 'npm',
      args: 'run --silent retrace-alert-watch',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        RETRACE_ALERT_POLL_INTERVAL_MS: '20000',
        RETRACE_ALERT_POLL_SEND_DEDUPE_MS: '120000',
        RETRACE_ALERT_MINT_COOLDOWN_MINUTES: '30',
        RETRACE_ALERT_SCAN_MINUTES: '120',
        RETRACE_ALERT_MIN_MCAP_USD: '1000000',
        RETRACE_ALERT_MIN_PUMP_PCT: '6',
        RETRACE_ALERT_MIN_RETRACE_FROM_PEAK_PCT: '10',
        RETRACE_ALERT_MAX_EVENT_AGE_MINUTES: '15',
        RETRACE_ALERT_MAX_ROWS_PER_TABLE: '800',
        RETRACE_ALERT_MIN_AGE_HOURS: '8',
        RETRACE_ALERT_MIN_HOLDERS: '0',
        RETRACE_ALERT_HOLDER_NULL_SOFT: '1',
        RETRACE_ALERT_DISPLAY_TZ: 'Europe/Moscow',
        RETRACE_ALERT_DRY_RUN: '0',
        RETRACE_ALERT_TELEGRAM_CHAT_ID: '-1003878024799',
      },
    },
  ],
};
