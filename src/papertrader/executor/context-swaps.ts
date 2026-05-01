import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { ContextSwap } from '../types.js';

export async function fetchContextSwaps(
  cfg: PaperTraderConfig,
  mint: string,
  beforeTs: number,
): Promise<ContextSwap[]> {
  if (!cfg.contextSwapsEnabled) return [];
  try {
    const safeMint = mint.replace(/'/g, "''");
    const beforeIso = new Date(beforeTs).toISOString();
    const limit = Math.max(1, Math.min(50, cfg.contextSwapsLimit));
    const r = await db.execute(dsql.raw(`
      SELECT block_time AS ts, side, amount_usd::float AS amount_usd, price_usd::float AS price_usd, wallet
      FROM swaps
      WHERE base_mint = '${safeMint}'
        AND block_time <= '${beforeIso}'::timestamptz
      ORDER BY block_time DESC
      LIMIT ${limit}
    `));
    const rows = r as unknown as Array<{
      ts: unknown;
      side: unknown;
      amount_usd: unknown;
      price_usd: unknown;
      wallet?: unknown;
    }>;
    return rows
      .map((row) => ({
        ts: new Date(String(row.ts)).getTime(),
        side: String(row.side ?? ''),
        amount_usd: Number(row.amount_usd ?? 0),
        price_usd: Number(row.price_usd ?? 0),
        wallet: row.wallet ? `${String(row.wallet).slice(0, 6)}...${String(row.wallet).slice(-4)}` : undefined,
      }))
      .reverse();
  } catch (err) {
    console.warn(`fetchContextSwaps failed for ${mint}: ${(err as Error).message}`);
    return [];
  }
}
