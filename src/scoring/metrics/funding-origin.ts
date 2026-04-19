import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';

/**
 * `funding_origin_age_days` — days since the wallet was first seen on-chain
 * (a proxy for "how mature is this wallet"). Newer wallets are more suspicious.
 *
 * Implementation: we use min(swaps.block_time) as a proxy for first activity, since
 * we don't have account-creation timestamps without a separate RPC call.
 *
 * For wallets where we know `funding_source` and `funding_ts`, we'd use that instead.
 */
export async function computeFundingOriginAge(
  wallets: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (wallets.length === 0) return map;
  const rows = await db.execute(dsql`
    SELECT
      wallet,
      MIN(block_time) AS first_ts
    FROM swaps
    WHERE wallet = ANY(${dsql.raw(arrayLiteral(wallets))})
    GROUP BY wallet
  `);
  const now = Date.now();
  for (const row of rows as unknown as Array<{ wallet: string; first_ts: Date | string }>) {
    const ts = new Date(row.first_ts as string | Date).getTime();
    const days = (now - ts) / 86_400_000;
    map.set(row.wallet, days);
  }

  // Override with explicit funding_ts where available
  const wRows = await db
    .select({ address: schema.wallets.address, fundingTs: schema.wallets.fundingTs })
    .from(schema.wallets)
    .where(dsql`${schema.wallets.address} = ANY(${dsql.raw(arrayLiteral(wallets))})`);
  for (const r of wRows) {
    if (r.fundingTs) {
      const days = (now - r.fundingTs.getTime()) / 86_400_000;
      map.set(r.address, days);
    }
  }
  return map;
}

function arrayLiteral(values: string[]): string {
  return `ARRAY[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::varchar[]`;
}
