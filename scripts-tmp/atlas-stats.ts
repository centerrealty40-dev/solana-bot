/**
 * Atlas Stats — re-runnable обзор состояния Wallet Atlas.
 *
 * Что показывает:
 *   1. Размер: entity_wallets, money_flows, wallet_tags, wallet_clusters
 *   2. Топ-30 хабов по числу контрагентов
 *   3. Топ-30 super-funders (рассылают SOL во много кошельков)
 *   4. Распределение по primary_tag
 *   5. Activity heatmap последних 24 часов по money_flows
 *   6. Wallets с >=K mints — потенциальные диверсифицированные трейдеры
 *   7. "Recipient hubs" — кто получает SOL от многих источников
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

async function rows(q: any): Promise<any[]> {
  const r: any = await db.execute(q);
  if (Array.isArray(r)) return r;
  return r.rows ?? [];
}
async function scalar(q: any, key = 'n'): Promise<number> {
  const r = await rows(q);
  return Number(r[0]?.[key] ?? 0);
}

async function main() {
  console.log(`\n=== Wallet Atlas — состояние сети ===\n`);

  // 1. Размер
  const wallets = await scalar(dsql`SELECT COUNT(*)::int AS n FROM entity_wallets`);
  const walletsActive = await scalar(dsql`SELECT COUNT(*)::int AS n FROM entity_wallets WHERE tx_count > 0`);
  const flows = await scalar(dsql`SELECT COUNT(*)::int AS n FROM money_flows`);
  const tags = await scalar(dsql`SELECT COUNT(*)::int AS n FROM wallet_tags`);
  const taggedWallets = await scalar(dsql`SELECT COUNT(DISTINCT wallet)::int AS n FROM wallet_tags`);
  const clusters = await scalar(dsql`SELECT COUNT(*)::int AS n FROM wallet_clusters`);
  console.log(`РАЗМЕР АТЛАСА:`);
  console.log(`  entity_wallets:  ${wallets.toLocaleString()}  (с tx_count>0: ${walletsActive.toLocaleString()})`);
  console.log(`  money_flows:     ${flows.toLocaleString()}`);
  console.log(`  wallet_tags:     ${tags.toLocaleString()}  (uniq wallets: ${taggedWallets.toLocaleString()})`);
  console.log(`  wallet_clusters: ${clusters.toLocaleString()}`);

  // 2. Топ-30 хабов по числу контрагентов
  console.log(`\nТОП-30 ХАБОВ (по числу разных контрагентов):`);
  const hubs = await rows(dsql`
    SELECT wallet, distinct_counterparties, distinct_mints, tx_count,
           COALESCE(primary_tag, '-') AS tag
    FROM entity_wallets
    WHERE tx_count > 0 AND distinct_counterparties >= 5
    ORDER BY distinct_counterparties DESC
    LIMIT 30
  `);
  for (const r of hubs) {
    console.log(
      `  ${r.wallet}  cps=${String(r.distinct_counterparties).padStart(4)}  mints=${String(r.distinct_mints).padStart(3)}  txs=${String(r.tx_count).padStart(4)}  tag=${r.tag}`,
    );
  }

  // 3. Super-funders
  console.log(`\nТОП-30 SUPER-FUNDERS (SOL → много recipients):`);
  const funders = await rows(dsql`
    SELECT source_wallet,
           COUNT(DISTINCT target_wallet)::int AS recipients,
           SUM(amount)::float AS total_sol,
           AVG(amount)::float AS avg_sol,
           MIN(tx_time) AS first_tx,
           MAX(tx_time) AS last_tx
    FROM money_flows
    WHERE asset = 'SOL' AND amount > 0.01
    GROUP BY source_wallet
    HAVING COUNT(DISTINCT target_wallet) >= 5
    ORDER BY recipients DESC
    LIMIT 30
  `);
  for (const r of funders) {
    console.log(
      `  ${r.source_wallet}  recipients=${String(r.recipients).padStart(4)}  total=${Number(r.total_sol).toFixed(2)} SOL  avg=${Number(r.avg_sol).toFixed(3)}  active ${String(r.first_tx).slice(0,10)}..${String(r.last_tx).slice(0,10)}`,
    );
  }

  // 4. "Recipient hubs" — кто принимает SOL от многих
  console.log(`\nТОП-20 RECIPIENT HUBS (получают SOL от >=5 источников):`);
  const recipients = await rows(dsql`
    SELECT target_wallet,
           COUNT(DISTINCT source_wallet)::int AS sources,
           SUM(amount)::float AS total_sol
    FROM money_flows
    WHERE asset = 'SOL' AND amount > 0.01
    GROUP BY target_wallet
    HAVING COUNT(DISTINCT source_wallet) >= 5
    ORDER BY sources DESC
    LIMIT 20
  `);
  for (const r of recipients) {
    console.log(
      `  ${r.target_wallet}  sources=${String(r.sources).padStart(3)}  total=${Number(r.total_sol).toFixed(2)} SOL`,
    );
  }

  // 5. Распределение по primary_tag
  console.log(`\nРАСПРЕДЕЛЕНИЕ ПО PRIMARY TAG:`);
  const byTag = await rows(dsql`
    SELECT COALESCE(primary_tag, '(no tag)') AS tag, COUNT(*)::int AS n
    FROM entity_wallets
    GROUP BY primary_tag
    ORDER BY n DESC
  `);
  for (const r of byTag) {
    console.log(`  ${r.tag.padEnd(20)} ${String(r.n).padStart(6)}`);
  }

  // 6. Распределение по числу tx (активность)
  console.log(`\nАКТИВНОСТЬ (tx_count buckets):`);
  const buckets = await rows(dsql`
    SELECT
      CASE
        WHEN tx_count = 0 THEN '0 (stub)'
        WHEN tx_count < 10 THEN '1-9'
        WHEN tx_count < 50 THEN '10-49'
        WHEN tx_count < 100 THEN '50-99'
        ELSE '100+'
      END AS bucket,
      COUNT(*)::int AS n
    FROM entity_wallets
    GROUP BY 1
    ORDER BY MIN(tx_count)
  `);
  for (const r of buckets) {
    console.log(`  ${r.bucket.padEnd(10)} ${String(r.n).padStart(6)}`);
  }

  // 7. Money flows volume распределение
  console.log(`\nMONEY FLOWS (за всё время):`);
  const flowsStats = await rows(dsql`
    SELECT asset,
           COUNT(*)::int AS n,
           SUM(amount)::float AS total
    FROM money_flows
    GROUP BY asset
    ORDER BY n DESC
    LIMIT 10
  `);
  for (const r of flowsStats) {
    const a = String(r.asset).slice(0, 12);
    console.log(`  asset=${a.padEnd(13)} edges=${String(r.n).padStart(6)}  sum=${Number(r.total).toFixed(2)}`);
  }

  // 8. Активность последних 24 часов
  console.log(`\nАКТИВНОСТЬ ПОСЛЕДНИЕ 24 ЧАСА:`);
  const recent = await rows(dsql`
    SELECT
      COUNT(*)::int AS new_flows,
      COUNT(DISTINCT source_wallet)::int AS active_sources,
      COUNT(DISTINCT target_wallet)::int AS active_targets
    FROM money_flows
    WHERE tx_time > now() - interval '24 hours'
  `);
  if (recent[0]) {
    const r = recent[0];
    console.log(`  new flows: ${r.new_flows}  active sources: ${r.active_sources}  active targets: ${r.active_targets}`);
  }

  // 9. Top wallets с >=K mints (диверсифицированные)
  console.log(`\nТОП-15 ДИВЕРСИФИЦИРОВАННЫХ (по числу разных mints):`);
  const diverse = await rows(dsql`
    SELECT wallet, distinct_mints, distinct_counterparties, tx_count, COALESCE(primary_tag, '-') AS tag
    FROM entity_wallets
    WHERE distinct_mints >= 5
    ORDER BY distinct_mints DESC
    LIMIT 15
  `);
  for (const r of diverse) {
    console.log(`  ${r.wallet}  mints=${String(r.distinct_mints).padStart(3)}  cps=${String(r.distinct_counterparties).padStart(3)}  txs=${String(r.tx_count).padStart(3)}  tag=${r.tag}`);
  }

  console.log(`\nDONE.\n`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
