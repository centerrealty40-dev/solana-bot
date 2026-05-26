/**
 * Set-based enrich from a batch of swap ids (idempotent per atlas cursor).
 * TODO(W5.1): exact distinct_mints / distinct_counterparties via hourly re-aggregate over swaps.
 */
import { sql } from 'drizzle-orm';
import type { AtlasTx } from './cursor.js';
import { sqlSwapIds } from './sql-ids.js';

export async function enrichTokens(tx: AtlasTx, ids: bigint[]): Promise<void> {
  const frag = sqlSwapIds(ids);
  if (!frag) return;

  await tx.execute(sql`
    INSERT INTO tokens (mint, first_seen_at, updated_at, metadata)
    SELECT base_mint, min(block_time), now(), '{}'::jsonb
    FROM swaps
    WHERE id IN (${frag})
    GROUP BY base_mint
    ON CONFLICT (mint) DO UPDATE SET
      first_seen_at = LEAST(tokens.first_seen_at, EXCLUDED.first_seen_at),
      updated_at = now()
  `);
}

export async function enrichEntityWallets(tx: AtlasTx, ids: bigint[]): Promise<void> {
  const frag = sqlSwapIds(ids);
  if (!frag) return;

  await tx.execute(sql`
    INSERT INTO entity_wallets (
      wallet,
      first_tx_at,
      last_tx_at,
      tx_count,
      distinct_mints,
      profile_updated_at
    )
    SELECT
      wallet,
      min(block_time),
      max(block_time),
      count(DISTINCT signature)::int,
      count(DISTINCT base_mint)::int,
      now()
    FROM swaps
    WHERE id IN (${frag})
    GROUP BY wallet
    ON CONFLICT (wallet) DO UPDATE SET
      first_tx_at = LEAST(COALESCE(entity_wallets.first_tx_at, EXCLUDED.first_tx_at), EXCLUDED.first_tx_at),
      last_tx_at = GREATEST(COALESCE(entity_wallets.last_tx_at, EXCLUDED.last_tx_at), EXCLUDED.last_tx_at),
      tx_count = entity_wallets.tx_count + EXCLUDED.tx_count,
      distinct_mints = GREATEST(entity_wallets.distinct_mints, EXCLUDED.distinct_mints),
      profile_updated_at = now()
  `);
}
