import type { TxJsonParsed } from '../parser/rpc-http.js';
import { extractPumpSwapPoolFromTx } from '../parser/allowlisted-dex-swap.js';
import { resolveMintPumpPool, verifyWsolPumpPool } from '../pumpswap-combo/pool-resolve.js';
import { fetchMintPoolAddress } from '../pumpswap-combo/watchlist.js';
import type { PumpswapComboFollowConfig } from './config.js';

export type FollowPoolResolveSource =
  | 'leader_hint'
  | 'leader_tx'
  | 'pg_snapshot'
  | 'canonical_pda'
  | 'none';

export type FollowPoolResolveResult = {
  pool: string | null;
  source: FollowPoolResolveSource;
};

async function sourceForPool(
  cfg: PumpswapComboFollowConfig,
  mint: string,
  pool: string,
  hints?: { leaderTx?: TxJsonParsed; poolHint?: string },
): Promise<FollowPoolResolveSource> {
  const hint = hints?.poolHint?.trim();
  if (hint && hint === pool) return 'leader_hint';
  if (hints?.leaderTx) {
    const fromTx = extractPumpSwapPoolFromTx(hints.leaderTx);
    if (fromTx === pool) return 'leader_tx';
  }
  const pg = await fetchMintPoolAddress(mint);
  if (pg === pool) return 'pg_snapshot';
  if (await verifyWsolPumpPool(cfg.rpcUrl, pool)) return 'canonical_pda';
  return 'none';
}

/** Resolve PumpSwap WSOL pool for mirror buy — PG lag must not block follow entries. */
export async function resolveFollowPoolAddress(
  cfg: PumpswapComboFollowConfig,
  mint: string,
  hints?: { leaderTx?: TxJsonParsed; poolHint?: string },
): Promise<FollowPoolResolveResult> {
  let poolHint = hints?.poolHint?.trim();
  if (!poolHint && hints?.leaderTx) {
    poolHint = extractPumpSwapPoolFromTx(hints.leaderTx) ?? undefined;
  }

  const pool = await resolveMintPumpPool(cfg.rpcUrl, mint, poolHint);
  if (!pool) return { pool: null, source: 'none' };

  const source = await sourceForPool(cfg, mint, pool, { ...hints, poolHint });
  return { pool, source: source === 'none' ? 'canonical_pda' : source };
}
