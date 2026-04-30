import { sql } from 'drizzle-orm';
import type { AtlasTx } from './cursor.js';
import { sqlSwapIds } from './sql-ids.js';

const SOURCE = 'sa-atlas';

function conflictUpdate(): ReturnType<typeof sql> {
  return sql`
    ON CONFLICT (wallet, tag, source) DO UPDATE SET
      confidence = EXCLUDED.confidence,
      added_at = now(),
      context = EXCLUDED.context
  `;
}

/** Activity tags for wallets touched by this batch; window rolling via swaps.created_at. */
export async function applyActivityTags(tx: AtlasTx, ids: bigint[], windowHours: number): Promise<void> {
  const frag = sqlSwapIds(ids);
  if (!frag) return;

  const h = Math.max(1, Math.floor(windowHours));

  await tx.execute(sql`
    INSERT INTO wallet_tags (wallet, tag, confidence, source, context, added_at)
    SELECT sub.wallet, 'pump_active', 70, ${SOURCE},
      'window=' || ${String(h)} || 'h|n=' || sub.n::text,
      now()
    FROM (
      SELECT s2.wallet, count(*)::int AS n
      FROM swaps s2
      WHERE s2.wallet IN (SELECT DISTINCT wallet FROM swaps WHERE id IN (${frag}))
        AND s2.created_at > now() - make_interval(hours => ${h})
        AND s2.dex = 'pumpfun'
      GROUP BY s2.wallet
      HAVING count(*) >= 10
    ) sub
    ${conflictUpdate()}
  `);

  await tx.execute(sql`
    INSERT INTO wallet_tags (wallet, tag, confidence, source, context, added_at)
    SELECT sub.wallet, 'pump_buyer', 70, ${SOURCE},
      'window=' || ${String(h)} || 'h|buys=' || sub.n::text,
      now()
    FROM (
      SELECT s2.wallet, count(*)::int AS n
      FROM swaps s2
      WHERE s2.wallet IN (SELECT DISTINCT wallet FROM swaps WHERE id IN (${frag}))
        AND s2.created_at > now() - make_interval(hours => ${h})
        AND s2.dex = 'pumpfun'
        AND s2.side = 'buy'
      GROUP BY s2.wallet
      HAVING count(*) >= 3
    ) sub
    ${conflictUpdate()}
  `);

  await tx.execute(sql`
    INSERT INTO wallet_tags (wallet, tag, confidence, source, context, added_at)
    SELECT sub.wallet, 'pump_seller', 70, ${SOURCE},
      'window=' || ${String(h)} || 'h|sells=' || sub.n::text,
      now()
    FROM (
      SELECT s2.wallet, count(*)::int AS n
      FROM swaps s2
      WHERE s2.wallet IN (SELECT DISTINCT wallet FROM swaps WHERE id IN (${frag}))
        AND s2.created_at > now() - make_interval(hours => ${h})
        AND s2.dex = 'pumpfun'
        AND s2.side = 'sell'
      GROUP BY s2.wallet
      HAVING count(*) >= 3
    ) sub
    ${conflictUpdate()}
  `);

  await tx.execute(sql`
    INSERT INTO wallet_tags (wallet, tag, confidence, source, context, added_at)
    SELECT DISTINCT s2.wallet, 'pump_high_roller', 70, ${SOURCE},
      'window=' || ${String(h)} || 'h|amount_usd>=1000',
      now()
    FROM swaps s2
    WHERE s2.wallet IN (SELECT DISTINCT wallet FROM swaps WHERE id IN (${frag}))
      AND s2.created_at > now() - make_interval(hours => ${h})
      AND s2.dex = 'pumpfun'
      AND s2.amount_usd >= 1000
    ${conflictUpdate()}
  `);

  await tx.execute(sql`
    INSERT INTO wallet_tags (wallet, tag, confidence, source, context, added_at)
    SELECT DISTINCT ON (s.wallet)
      s.wallet,
      'pump_first_buyer',
      70,
      ${SOURCE},
      'mint=' || s.base_mint || '|within30sOfFirstSeen',
      now()
    FROM swaps s
    JOIN tokens t ON t.mint = s.base_mint
    WHERE s.id IN (${frag})
      AND s.side = 'buy'
      AND s.dex = 'pumpfun'
      AND s.block_time <= t.first_seen_at + interval '30 seconds'
    ORDER BY s.wallet, s.block_time ASC
    ${conflictUpdate()}
  `);
}
