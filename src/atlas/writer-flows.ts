import { sql } from 'drizzle-orm';
import type { AtlasTx } from './cursor.js';
import { sqlSwapIds } from './sql-ids.js';

/** Synthetic legs: buy wallet→pump:<mint>, sell pump:<mint>→wallet; amount = quote SOL human. */
export async function writePumpMoneyFlows(tx: AtlasTx, ids: bigint[]): Promise<void> {
  const frag = sqlSwapIds(ids);
  if (!frag) return;

  await tx.execute(sql`
    INSERT INTO money_flows (source_wallet, target_wallet, asset, amount, tx_time, signature, observed_at)
    SELECT
      CASE WHEN side = 'buy' THEN wallet ELSE ('pump:' || base_mint) END,
      CASE WHEN side = 'buy' THEN ('pump:' || base_mint) ELSE wallet END,
      'SOL',
      (quote_amount_raw::numeric / 1000000000)::double precision,
      block_time,
      signature,
      now()
    FROM swaps
    WHERE id IN (${frag})
      AND dex = 'pumpfun'
    ON CONFLICT (signature, source_wallet, target_wallet, asset) DO NOTHING
  `);
}
