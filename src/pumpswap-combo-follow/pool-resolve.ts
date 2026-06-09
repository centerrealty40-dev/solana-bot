import type { TxJsonParsed } from '../parser/rpc-http.js';
import { extractPumpSwapPoolFromTx } from '../parser/allowlisted-dex-swap.js';
import { resolveMintWsolPumpPool, verifyTradablePumpPool } from '../pumpswap-combo/pool-resolve.js';
import { fetchMintPoolAddress } from '../pumpswap-combo/watchlist.js';
import type { PumpswapComboFollowConfig } from './config.js';

export type FollowPoolResolveSource =
  | 'leader_hint'
  | 'leader_tx'
  | 'leader_usdc_skipped'
  | 'pg_snapshot'
  | 'canonical_pda'
  | 'none';

export type FollowPoolResolveResult = {
  pool: string | null;
  source: FollowPoolResolveSource;
  /** When leader traded USDC pool — address we ignored. */
  leaderUsdcPool?: string;
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
  if (await verifyTradablePumpPool(cfg.rpcUrl, pool)) return 'canonical_pda';
  return 'none';
}

/** Resolve WSOL-quoted PumpSwap pool — if leader used USDC pool, pick SOL pool for same mint. */
export async function resolveFollowPoolAddress(
  cfg: PumpswapComboFollowConfig,
  mint: string,
  hints?: { leaderTx?: TxJsonParsed; poolHint?: string },
): Promise<FollowPoolResolveResult> {
  let poolHint = hints?.poolHint?.trim();
  if (!poolHint && hints?.leaderTx) {
    poolHint = extractPumpSwapPoolFromTx(hints.leaderTx) ?? undefined;
  }

  const resolved = await resolveMintWsolPumpPool(cfg.rpcUrl, mint, poolHint);
  if (!resolved.pool) {
    return {
      pool: null,
      source: 'none',
      leaderUsdcPool: resolved.skippedUsdcHint,
    };
  }

  let source = await sourceForPool(cfg, mint, resolved.pool, { ...hints, poolHint });
  if (source === 'none') source = 'canonical_pda';

  if (resolved.skippedUsdcHint && resolved.pool !== resolved.skippedUsdcHint) {
    if (source === 'leader_hint' || source === 'leader_tx') {
      source = 'leader_usdc_skipped';
    }
  }

  return {
    pool: resolved.pool,
    source,
    leaderUsdcPool: resolved.skippedUsdcHint,
  };
}
