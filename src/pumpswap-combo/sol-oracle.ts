import { getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';

const REFRESH_TTL_MS = 45_000;
let lastRefreshMs = 0;

/** Jupiter SOL/USD — refresh before sizing buys and USD marks (default $100 stale otherwise). */
export async function ensureComboSolUsd(force = false): Promise<number> {
  const now = Date.now();
  if (force || now - lastRefreshMs >= REFRESH_TTL_MS) {
    await refreshSolPrice();
    lastRefreshMs = now;
  }
  return getSolUsd();
}
