/**
 * pm2 ecosystem for Solana Alpha Research Platform.
 *
 * Four long-running Node processes:
 *   - sa-api         Fastify webhook receiver + dashboard API on :3000
 *   - sa-collector   DexScreener trending poller (1 req/min)
 *   - sa-scoring     Hourly + 15-min wallet scoring cron
 *   - sa-runner      Hypothesis runner (5s swap loop, 10s exit loop)
 *
 * Deploy:
 *   cd /opt/solana-alpha
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Tail logs:  pm2 logs sa-runner
 * Restart:    pm2 restart sa-api
 * Stop all:   pm2 stop ecosystem.config.cjs
 */
const TSX = './node_modules/.bin/tsx';

module.exports = {
  apps: [
    {
      name: 'sa-api',
      script: TSX,
      args: 'src/api/server.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/api.err.log',
      out_file: './logs/api.out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sa-collector',
      script: TSX,
      args: 'src/collectors/dexscreener-cli.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/collector.err.log',
      out_file: './logs/collector.out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sa-scoring',
      script: TSX,
      args: 'src/scoring/cli.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/scoring.err.log',
      out_file: './logs/scoring.out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sa-runner',
      script: TSX,
      args: 'src/runner/cli.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/runner.err.log',
      out_file: './logs/runner.out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
