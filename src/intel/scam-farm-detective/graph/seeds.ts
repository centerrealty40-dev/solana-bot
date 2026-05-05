import { sql } from 'drizzle-orm';
import type { DB } from '../../../core/db/client.js';
import type { ScamFarmGraphConfig } from './config.js';

/**
 * Seed wallets: Atlas tags от фазы A + участники и funders из scam_farm_candidates.
 */
export async function loadSeedWalletAddresses(db: DB, c: ScamFarmGraphConfig): Promise<string[]> {
  const cap = c.seedCap;
  const rows = (await db.execute(sql`
    SELECT DISTINCT wallet FROM (
      SELECT wt.wallet AS wallet
      FROM wallet_tags wt
      WHERE wt.source = 'scam_farm_detective'
        AND wt.tag IN ('scam_operator', 'scam_proxy')
      UNION
      SELECT pt.val AS wallet
      FROM scam_farm_candidates sf,
           LATERAL jsonb_array_elements_text(COALESCE(sf.participant_wallets, '[]'::jsonb)) AS pt(val)
      WHERE jsonb_array_length(COALESCE(sf.participant_wallets, '[]'::jsonb)) > 0
      UNION
      SELECT sf.funder AS wallet
      FROM scam_farm_candidates sf
      WHERE sf.funder IS NOT NULL AND length(trim(sf.funder)) >= 32
    ) x
    WHERE wallet IS NOT NULL AND length(wallet) >= 32 AND length(wallet) <= 64
    LIMIT ${cap}
  `)) as unknown as Array<{ wallet: string }>;

  return rows.map((r) => r.wallet).filter(Boolean);
}
