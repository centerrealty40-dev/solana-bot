/**
 * PM2 — текущий боевой состав на VPS (/opt/solana-alpha), пользователь salpha.
 *
 * Не заменяет ecosystem.config.cjs (legacy: sa-api, sa-collector, sa-scoring, sa-runner).
 *
 * Запуск с нуля (после `npm ci` и `.env`):
 *   cd /opt/solana-alpha
 *   pm2 start ecosystem.vps.cjs
 *   pm2 save
 *
 * Если процессы уже созданы вручную — перед миграцией: `pm2 delete all` (осторожно)
 * или переименуйте старые имена, чтобы не было дубликатов.
 *
 * Не использовать `pm2 start ecosystem.vps.cjs --only <app>` — см. deploy/RUNTIME.md;
 * новые процессы поднимать явным `pm2 start scripts-tmp/….mjs --name sa-…`.
 *
 * Логи PM2 по умолчанию: ~/.pm2/logs/
 */
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    // ----- Ввод данных и конвейеры -----
    {
      name: 'sa-moonshot-collector',
      cwd: root,
      script: path.join(root, 'scripts-tmp/moonshot-collector.mjs'),
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sa-raydium-collector',
      cwd: root,
      script: path.join(root, 'scripts-tmp/raydium-collector.mjs'),
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '320M',
      merge_logs: true,
      time: true,
      env: {
        // 30s combat test (DexScreener budget); был 90000 — откат через ecosystem при 429
        RAYDIUM_COLLECTOR_INTERVAL_MS: '30000',
        RAYDIUM_ENQUEUE_RPC: '0',
      },
    },
    {
      name: 'sa-meteora-collector',
      cwd: root,
      script: path.join(root, 'scripts-tmp/meteora-collector.mjs'),
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '320M',
      merge_logs: true,
      time: true,
      env: {
        METEORA_COLLECTOR_INTERVAL_MS: '30000',
        METEORA_ENQUEUE_RPC: '0',
      },
    },
    {
      name: 'sa-orca-collector',
      cwd: root,
      script: path.join(root, 'scripts-tmp/orca-collector.mjs'),
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '320M',
      merge_logs: true,
      time: true,
      env: {
        ORCA_COLLECTOR_INTERVAL_MS: '120000',
        ORCA_ENQUEUE_RPC: '0',
      },
    },
    {
      name: 'sa-jupiter-route-watcher',
      cwd: root,
      script: path.join(root, 'scripts-tmp/jupiter-route-watcher.mjs'),
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '280M',
      merge_logs: true,
      time: true,
      env: {
        JUPITER_WATCHER_INTERVAL_MS: '120000',
        JUPITER_WATCHER_LOOKBACK_HOURS: '6',
        JUPITER_WATCHER_MAX_MINTS: '16',
        JUPITER_WATCHER_REQUEST_DELAY_MS: '1600',
        JUPITER_WATCHER_ENQUEUE_RPC: '0',
      },
    },
    {
      name: 'sa-direct-lp-detector',
      cwd: root,
      script: path.join(root, 'scripts-tmp/direct-lp-detector.mjs'),
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '250M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sa-pumpswap-collector',
      cwd: root,
      script: 'npm',
      args: 'run --silent pumpswap-collector:start',
      interpreter: 'none',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      cron_restart: '0 */6 * * *',
      merge_logs: true,
      time: true,
      env: {
        PUMPSWAP_COLLECTOR_INTERVAL_MS: '30000',
      },
    },
    {
      name: 'sa-rpc-collector',
      cwd: root,
      script: 'npm',
      args: 'run --silent rpc-collector:start',
      interpreter: 'none',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sa-sigseed-worker',
      cwd: root,
      script: 'npm',
      args: 'run --silent sigseed:worker',
      interpreter: 'none',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      merge_logs: true,
      time: true,
    },

    // ----- Бумажные стратегии (live-paper-trader) -----
    {
      name: 'pt1-smart-lottery',
      cwd: root,
      script: path.join(root, 'scripts-tmp/profiles/run-pt1-smart-lottery.sh'),
      interpreter: 'bash',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'pt1-fresh-validated',
      cwd: root,
      script: path.join(root, 'scripts-tmp/profiles/run-pt1-fresh-validated.sh'),
      interpreter: 'bash',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'pt1-dip-runners',
      cwd: root,
      script: path.join(root, 'scripts-tmp/profiles/run-pt1-dip-runners.sh'),
      interpreter: 'bash',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'pt1-oscar-clone',
      cwd: root,
      script: path.join(root, 'scripts-tmp/profiles/run-pt1-oscar-clone.sh'),
      interpreter: 'bash',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'pt1-dno-clone',
      cwd: root,
      script: path.join(root, 'scripts-tmp/profiles/run-pt1-dno-clone.sh'),
      interpreter: 'bash',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      merge_logs: true,
      time: true,
    },
    {
      name: 'pt1-organizer-paper',
      cwd: root,
      script: path.join(root, 'scripts-tmp/profiles/run-pt1-organizer-paper.sh'),
      interpreter: 'bash',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      merge_logs: true,
      time: true,
    },

    // ----- Наблюдение -----
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
