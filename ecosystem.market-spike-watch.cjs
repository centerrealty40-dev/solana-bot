/**
 * Отдельный PM2-профиль — не смешивать с ecosystem.config.cjs, чтобы не делать
 * `pm2 reload` всего продакшена при добавлении watch-only задачи.
 *
 * Запуск на VPS (из корня репозитория):
 *   pm2 start ecosystem.market-spike-watch.cjs
 *
 * Секреты только в .env хоста (SPIKE_ALERT_TELEGRAM_*), не в этом файле.
 */
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'market-spike-telegram-watch',
      cwd: root,
      script: 'npm',
      args: 'run --silent market-spike-telegram-watch',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: false,
      cron_restart: '*/5 * * * *',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        SPIKE_ALERT_WINDOW_MIN: '30',
        SPIKE_ALERT_THRESHOLD_PCT: '5',
        SPIKE_ALERT_MIN_HOLDERS: '1000',
        SPIKE_ALERT_MIN_AGE_HOURS: '3',
        /** Кулдаун на один mint и направление (мс); снижает спам при серии снимков */
        SPIKE_ALERT_COOLDOWN_MS: '3600000',
        SPIKE_ALERT_MAX_ROWS_PER_TABLE: '800',
        SPIKE_ALERT_MIN_LIQ_USD: '0',
        SPIKE_ALERT_DRY_RUN: '0',
      },
    },
  ],
};
