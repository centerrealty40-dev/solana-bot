/**
 * Отдельный PM2-профиль — не смешивать с ecosystem.config.cjs, чтобы не делать
 * `pm2 reload` всего продакшена при добавлении watch-only задачи.
 *
 * Запуск на VPS (из корня репозитория):
 *   pm2 start ecosystem.market-spike-watch.cjs
 *
 * По умолчанию — долгоживущий процесс с опросом PG каждые SPIKE_ALERT_POLL_INTERVAL_MS (быстрее ловит
 * второй минутный бар). Режим «раз в минуту»: SPIKE_ALERT_POLL_INTERVAL_MS=0, autorestart:false,
 * cron_restart в этом же профиле (см. комментарий у apps[0]).
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
      autorestart: true,
      // Если SPIKE_ALERT_POLL_INTERVAL_MS=0: autorestart:false и cron_restart раз в минуту.
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        /** Опрос БД; 0 = один проход и exit (тогда нужен cron + autorestart:false). */
        SPIKE_ALERT_POLL_INTERVAL_MS: '20000',
        /** При опросе: не слать повтор того же события чаще N мс (анти-спам в Telegram). */
        SPIKE_ALERT_POLL_SEND_DEDUPE_MS: '120000',
        /** История баров для поиска резкого шага между соседними минутами (PG только). */
        SPIKE_ALERT_SCAN_MINUTES: '60',
        /** Накопленное окно по первому/последнему бару (0 = выкл.). */
        SPIKE_ALERT_ROLLING_MINUTES: '3',
        SPIKE_ALERT_THRESHOLD_PCT: '2.5',
        SPIKE_ALERT_MIN_HOLDERS: '1000',
        SPIKE_ALERT_MIN_AGE_HOURS: '3',
        /** Верхний предел mint на таблицу; отбор по самым свежим снимкам (MAX(ts)), не по алфавиту mint. */
        SPIKE_ALERT_MAX_ROWS_PER_TABLE: '800',
        SPIKE_ALERT_MIN_LIQ_USD: '0',
        /** 0 = выкл.; поднимите (напр. 2500), чтобы приблизиться к POST lane по объёму 5m */
        SPIKE_ALERT_MIN_VOL_5M_USD: '0',
        SPIKE_ALERT_DRY_RUN: '0',
      },
    },
  ],
};
