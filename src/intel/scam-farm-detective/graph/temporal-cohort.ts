import { sql } from 'drizzle-orm';
import type { DB } from '../../../core/db/client.js';
import type { ScamFarmGraphConfig } from './config.js';

export type TemporalHit = { wallet: string; mint: string; tminIso: string };

/**
 * Покупки в одном минутном бакете по mint (слабый сигнал; лимиты против взрыва строк).
 */
export async function queryTemporalBuyBursts(db: DB, cfg: ScamFarmGraphConfig): Promise<TemporalHit[]> {
  if (!cfg.temporalEnabled) return [];

  const h = cfg.temporalLookbackHours;
  const k = cfg.temporalMinWalletsPerMinute;
  const mintCap = cfg.temporalMintRowsCap;
  const walletCap = 8000;

  const bursts = (await db.execute(sql`
    SELECT date_trunc('minute', s.block_time) AS tmin,
           s.base_mint AS mint,
           COUNT(DISTINCT s.wallet)::int AS nw
    FROM swaps s
    WHERE s.side = 'buy'
      AND s.block_time > now() - (${h}::text || ' hours')::interval
    GROUP BY 1, 2
    HAVING COUNT(DISTINCT s.wallet) >= ${k}
    ORDER BY nw DESC
    LIMIT ${mintCap}
  `)) as unknown as Array<{ tmin: Date | string; mint: string; nw: number }>;

  if (bursts.length < 1) return [];

  const hits: TemporalHit[] = [];
  for (const b of bursts) {
    if (hits.length >= walletCap) break;
    const tminIso = typeof b.tmin === 'string' ? b.tmin : new Date(b.tmin).toISOString();
    const wallets = (await db.execute(sql`
      SELECT DISTINCT s.wallet AS wallet
      FROM swaps s
      WHERE s.side = 'buy'
        AND s.base_mint = ${b.mint}
        AND s.block_time >= ${tminIso}::timestamptz
        AND s.block_time < (${tminIso}::timestamptz + interval '1 minute')
      LIMIT 400
    `)) as unknown as Array<{ wallet: string }>;
    for (const w of wallets) {
      hits.push({ wallet: w.wallet, mint: b.mint, tminIso: tminIso });
      if (hits.length >= walletCap) break;
    }
  }

  return hits;
}
