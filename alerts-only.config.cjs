/**
 * Alerts-only PM2 profile: DEX collectors (PG snapshots) + Telegram watch-only alerts.
 * No trading lanes (live-oscar, mild-dip, dashboard, wallet intel) — nothing requiring RPC/Jupiter.
 *
 * VPS: `pm2 start alerts-only.config.cjs && pm2 save`
 * App definitions are taken from `ecosystem.config.cjs` (`allApps`, bypassing OSCAR_VPS_EXCLUDED_APPS);
 * secrets only in `.env` on the host.
 */
const full = require('./ecosystem.config.cjs');

const ALERTS_ONLY_APPS = new Set([
  'sa-raydium',
  'sa-meteora',
  'sa-pumpswap',
  'market-spike-telegram-watch',
  'market-pullback-telegram-watch',
  'retrace-alert-watch',
]);

/** Free Dexscreener/Gecko only (no RPC budget to protect) → minute bars for the watchers; no live journal to enrich. */
const COLLECTOR_ENV_OVERRIDES = {
  'sa-raydium': { RAYDIUM_COLLECTOR_INTERVAL_MS: '60000', PAPER2_SNAPSHOT_OPENS: '0' },
  'sa-meteora': { METEORA_COLLECTOR_INTERVAL_MS: '60000', PAPER2_SNAPSHOT_OPENS: '0' },
  'sa-pumpswap': { PUMPSWAP_COLLECTOR_INTERVAL_MS: '60000', PAPER2_SNAPSHOT_OPENS: '0' },
};

const apps = full.allApps
  .filter((app) => ALERTS_ONLY_APPS.has(app.name))
  .map((app) => ({ ...app, env: { ...app.env, ...(COLLECTOR_ENV_OVERRIDES[app.name] || {}) } }));
const missing = [...ALERTS_ONLY_APPS].filter((name) => !apps.some((app) => app.name === name));
if (missing.length > 0) {
  throw new Error(`[alerts-only.config.cjs] apps missing in ecosystem.config.cjs: ${missing.join(', ')}`);
}

module.exports = { apps };
