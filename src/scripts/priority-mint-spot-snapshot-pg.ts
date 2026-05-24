/**
 * Persist 10s priority mint spot snapshots to Postgres (point A).
 */
import { sql as pgSql } from '../core/db/client.js';

export type PriorityMintSpotSnapshotRow = {
  mint: string;
  pairAddress: string | null;
  priceUsd: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  source: string;
  tsMs: number;
};

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

function bucket10s(tsMs: number): Date {
  const floored = Math.floor(tsMs / 10_000) * 10_000;
  return new Date(floored);
}

export function priorityMintSpotPgEnabled(): boolean {
  return envBool('PRIORITY_MINT_SPOT_PG_ENABLED', true);
}

export async function upsertPriorityMintSpotSnapshots(rows: PriorityMintSpotSnapshotRow[]): Promise<number> {
  if (!priorityMintSpotPgEnabled() || rows.length === 0) return 0;

  let written = 0;
  for (const row of rows) {
    if (!(row.priceUsd > 0) || row.mint.length < 32) continue;
    const ts = bucket10s(row.tsMs);
    const mint = row.mint.trim();
    const pair = row.pairAddress?.trim() || null;
    try {
      await pgSql`
        INSERT INTO priority_mint_spot_snapshots (
          ts, base_mint, pair_address, price_usd, market_cap_usd, liquidity_usd, source
        ) VALUES (
          ${ts}, ${mint}, ${pair}, ${row.priceUsd}, ${row.marketCapUsd}, ${row.liquidityUsd}, ${row.source}
        )
        ON CONFLICT (base_mint, ts) DO UPDATE SET
          pair_address = EXCLUDED.pair_address,
          price_usd = EXCLUDED.price_usd,
          market_cap_usd = EXCLUDED.market_cap_usd,
          liquidity_usd = EXCLUDED.liquidity_usd,
          source = EXCLUDED.source
      `;
      written += 1;
    } catch {
      /* table may not exist until migrate */
    }
  }
  return written;
}
