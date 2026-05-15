/**
 * Отдельный PM2-профиль для второго Telegram-канала: **локальный хай** в lookback-окне PG-баров
 * и откат от пика до последней котировки (без порога «рост от якоря» и без rolling spike 10m).
 *
 * Запуск на VPS (из корня репозитория):
 *
 *   chmod +x scripts/pullback-watch-pm2-entry.sh
 *   pm2 start scripts/pullback-watch-pm2-entry.sh --name market-pullback-telegram-watch \
 *     --cwd /opt/solana-alpha --interpreter bash --merge-logs --time
 *   pm2 save
 *
 * Секреты только в `.env` хоста: `PULLBACK_ALERT_TELEGRAM_BOT_TOKEN`, `PULLBACK_ALERT_TELEGRAM_CHAT_ID`.
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
        PULLBACK_ALERT_MIN_AGE_HOURS: '3',
        PULLBACK_ALERT_MAX_ROWS_PER_TABLE: '800',
        PULLBACK_ALERT_MIN_LIQ_USD: '0',
        PULLBACK_ALERT_MIN_MARKET_CAP_USD: '1500000',
        PULLBACK_ALERT_MIN_VOL_5M_USD: '0',
        PULLBACK_ALERT_DRY_RUN: '0',
        PULLBACK_ALERT_MAX_NEWER_BAR_AGE_MINUTES: '25',
        PULLBACK_ALERT_DISPLAY_TZ: 'Europe/Moscow',
      },
    },
  ],
};
