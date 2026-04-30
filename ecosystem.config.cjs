/**
 * PM2 для VPS (/opt/solana-alpha) после W1/W2 slim.
 * Дашборд + sa-stream (raw logsSubscribe). Дальше: sa-warm-writer, sa-atlas
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
    {
      name: 'sa-stream',
      cwd: root,
      script: 'npm',
      args: 'run --silent stream',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: '300M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
