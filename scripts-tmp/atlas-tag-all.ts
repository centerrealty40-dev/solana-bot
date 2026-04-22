/**
 * Atlas Tag All — прогон wallet-tagger по всей расширенной базе.
 *
 * Зачем: tagger не гонялся на новых ~1060 wallets, добавленных atlas-expander.
 * Также мы только что расширили правила (whale, bot_farm_distributor,
 * bot_farm_boss, meme_flipper, terminal_distributor, terminal_user, gas_distributor).
 *
 * Что делает:
 *   1. Снимает срез распределения тегов ДО
 *   2. Прогоняет tagAtlas с очень большим окном (захватит все wallets)
 *   3. Снимает срез ПОСЛЕ + дельту
 *   4. Печатает шортлисты по нашим целевым тегам:
 *      - bot_farm_distributor (наша главная цель — pre-activation detector)
 *      - bot_farm_boss
 *      - terminal_user (реальные люди)
 *      - meme_flipper (реальные люди)
 *      - whale
 *
 * Стоимость: ZERO Helius — только локальный Postgres.
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { tagAtlas } from '../src/intel/wallet-tagger.js';

async function rows(q: any): Promise<any[]> {
  const r: any = await db.execute(q);
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function tagDistribution(): Promise<Map<string, number>> {
  const r = await rows(dsql`
    SELECT COALESCE(primary_tag, '(no tag)') AS tag, COUNT(*)::int AS n
    FROM entity_wallets
    GROUP BY primary_tag
    ORDER BY n DESC
  `);
  const m = new Map<string, number>();
  for (const x of r) m.set(x.tag, x.n);
  return m;
}

async function main() {
  console.log(`\n=== Atlas Tag All — bulk re-tagging ===\n`);

  console.log(`Срез ДО:`);
  const before = await tagDistribution();
  for (const [t, n] of [...before.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(24)} ${String(n).padStart(6)}`);
  }

  console.log(`\nПрогоняю tagAtlas (window = 365 days)...`);
  const t0 = Date.now();
  const res = await tagAtlas(365 * 24);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  Tagged: ${res.tagged} wallets за ${elapsed}s\n`);

  console.log(`Срез ПОСЛЕ:`);
  const after = await tagDistribution();
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  const sorted = [...keys].sort((a, b) => (after.get(b) ?? 0) - (after.get(a) ?? 0));
  for (const t of sorted) {
    const b = before.get(t) ?? 0;
    const a = after.get(t) ?? 0;
    const delta = a - b;
    const sign = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '·';
    console.log(`  ${t.padEnd(24)} ${String(a).padStart(6)}  (${sign})`);
  }

  // Wallets with no primary tag — что осталось не классифицировано
  const untagged = await rows(dsql`
    SELECT COUNT(*)::int AS n FROM entity_wallets WHERE primary_tag IS NULL
  `);
  console.log(`\nUntagged: ${untagged[0]?.n ?? 0} / ${[...after.values()].reduce((s, x) => s + x, 0)}`);

  // === Шортлисты по нашим целевым тегам ===

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ШОРТЛИСТЫ ПО ЦЕЛЕВЫМ ТЕГАМ`);
  console.log('='.repeat(60));

  const printShort = async (tag: string, title: string, extraOrder = 'distinct_counterparties DESC') => {
    const r = await rows(dsql.raw(`
      SELECT ew.wallet, ew.tx_count, ew.distinct_counterparties, ew.distinct_mints,
             ew.total_funded_sol,
             (SELECT context FROM wallet_tags wt WHERE wt.wallet = ew.wallet AND wt.tag = '${tag}' LIMIT 1) AS ctx
      FROM entity_wallets ew
      WHERE ew.primary_tag = '${tag}'
      ORDER BY ${extraOrder}
      LIMIT 25
    `));
    console.log(`\n--- ${title} (primary=${tag}, ${r.length} shown) ---`);
    if (r.length === 0) { console.log('  (пусто)'); return; }
    for (const x of r) {
      const ctx = x.ctx ? ` | ${x.ctx}` : '';
      console.log(
        `  ${x.wallet}  txs=${String(x.tx_count).padStart(4)}  cps=${String(x.distinct_counterparties).padStart(3)}  mints=${String(x.distinct_mints).padStart(3)}${ctx}`,
      );
    }
  };

  await printShort('bot_farm_distributor', 'BOT FARM DISTRIBUTORS (наша главная цель)');
  await printShort('bot_farm_boss',        'BOT FARM BOSSES');
  await printShort('terminal_user',        'TERMINAL USERS (реальные люди с Axiom/Photon)', 'tx_count DESC');
  await printShort('meme_flipper',         'MEME FLIPPERS (real human flippers)', 'distinct_mints DESC');
  await printShort('whale',                'WHALES', 'total_funded_sol DESC');
  await printShort('terminal_distributor', 'TERMINAL DISTRIBUTORS (paymaster pools)');

  // === Bot-farm graph: distributors → их recipients ===
  console.log(`\n${'='.repeat(60)}`);
  console.log(`BOT-FARM RECIPIENTS — кому шипят distributors`);
  console.log('='.repeat(60));
  const recvGraph = await rows(dsql`
    SELECT mf.source_wallet AS distributor,
           COUNT(DISTINCT mf.target_wallet)::int AS recipients,
           AVG(mf.amount)::float AS avg_sol,
           MAX(mf.tx_time) AS last_tx
    FROM money_flows mf
    JOIN entity_wallets ew ON ew.wallet = mf.source_wallet
    WHERE ew.primary_tag = 'bot_farm_distributor'
      AND mf.asset = 'SOL'
      AND mf.tx_time > now() - interval '14 days'
    GROUP BY mf.source_wallet
    ORDER BY recipients DESC
    LIMIT 15
  `);
  for (const r of recvGraph) {
    console.log(
      `  ${r.distributor}  → ${r.recipients} recipients  avg=${Number(r.avg_sol).toFixed(2)} SOL  last=${String(r.last_tx).slice(0, 16)}`,
    );
  }

  // Сколько recipients от distributors уже сами тегированы (= наша сеть!)
  console.log(`\nКЛАССЫ РЕЦИПИЕНТОВ от bot_farm_distributors:`);
  const recvClasses = await rows(dsql`
    SELECT COALESCE(ew_t.primary_tag, '(no tag)') AS tag, COUNT(DISTINCT mf.target_wallet)::int AS n
    FROM money_flows mf
    JOIN entity_wallets ew_d ON ew_d.wallet = mf.source_wallet
    LEFT JOIN entity_wallets ew_t ON ew_t.wallet = mf.target_wallet
    WHERE ew_d.primary_tag = 'bot_farm_distributor'
      AND mf.asset = 'SOL'
    GROUP BY 1
    ORDER BY n DESC
  `);
  for (const r of recvClasses) {
    console.log(`  ${r.tag.padEnd(24)} ${String(r.n).padStart(5)}`);
  }

  console.log(`\nDONE.\n`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
