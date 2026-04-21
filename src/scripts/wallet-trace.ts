/**
 * Wallet Trace CLI — interactive entry point into the Atlas.
 *
 * Usage:
 *   npm run wallet:trace -- <wallet>
 *   HOPS=2 FANOUT=5 npm run wallet:trace -- <wallet>
 *
 * What it does:
 *   1. Fetches Helius history (1 page = 100 txs, configurable)
 *   2. Persists profile + money_flows
 *   3. Recursively traces top funders for HOPS levels (default 1)
 *   4. Auto-tags every visited wallet
 *   5. Prints a human-readable report:
 *        - the wallet's profile
 *        - tags assigned (with confidence)
 *        - top funders / recipients
 *        - mermaid graph for paste into a visualizer
 *
 * Costs:
 *   HOPS=0 fanout=N/A   → ~150 credits  (just root wallet)
 *   HOPS=1 FANOUT=5     → ~900 credits  (root + 5 funders)
 *   HOPS=2 FANOUT=5     → ~5k credits   (root + 5 + 25)
 *   HOPS=3 FANOUT=5     → ~25k credits  (root + 5 + 25 + 125) — careful
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { traceWallet } from '../intel/wallet-tracer.js';
import { tagWallet } from '../intel/wallet-tagger.js';
import { child } from '../core/logger.js';

const log = child('wallet-trace-cli');

interface ProfileRow {
  wallet: string;
  first_tx_at: string | null;
  last_tx_at: string | null;
  tx_count: number;
  distinct_mints: number;
  distinct_counterparties: number;
  total_funded_sol: number;
  total_fee_spent_sol: number;
  primary_tag: string | null;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root || root.length < 32) {
    console.error('Usage: npm run wallet:trace -- <wallet>');
    console.error('Env:   HOPS=1 FANOUT=5 PAGES=1');
    process.exit(1);
  }

  const hops = Number(process.env.HOPS ?? '1');
  const fanout = Number(process.env.FANOUT ?? '5');
  const pages = Number(process.env.PAGES ?? '1');

  console.log(`\nTracing ${root}\n  hops=${hops} fanout=${fanout} pages=${pages}\n`);

  const tracerResult = await traceWallet(root, {
    hops,
    fanout,
    pagesPerWallet: pages,
    cacheHours: 6,
  });
  console.log(
    `Trace done: scanned=${tracerResult.walletsScanned} cached=${tracerResult.walletsCached} ` +
      `txs=${tracerResult.txsObserved} flows_inserted=${tracerResult.flowsInserted}\n`,
  );

  console.log('Auto-tagging traced wallets...');
  const allWallets = (await db.execute(
    dsql.raw(`
      SELECT DISTINCT wallet FROM (
        SELECT '${root}' AS wallet
        UNION
        SELECT source_wallet AS wallet FROM money_flows WHERE target_wallet = '${root}'
        UNION
        SELECT target_wallet AS wallet FROM money_flows WHERE source_wallet = '${root}'
      ) sub
    `),
  )) as unknown as Array<{ wallet: string }>;

  for (const r of allWallets) {
    try {
      await tagWallet(r.wallet);
    } catch (err) {
      log.warn({ wallet: r.wallet, err: String(err) }, 'tag failed');
    }
  }
  console.log(`Tagged ${allWallets.length} wallets\n`);

  // ---- Report ----
  await printProfile(root);
  await printTopFunders(root);
  await printTopRecipients(root);
  await printMermaid(root, hops);

  process.exit(0);
}

async function printProfile(wallet: string): Promise<void> {
  const rows = (await db.execute(
    dsql.raw(`
      SELECT ew.wallet, ew.first_tx_at, ew.last_tx_at, ew.tx_count, ew.distinct_mints,
             ew.distinct_counterparties, ew.total_funded_sol, ew.total_fee_spent_sol, ew.primary_tag
      FROM entity_wallets ew WHERE wallet = '${wallet}'
    `),
  )) as unknown as ProfileRow[];
  const p = rows[0];
  if (!p) {
    console.log('(no profile after trace — Helius returned nothing or all skipped as cached)');
    return;
  }

  console.log('=== PROFILE ===');
  console.log(`Wallet:           ${p.wallet}`);
  console.log(`First tx:         ${p.first_tx_at ?? '?'}`);
  console.log(`Last tx:          ${p.last_tx_at ?? '?'}`);
  console.log(`Tx count seen:    ${p.tx_count}`);
  console.log(`Distinct mints:   ${p.distinct_mints}`);
  console.log(`Counterparties:   ${p.distinct_counterparties}`);
  console.log(`Total SOL in:     ${Number(p.total_funded_sol).toFixed(2)} SOL`);
  console.log(`Fee spent:        ${Number(p.total_fee_spent_sol).toFixed(4)} SOL`);
  console.log(`Primary tag:      ${p.primary_tag ?? '(none)'}\n`);

  const tags = (await db.execute(
    dsql.raw(`
      SELECT tag, confidence, source, context, added_at
      FROM wallet_tags WHERE wallet = '${wallet}'
      ORDER BY confidence DESC
    `),
  )) as unknown as Array<{ tag: string; confidence: number; source: string; context: string | null; added_at: string }>;
  if (tags.length > 0) {
    console.log('All tags:');
    for (const t of tags) {
      console.log(`  ${t.tag.padEnd(18)} conf=${String(t.confidence).padStart(3)}  src=${t.source.padEnd(22)} ${t.context ?? ''}`);
    }
    console.log('');
  }
}

async function printTopFunders(wallet: string): Promise<void> {
  const rows = (await db.execute(
    dsql.raw(`
      SELECT mf.source_wallet AS w, SUM(mf.amount) AS total_sol, COUNT(*) AS n_txs,
             ew.primary_tag
      FROM money_flows mf
      LEFT JOIN entity_wallets ew ON ew.wallet = mf.source_wallet
      WHERE mf.target_wallet = '${wallet}' AND mf.asset = 'SOL'
      GROUP BY mf.source_wallet, ew.primary_tag
      ORDER BY total_sol DESC LIMIT 10
    `),
  )) as unknown as Array<{ w: string; total_sol: number; n_txs: number; primary_tag: string | null }>;

  console.log(`=== TOP FUNDERS (SOL into ${shortAddr(wallet)}) ===`);
  if (rows.length === 0) {
    console.log('  (no SOL inflows recorded)\n');
    return;
  }
  console.log('Funder                                              SOL          Txs  Tag');
  console.log('--------------------------------------------------  -----------  ---  ----------------');
  for (const r of rows) {
    console.log(
      `${r.w.padEnd(50)}  ${Number(r.total_sol).toFixed(2).padStart(11)}  ${String(r.n_txs).padStart(3)}  ${r.primary_tag ?? '-'}`,
    );
  }
  console.log('');
}

async function printTopRecipients(wallet: string): Promise<void> {
  const rows = (await db.execute(
    dsql.raw(`
      SELECT mf.target_wallet AS w, SUM(mf.amount) AS total_sol, COUNT(*) AS n_txs,
             ew.primary_tag
      FROM money_flows mf
      LEFT JOIN entity_wallets ew ON ew.wallet = mf.target_wallet
      WHERE mf.source_wallet = '${wallet}' AND mf.asset = 'SOL'
      GROUP BY mf.target_wallet, ew.primary_tag
      ORDER BY total_sol DESC LIMIT 10
    `),
  )) as unknown as Array<{ w: string; total_sol: number; n_txs: number; primary_tag: string | null }>;

  console.log(`=== TOP RECIPIENTS (SOL out of ${shortAddr(wallet)}) ===`);
  if (rows.length === 0) {
    console.log('  (no SOL outflows recorded)\n');
    return;
  }
  console.log('Recipient                                           SOL          Txs  Tag');
  console.log('--------------------------------------------------  -----------  ---  ----------------');
  for (const r of rows) {
    console.log(
      `${r.w.padEnd(50)}  ${Number(r.total_sol).toFixed(2).padStart(11)}  ${String(r.n_txs).padStart(3)}  ${r.primary_tag ?? '-'}`,
    );
  }
  console.log('');
}

async function printMermaid(root: string, hops: number): Promise<void> {
  // Pull all flows touching the root or wallets within `hops` of root.
  // For visual clarity we cap to top-N edges per wallet.
  const flows = (await db.execute(
    dsql.raw(`
      WITH RECURSIVE neighborhood(w, depth) AS (
        SELECT '${root}', 0
        UNION ALL
        SELECT mf.source_wallet, depth+1
        FROM money_flows mf JOIN neighborhood n ON mf.target_wallet = n.w
        WHERE depth < ${hops} AND mf.asset='SOL'
        UNION ALL
        SELECT mf.target_wallet, depth+1
        FROM money_flows mf JOIN neighborhood n ON mf.source_wallet = n.w
        WHERE depth < ${hops} AND mf.asset='SOL'
      ),
      uniq AS (SELECT DISTINCT w FROM neighborhood),
      ranked AS (
        SELECT mf.source_wallet, mf.target_wallet, SUM(mf.amount) AS sol, COUNT(*) AS n
        FROM money_flows mf
        WHERE mf.asset='SOL'
          AND mf.source_wallet IN (SELECT w FROM uniq)
          AND mf.target_wallet IN (SELECT w FROM uniq)
        GROUP BY mf.source_wallet, mf.target_wallet
        ORDER BY sol DESC LIMIT 60
      )
      SELECT * FROM ranked
    `),
  )) as unknown as Array<{ source_wallet: string; target_wallet: string; sol: number; n: number }>;

  // Pull tags for all involved wallets so we color them
  const wallets = new Set<string>();
  for (const e of flows) {
    wallets.add(e.source_wallet);
    wallets.add(e.target_wallet);
  }
  if (wallets.size === 0) {
    console.log('=== MERMAID GRAPH ===\n(no edges found; raise HOPS or check wallet activity)\n');
    return;
  }
  const list = [...wallets].map((w) => `'${w}'`).join(',');
  const tagRows = (await db.execute(
    dsql.raw(`SELECT wallet, primary_tag FROM entity_wallets WHERE wallet IN (${list})`),
  )) as unknown as Array<{ wallet: string; primary_tag: string | null }>;
  const tagMap = new Map(tagRows.map((r) => [r.wallet, r.primary_tag]));

  const colorOf = (tag: string | null | undefined): string => {
    switch (tag) {
      case 'cex_hot_wallet': return 'fill:#bbb';
      case 'scam_operator': return 'fill:#f88';
      case 'scam_proxy': return 'fill:#fbb';
      case 'sniper': return 'fill:#fa8';
      case 'mev_bot': return 'fill:#fc8';
      case 'smart_money': return 'fill:#8f8';
      case 'rotation_node': return 'fill:#fdc';
      case 'retail': return 'fill:#ddf';
      case 'inactive': return 'fill:#eee';
      default: return 'fill:#fff';
    }
  };

  const nodeId = (w: string): string => `n${w.slice(0, 8)}`;
  console.log('=== MERMAID GRAPH ===');
  console.log('Paste at https://mermaid.live or any Markdown renderer:\n');
  console.log('```mermaid');
  console.log('flowchart LR');
  for (const w of wallets) {
    const tag = tagMap.get(w);
    const isRoot = w === root ? '🎯 ' : '';
    console.log(`  ${nodeId(w)}["${isRoot}${shortAddr(w)}<br/>${tag ?? ''}"]:::${nodeId(w)}_cls`);
    console.log(`  classDef ${nodeId(w)}_cls ${colorOf(tag)}`);
  }
  for (const e of flows) {
    const label = `${e.sol.toFixed(1)}◎`;
    console.log(`  ${nodeId(e.source_wallet)} -- "${label}" --> ${nodeId(e.target_wallet)}`);
  }
  console.log('```\n');
}

main().catch((err) => {
  log.error({ err: String(err) }, 'wallet-trace failed');
  process.exit(1);
});
