/**
 * W9.0 — обязательная приёмка: пересечение якорных mint (dip_bot_intel_anchors_processed)
 * с наличием строк в `swaps` (side=buy). Без этого v1 джоба даёт нулевой сигнал.
 */
import { sql } from '../core/db/client.js';

type CoverageRow = {
  distinct_anchor_mints: string;
  mints_with_zero_swaps_buys: string;
  mints_with_swaps_buys: string;
};

async function main(): Promise<void> {
  const summary = await sql<CoverageRow[]>`
    WITH m AS (
      SELECT DISTINCT anchor_mint FROM dip_bot_intel_anchors_processed
    ),
    c AS (
      SELECT
        m.anchor_mint,
        (SELECT COUNT(*)::bigint FROM swaps s WHERE s.base_mint = m.anchor_mint AND s.side = 'buy')::bigint AS buy_rows
      FROM m
    )
    SELECT
      COUNT(*)::text AS distinct_anchor_mints,
      COUNT(*) FILTER (WHERE buy_rows = 0)::text AS mints_with_zero_swaps_buys,
      COUNT(*) FILTER (WHERE buy_rows > 0)::text AS mints_with_swaps_buys
    FROM c
  `;

  const obs = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM dip_bot_intel_observations
  `;
  const tagged = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM wallet_tags WHERE tag = 'dip_bot' AND source = 'dip_bot_intel'
  `;

  const s = summary[0];
  const distinct = Number(s?.distinct_anchor_mints ?? 0);
  const zero = Number(s?.mints_with_zero_swaps_buys ?? 0);
  const ok = Number(s?.mints_with_swaps_buys ?? 0);
  const obsN = Number(obs[0]?.c ?? 0);
  const tagN = Number(tagged[0]?.c ?? 0);

  const samples = await sql<{ anchor_mint: string; buy_rows: string }[]>`
    WITH m AS (
      SELECT DISTINCT anchor_mint FROM dip_bot_intel_anchors_processed
    ),
    c AS (
      SELECT
        m.anchor_mint,
        (SELECT COUNT(*)::bigint FROM swaps s WHERE s.base_mint = m.anchor_mint AND s.side = 'buy')::text AS buy_rows
      FROM m
    )
    SELECT anchor_mint, buy_rows FROM c ORDER BY buy_rows::bigint ASC, anchor_mint ASC LIMIT 12
  `;

  const out = {
    ok: true,
    distinctAnchorMints: distinct,
    mintsWithZeroSwapsBuyRows: zero,
    mintsWithSwapsBuyRows: ok,
    dipBotIntelObservations: obsN,
    walletTagsDipBotIntel: tagN,
    sampleMintSwapBuyCounts: samples.map((r) => ({
      mint: r.anchor_mint,
      swapsBuyRows: Number(r.buy_rows),
    })),
    verdict:
      distinct === 0
        ? 'no_anchors_yet'
        : zero === distinct
          ? 'non_functional_v1_all_anchor_mints_missing_swaps_buys'
          : ok === 0
            ? 'unexpected_ok_zero'
            : 'partial_or_full_swap_coverage',
    explanation:
      'v1 dip_bot intel reads only Postgres `swaps`. If every anchor mint has 0 buy rows in `swaps`, ' +
      'the job marks anchors processed but produces 0 observations and 0 tags — not a silent success.',
  };

  console.log(JSON.stringify(out, null, 2));

  if (distinct > 0 && zero === distinct) {
    console.error(
      '[dip-bot-intel:coverage] FAIL: product v1 cannot produce signal — extend ingest to these mints/DEX, ' +
        'or change anchor source / add RPC path (future). Run analytics on ingest pipeline for anchor_mint list.',
    );
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('[dip-bot-intel:coverage] fatal', e);
  process.exit(1);
});
