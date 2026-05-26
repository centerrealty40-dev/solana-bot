/**
 * Export wallets seen in dip_bot intel observations (max recall list for manual review).
 *
 *   npm run dip-bot-intel:export-candidates
 *   npm run dip-bot-intel:export-candidates -- --csv
 *   npm run dip-bot-intel:export-candidates -- --detail
 */
import { sql } from '../core/db/client.js';
import { DIP_BOT_TAG, DIP_BOT_TAG_SOURCE } from '../intel/dip-bot-intel.js';

type Row = {
  wallet: string;
  observation_rows: string;
  distinct_anchors: string;
  sum_buy_usd: string;
  tagged: boolean | null;
  tag_confidence: string | null;
};

async function main(): Promise<void> {
  const csv = process.argv.includes('--csv');
  const detail = process.argv.includes('--detail');

  const rows = await sql<Row[]>`
    SELECT o.wallet::text,
           COUNT(*)::text AS observation_rows,
           COUNT(DISTINCT (o.anchor_mint, o.anchor_entry_ts_ms))::text AS distinct_anchors,
           COALESCE(SUM(o.buy_usd), 0)::text AS sum_buy_usd,
           bool_or(wt.wallet IS NOT NULL) AS tagged,
           MAX(wt.confidence)::text AS tag_confidence
    FROM dip_bot_intel_observations o
    LEFT JOIN wallet_tags wt
      ON wt.wallet = o.wallet AND wt.tag = ${DIP_BOT_TAG} AND wt.source = ${DIP_BOT_TAG_SOURCE}
    GROUP BY o.wallet
    ORDER BY COUNT(*) DESC,
             COALESCE(SUM(o.buy_usd), 0) DESC,
             o.wallet ASC
  `;

  type OutWallet = {
    wallet: string;
    observationRows: number;
    distinctAnchors: number;
    sumBuyUsd: number;
    tagged: boolean;
    tagConfidence: number | null;
    anchorMintsSample?: string[];
  };

  const out: { exportedAt: number; walletCount: number; wallets: OutWallet[] } = {
    exportedAt: Date.now(),
    walletCount: rows.length,
    wallets: [],
  };

  for (const r of rows) {
    const w = String(r.wallet || '').trim();
    if (!w) continue;
    const item: OutWallet = {
      wallet: w,
      observationRows: Number(r.observation_rows),
      distinctAnchors: Number(r.distinct_anchors),
      sumBuyUsd: Number(r.sum_buy_usd),
      tagged: Boolean(r.tagged),
      tagConfidence: r.tag_confidence != null ? Number(r.tag_confidence) : null,
    };

    if (detail) {
      const mints = await sql<{ m: string }[]>`
        SELECT DISTINCT anchor_mint::text AS m
        FROM dip_bot_intel_observations
        WHERE wallet = ${w}
        ORDER BY anchor_mint ASC
        LIMIT 80
      `;
      item.anchorMintsSample = mints.map((x) => x.m).filter(Boolean);
    }

    out.wallets.push(item);
  }

  if (csv) {
    console.log(
      'wallet,observation_rows,distinct_anchors,sum_buy_usd,tagged,tag_confidence',
    );
    for (const x of out.wallets) {
      console.log(
        [
          x.wallet,
          x.observationRows,
          x.distinctAnchors,
          x.sumBuyUsd.toFixed(4),
          x.tagged ? '1' : '0',
          x.tagConfidence ?? '',
        ].join(','),
      );
    }
    return;
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error('[dip-bot-intel:export-candidates] fatal', e);
  process.exit(1);
});
