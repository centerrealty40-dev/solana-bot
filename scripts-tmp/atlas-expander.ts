/**
 * Atlas Expander — массовое расширение Wallet Atlas через wallet-tracer.
 *
 * ЦЕЛЬ: вырастить нашу базу с 150 seed-кошельков до 1,500-15,000 wallets +
 * заполнить money_flows для всей прилегающей сети.
 *
 * Алгоритм:
 *   1. Собрать все seeds:
 *      - watchlist_wallets (~104)
 *      - wallet_tags distinct (~75)
 *      - топ-busy кошельки из swaps за 30 дней (>=20 swap'ов)
 *      → ~150-300 уникальных
 *   2. Для каждого seed запускаем traceWallet(hops=1, fanout=8):
 *      - Scrape 100 последних txs кошелька
 *      - Найти топ-8 контрагентов
 *      - Также scrape их (1 уровень рекурсии)
 *      → 1 seed = 1 + 8 = 9 wallets traced
 *   3. Это даёт ~1,350-2,700 wallets в Atlas с money_flows
 *
 * COST:
 *   - 1 traced wallet = 100 txs = ~150 Helius credits
 *   - 150 seeds × 9 wallets each = ~1,350 traces = ~200k credits
 *   - Free tier = 1M/мес → 20% бюджета
 *   - Плюс aggressive cache (24h) → переиспользуем уже traced wallets
 *
 * Можно перезапускать — tracer skip'ает свежие профили (<24h).
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../src/core/db/client.js';
import { traceWallet } from '../src/intel/wallet-tracer.js';

const CONCURRENCY        = 3;     // одновременных traceWallet (tracer внутри ещё пагинирует)
const PAGES_PER_WALLET   = 1;     // 100 txs/wallet
const HOPS               = 1;     // 1 hop = root + neighbors
const FANOUT             = 8;     // 8 топ-counterparties per root
const CACHE_HOURS        = 24;
const MIN_SOL_EDGE       = 0.05;
const MIN_SWAPS_FOR_SEED = 20;    // busy wallets из таблицы swaps

async function loadSeeds(): Promise<string[]> {
  console.log('Загружаю seed-кошельки из БД...');

  const wl = await db.select({ wallet: schema.watchlistWallets.wallet }).from(schema.watchlistWallets);
  console.log(`  watchlist_wallets:  ${wl.length}`);

  const tagsRes: { rows: { wallet: string }[] } = await db.execute(
    dsql`SELECT DISTINCT wallet FROM wallet_tags`,
  ) as any;
  const tagged = (Array.isArray(tagsRes) ? tagsRes : tagsRes.rows ?? []) as { wallet: string }[];
  console.log(`  tagged distinct:    ${tagged.length}`);

  const busyRes: any = await db.execute(dsql`
    SELECT wallet FROM (
      SELECT wallet, COUNT(*) AS n FROM swaps
      WHERE block_time > now() - interval '30 days'
      GROUP BY wallet
      HAVING COUNT(*) >= ${MIN_SWAPS_FOR_SEED}
    ) s
  `);
  const busy = (Array.isArray(busyRes) ? busyRes : busyRes.rows ?? []) as { wallet: string }[];
  console.log(`  busy from swaps:    ${busy.length}  (>=${MIN_SWAPS_FOR_SEED} swaps в 30д)`);

  const all = new Set<string>([
    ...wl.map(r => r.wallet),
    ...tagged.map(r => r.wallet),
    ...busy.map(r => r.wallet),
  ]);
  const seeds = [...all].filter(w => w && w.length >= 32);
  console.log(`  unique total:       ${seeds.length}\n`);
  return seeds;
}

async function snapshot(): Promise<{ wallets: number; flows: number }> {
  const w: any = await db.execute(dsql`SELECT COUNT(*)::int AS n FROM entity_wallets`);
  const f: any = await db.execute(dsql`SELECT COUNT(*)::int AS n FROM money_flows`);
  const wRows = Array.isArray(w) ? w : w.rows ?? [];
  const fRows = Array.isArray(f) ? f : f.rows ?? [];
  return { wallets: Number(wRows[0]?.n ?? 0), flows: Number(fRows[0]?.n ?? 0) };
}

async function main() {
  console.log(`\n=== Atlas Expander ===`);
  console.log(`Concurrency: ${CONCURRENCY}  hops=${HOPS}  fanout=${FANOUT}  pages=${PAGES_PER_WALLET}  cache=${CACHE_HOURS}h\n`);

  const seeds = await loadSeeds();
  if (seeds.length === 0) { console.log('No seeds, abort.'); process.exit(1); }

  const before = await snapshot();
  console.log(`СОСТОЯНИЕ ДО:  entity_wallets=${before.wallets}  money_flows=${before.flows}\n`);

  let processed = 0;
  let errors = 0;
  const totals = { walletsScanned: 0, walletsCached: 0, txsObserved: 0, flowsInserted: 0 };
  const start = Date.now();

  for (let i = 0; i < seeds.length; i += CONCURRENCY) {
    const batch = seeds.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(s =>
      traceWallet(s, {
        pagesPerWallet: PAGES_PER_WALLET,
        hops: HOPS,
        fanout: FANOUT,
        cacheHours: CACHE_HOURS,
        minSolEdge: MIN_SOL_EDGE,
      }),
    ));
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      processed++;
      if (r.status === 'fulfilled') {
        totals.walletsScanned += r.value.walletsScanned;
        totals.walletsCached  += r.value.walletsCached;
        totals.txsObserved    += r.value.txsObserved;
        totals.flowsInserted  += r.value.flowsInserted;
      } else {
        errors++;
        process.stderr.write(`  ERROR ${batch[k].slice(0,8)}…  ${String(r.reason).slice(0,120)}\n`);
      }
    }
    const elapsed = (Date.now() - start) / 1000;
    const eta = processed > 0 ? Math.round((elapsed / processed) * (seeds.length - processed)) : 0;
    process.stderr.write(
      `[${processed}/${seeds.length}]  scanned=${totals.walletsScanned}  cached=${totals.walletsCached}  txs=${totals.txsObserved}  flows=${totals.flowsInserted}  errors=${errors}  ETA ${Math.floor(eta/60)}m${eta%60}s\n`,
    );
  }

  const after = await snapshot();
  const elapsed = Math.round((Date.now() - start) / 1000);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`СОСТОЯНИЕ ПОСЛЕ:  entity_wallets=${after.wallets}  money_flows=${after.flows}`);
  console.log(`ДЕЛЬТА:           +${after.wallets - before.wallets} wallets,  +${after.flows - before.flows} flows`);
  console.log(`Время: ${Math.floor(elapsed/60)}m${elapsed%60}s,  errors: ${errors}/${seeds.length}\n`);

  // Топ-20 новооткрытых хабов (много контрагентов = центральная роль в сети)
  const topRes: any = await db.execute(dsql`
    SELECT wallet, distinct_counterparties, distinct_mints, tx_count, total_funded_sol
    FROM entity_wallets
    WHERE profile_created_at > now() - ($1 || ' seconds')::interval
      AND tx_count > 0
    ORDER BY distinct_counterparties DESC
    LIMIT 20
  `, [String(elapsed + 60)]);
  const topRows = Array.isArray(topRes) ? topRes : topRes.rows ?? [];
  if (topRows.length > 0) {
    console.log(`ТОП-20 НОВЫХ ХАБОВ (по числу контрагентов):`);
    for (const r of topRows) {
      console.log(
        `  ${r.wallet.slice(0,12)}…  cps=${r.distinct_counterparties}  mints=${r.distinct_mints}  txs=${r.tx_count}  funded=${Number(r.total_funded_sol).toFixed(2)} SOL`,
      );
    }
  }

  // Топ-20 super-funders (отправили SOL во многие новые wallets)
  const fundersRes: any = await db.execute(dsql`
    SELECT source_wallet, COUNT(DISTINCT target_wallet) AS recipients, SUM(amount) AS total_sol
    FROM money_flows
    WHERE asset = 'SOL'
      AND tx_time > now() - interval '60 days'
      AND amount > 0.01
    GROUP BY source_wallet
    HAVING COUNT(DISTINCT target_wallet) >= 5
    ORDER BY recipients DESC
    LIMIT 20
  `);
  const fundersRows = Array.isArray(fundersRes) ? fundersRes : fundersRes.rows ?? [];
  if (fundersRows.length > 0) {
    console.log(`\nТОП-20 SUPER-FUNDERS (рассылают SOL в >=5 wallets):`);
    for (const r of fundersRows) {
      console.log(
        `  ${r.source_wallet.slice(0,12)}…  recipients=${r.recipients}  total=${Number(r.total_sol).toFixed(2)} SOL`,
      );
    }
  }

  console.log(`\nDONE. Дальше: запустить wallet-tagger на новой базе и Pattern Detector.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
