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

/** Free Dexscreener/Gecko only; wider universe than trading defaults (~55 mints). GeckoTerminal caps at 10 pages, 30 req/min → 6 pages × 3 collectors. */
const GECKO_TRENDING_PAGES = '6';
const EXTRA_SEARCH_TERMS = 'sol,usdc,pump,ai,cat,dog,trump,bonk,wif,pepe';
const ENV_OVERRIDES = {
  'sa-raydium': {
    RAYDIUM_COLLECTOR_INTERVAL_MS: '60000',
    PAPER2_SNAPSHOT_OPENS: '0',
    RAYDIUM_GECKO_TRENDING_PAGES: GECKO_TRENDING_PAGES,
    RAYDIUM_DEX_SEARCH_TERMS: `raydium,solana,meme,${EXTRA_SEARCH_TERMS}`,
  },
  'sa-meteora': {
    METEORA_COLLECTOR_INTERVAL_MS: '60000',
    PAPER2_SNAPSHOT_OPENS: '0',
    METEORA_GECKO_TRENDING_PAGES: GECKO_TRENDING_PAGES,
    METEORA_DEX_SEARCH_TERMS: `meteora,dlmm,solana,${EXTRA_SEARCH_TERMS}`,
  },
  'sa-pumpswap': {
    PUMPSWAP_COLLECTOR_INTERVAL_MS: '60000',
    PAPER2_SNAPSHOT_OPENS: '0',
    PUMPSWAP_GECKO_TRENDING_PAGES: GECKO_TRENDING_PAGES,
    PUMPSWAP_DEX_SEARCH_TERMS: `pumpswap,pump swap,pump.fun solana,${EXTRA_SEARCH_TERMS}`,
  },
  /** First-day runners dump hard; 8h (trading default) misses them. */
  'market-spike-telegram-watch': {
    SPIKE_ALERT_MIN_AGE_HOURS: '4',
    SPIKE_ALERT_MIN_MARKET_CAP_USD: '2000000',
    SPIKE_ALERT_DUMP_TIER1_MCAP_USD: '2000000',
    SPIKE_ALERT_DUMP_TIER1_MIN_PCT: '15',
    SPIKE_ALERT_DUMP_TIER1_MIN_PCT_ROLLING: '15',
    SPIKE_ALERT_DUMP_TIER2_MIN_PCT: '15',
    SPIKE_ALERT_DUMP_TIER2_MIN_PCT_ROLLING: '15',
    SPIKE_ALERT_DUMP_TIER3_MIN_PCT: '15',
    SPIKE_ALERT_DUMP_TIER3_MIN_PCT_ROLLING: '15',
  },
  'market-pullback-telegram-watch': {
    PULLBACK_ALERT_MIN_MARKET_CAP_USD: '2000000',
    PULLBACK_ALERT_MIN_RETRACE_FROM_PEAK_PCT: '15',
  },
  'retrace-alert-watch': {
    RETRACE_ALERT_MIN_MCAP_USD: '2000000',
    RETRACE_ALERT_MIN_RETRACE_FROM_PEAK_PCT: '15',
  },
};

const apps = full.allApps
  .filter((app) => ALERTS_ONLY_APPS.has(app.name))
  .map((app) => ({ ...app, env: { ...app.env, ...(ENV_OVERRIDES[app.name] || {}) } }));
const missing = [...ALERTS_ONLY_APPS].filter((name) => !apps.some((app) => app.name === name));
if (missing.length > 0) {
  throw new Error(`[alerts-only.config.cjs] apps missing in ecosystem.config.cjs: ${missing.join(', ')}`);
}

module.exports = { apps };
