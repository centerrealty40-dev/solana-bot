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
      /** Чаще тик — только SELECT к БД; Telegram без изменения коллекторов. */
      cron_restart: '*/2 * * * *',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** Окно «сейчас vs не новее N сек назад»; только PG-снимки, без новых RPC/HTTP. */
        SPIKE_ALERT_LOOKBACK_SEC: '60',
        SPIKE_ALERT_THRESHOLD_PCT: '2.5',
        SPIKE_ALERT_MIN_HOLDERS: '1000',
        SPIKE_ALERT_MIN_AGE_HOURS: '3',
        /** Кулдаун на один mint и направление (мс); снижает спам при серии снимков */
        SPIKE_ALERT_COOLDOWN_MS: '3600000',
        SPIKE_ALERT_MAX_ROWS_PER_TABLE: '800',
        SPIKE_ALERT_MIN_LIQ_USD: '0',
        /** 0 = выкл.; поднимите (напр. 2500), чтобы приблизиться к POST lane по объёму 5m */
        SPIKE_ALERT_MIN_VOL_5M_USD: '0',
        SPIKE_ALERT_DRY_RUN: '0',
      },
    },
  ],
};
