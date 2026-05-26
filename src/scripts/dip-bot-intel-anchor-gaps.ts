/**
 * Lists anchor mints where dip_bot intel saw zero aggregated buyers (Postgres `swaps` gap vs anchor window).
 * Use the output to drive sigseed / swap backfill (see deploy/RUNTIME.md W9.0).
 */
import { sql } from '../core/db/client.js';

async function main(): Promise<void> {
  const rows = await sql<{ anchor_mint: string; ct: string }[]>`
    SELECT anchor_mint::text, COUNT(*)::text AS ct
    FROM dip_bot_intel_anchors_processed
    WHERE buyer_rows = 0
    GROUP BY anchor_mint
    ORDER BY COUNT(*) DESC, anchor_mint ASC
  `;
  const mints = rows.map((r) => r.anchor_mint);
  console.log(
    JSON.stringify(
      {
        ok: true,
        distinctMintsWithOnlyZeroBuyerAnchors: mints.length,
        mints,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('[dip-bot-intel:anchor-gaps] fatal', e);
  process.exit(1);
});
