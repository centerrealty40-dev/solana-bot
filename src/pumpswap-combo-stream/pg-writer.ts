import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PumpSwapStreamSnapshot } from './decode-snapshot.js';

function minuteBucket(tsMs: number): Date {
  return new Date(Math.floor(tsMs / 60_000) * 60_000);
}

export async function upsertPumpSwapStreamSnapshot(args: {
  snap: PumpSwapStreamSnapshot;
  source: string;
}): Promise<void> {
  const { snap, source } = args;
  const ts = minuteBucket(snap.blockTimeMs);
  const mintEsc = snap.baseMint.replace(/'/g, "''");
  const poolEsc = snap.pairAddress.replace(/'/g, "''");
  const quoteEsc = snap.quoteMint.replace(/'/g, "''");
  const sourceEsc = source.replace(/'/g, "''");

  await db.execute(dsql.raw(`
    INSERT INTO pumpswap_pair_snapshots (
      ts, source, pair_address, base_mint, quote_mint, price_usd
    ) VALUES (
      '${ts.toISOString()}', '${sourceEsc}', '${poolEsc}', '${mintEsc}', '${quoteEsc}', ${snap.priceUsd}
    )
    ON CONFLICT (pair_address, ts) DO UPDATE SET
      source = EXCLUDED.source, base_mint = EXCLUDED.base_mint, quote_mint = EXCLUDED.quote_mint,
      price_usd = EXCLUDED.price_usd
    WHERE EXCLUDED.price_usd > 0
  `));

  await db.execute(dsql.raw(`
    INSERT INTO pumpswap_pair_snapshots (
      ts, source, pair_address, base_mint, quote_mint, price_usd
    ) VALUES (
      to_timestamp(${snap.blockTimeMs / 1000}), '${sourceEsc}-tick',
      '${poolEsc}', '${mintEsc}', '${quoteEsc}', ${snap.priceUsd}
    )
    ON CONFLICT (pair_address, ts) DO UPDATE SET price_usd = EXCLUDED.price_usd
    WHERE EXCLUDED.price_usd > 0
  `));
}

export async function countRecentStreamSnapshots(source: string, lookbackMin: number): Promise<number> {
  const r = await db.execute(dsql.raw(`
    SELECT COUNT(*)::int AS n FROM pumpswap_pair_snapshots
    WHERE source LIKE '${source.replace(/'/g, "''")}%'
      AND ts >= now() - interval '${Math.max(1, lookbackMin)} minutes'
  `));
  return Number((r as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}
