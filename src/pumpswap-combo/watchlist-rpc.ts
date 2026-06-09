import type { PumpswapComboConfig } from './config.js';
import { resolveMintPumpPool } from './pool-resolve.js';
import { quotePumpSwapSpotPriceUsd } from './pumpswap-direct.js';
import type { WatchlistRow } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let rpcCursor = 0;

/** On-chain spot for top dump candidates — PG prices lag live dumps by minutes. */
export async function enrichWatchlistLivePrices(
  cfg: PumpswapComboConfig,
  rows: WatchlistRow[],
): Promise<{ refreshed: number }> {
  if (!cfg.watchlistRpcRefreshEnabled || !rows.length) return { refreshed: 0 };

  const cap = Math.max(1, cfg.watchlistRpcRefreshPerTick);
  const sorted = [...rows].sort((a, b) => (b.pgDumpPct ?? 0) - (a.pgDumpPct ?? 0));
  const start = rpcCursor % Math.max(1, sorted.length);
  rpcCursor = (start + cap) % Math.max(1, sorted.length);

  const batch: WatchlistRow[] = [];
  for (let i = 0; i < sorted.length && batch.length < cap; i++) {
    batch.push(sorted[(start + i) % sorted.length]!);
  }

  const now = Date.now();
  let refreshed = 0;

  for (const row of batch) {
    if (
      cfg.watchlistStreamPreferPg &&
      row.snapshotSource === 'pumpswap-combo-stream' &&
      now - row.snapshotTs < cfg.watchlistStreamFreshMs
    ) {
      continue;
    }
    let pool = row.pairAddress?.trim();
    if (!pool) {
      pool = (await resolveMintPumpPool(cfg.rpcUrl, row.mint)) ?? '';
      if (pool) row.pairAddress = pool;
    }
    if (!pool) continue;

    const live = await quotePumpSwapSpotPriceUsd({ rpcUrl: cfg.rpcUrl, poolAddress: pool });
    await sleep(Math.max(40, cfg.watchlistRpcRefreshDelayMs));
    if (!(live != null && live > 0)) continue;

    row.pgPriceUsd = row.pgPriceUsd ?? row.priceUsd;
    row.priceUsd = live;
    row.livePriceTs = now;
    refreshed++;
  }

  return { refreshed };
}
