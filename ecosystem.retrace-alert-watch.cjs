/**
 * Отдельный PM2-профиль — не смешивать с ecosystem.config.cjs.
 * PM2 на хосте воспринимает этот .cjs как обычный скрипт Node, а не ecosystem — используйте bash-обёртку:
 *
 *   chmod +x scripts/retrace-alert-pm2-entry.sh
 *   pm2 start scripts/retrace-alert-pm2-entry.sh --name retrace-alert-watch \
 *     --cwd /opt/solana-alpha --interpreter bash --merge-logs --time
 *   pm2 save
 *
 * Блок `apps` ниже — документация env (дублируется в scripts/retrace-alert-pm2-entry.sh).
 * Секреты только в `.env` хоста: RETRACE_ALERT_TELEGRAM_* (никогда не коммитить).
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
        RETRACE_ALERT_MIN_MCAP_USD: '1500000',
        RETRACE_ALERT_MIN_PUMP_PCT: '6',
        RETRACE_ALERT_MIN_RETRACE_FROM_PEAK_PCT: '10',
        RETRACE_ALERT_MAX_EVENT_AGE_MINUTES: '15',
        RETRACE_ALERT_MAX_ROWS_PER_TABLE: '800',
        RETRACE_ALERT_MIN_AGE_HOURS: '3',
        RETRACE_ALERT_MIN_HOLDERS: '0',
        RETRACE_ALERT_HOLDER_NULL_SOFT: '1',
        RETRACE_ALERT_DISPLAY_TZ: 'Europe/Moscow',
        RETRACE_ALERT_DRY_RUN: '0',
      },
    },
  ],
};
