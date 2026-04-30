/**
 * PM2 для VPS (/opt/solana-alpha) после W1/W2 slim.
 * Один процесс — дашборд. Новые процессы (sa-stream, sa-warm-writer, sa-atlas)
 * появятся в W3+.
 *
 * Запуск: pm2 start ecosystem.config.cjs
 */
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'dashboard-organizer-paper',
      cwd: root,
      script: 'npm',
      args: 'run --silent dashboard',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        HOST: '0.0.0.0',
        PORT: '3008',
        STORE_PATH: path.join(root, 'data/paper2/organizer-paper.jsonl'),
      },
    },
  ],
};
