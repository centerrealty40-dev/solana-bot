import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { loadWalletIntelEnv } from '../intel/wallet-intel/load-policy-env.js';

async function countSwapsHours(hours: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS c FROM swaps
    WHERE block_time > now() - (${hours}::numeric * interval '1 hour')
  `);
  const r = rows[0] as { c?: number } | undefined;
  return Number(r?.c ?? 0);
}

async function swapsTotals(): Promise<{ swaps_total: number; last_block_time: string | null; last_created_at: string | null }> {
  const rows = await db.execute(sql`
    SELECT
      count(*)::int AS total,
      max(block_time) AS last_bt,
      max(created_at) AS last_ca
    FROM swaps
  `);
  const r = rows[0] as { total?: number; last_bt?: Date | null; last_ca?: Date | null } | undefined;
  const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
  return {
    swaps_total: Number(r?.total ?? 0),
    last_block_time: iso(r?.last_bt ?? null),
    last_created_at: iso(r?.last_ca ?? null),
  };
}

async function countMoneyFlowsHours(hours: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS c FROM money_flows
    WHERE tx_time > now() - (${hours}::numeric * interval '1 hour')
  `);
  const r = rows[0] as { c?: number } | undefined;
  return Number(r?.c ?? 0);
}

async function countAll(table: 'wallets' | 'entity_wallets' | 'scam_farm_candidates' | 'wallet_intel_decisions'): Promise<number> {
  const rows = await db.execute(
    sql.raw(`SELECT count(*)::int AS c FROM ${table}`),
  );
  const r = rows[0] as { c?: number } | undefined;
  return Number(r?.c ?? 0);
}

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

async function main(): Promise<void> {
  if (hasHelpFlag()) {
    console.log(`wallet-intel-doctor — preflight counts for intel pipeline

Exit 2 if WALLET_INTEL_REQUIRE_SWAP_COVERAGE=1 and recent swaps = 0 (24h window).

Also prints swaps_total, last swap timestamps, 7d windows — см. W6.12 S02 / RUNTIME (pilot backfill без стрима).
`);
    process.exit(0);
  }

  const env = loadWalletIntelEnv();

  const swaps24 = await countSwapsHours(24);
  const swaps168 = await countSwapsHours(168);
  const flows24 = await countMoneyFlowsHours(24);
  const flows168 = await countMoneyFlowsHours(168);
  const swapAgg = await swapsTotals();
  const walletsTotal = await countAll('wallets');
  const entityTotal = await countAll('entity_wallets');
  const candTotal = await countAll('scam_farm_candidates');
  const decisionsTotal = await countAll('wallet_intel_decisions');

  const warnings: string[] = [];
  if (flows24 === 0) {
    warnings.push(
      'money_flows_last_24h=0 — правила scam-farm вроде sync_fund почти не получат рёбер; добивайте ingest/backfill потоков или смирьтесь с узким детективом.',
    );
  }
  if (swaps24 === 0) {
    warnings.push(
      'swaps_last_24h=0 — нет сделок в окне; mint-gate и orchestrate_split по swaps не работают.',
    );
  }
  if (swaps168 === 0 && swapAgg.swaps_total > 0) {
    warnings.push(
      'swaps_last_168h=0 при ненулевом swaps_total — последняя активность свопов старше 7 суток; поднимайте ingest (npm run wallet-backfill:pilot при включённом SA_BACKFILL_ENABLED).',
    );
  }
  if (entityTotal === 0 && walletsTotal > 0) {
    warnings.push(
      'entity_wallets пуст при непустых wallets — tagAtlas/Atlas не покрывают сид; промоут wallets→entity или RUN_TAGGER.',
    );
  }

  const out = {
    swaps_last_24h: swaps24,
    swaps_last_168h: swaps168,
    money_flows_last_24h: flows24,
    money_flows_last_168h: flows168,
    swaps_total: swapAgg.swaps_total,
    swaps_last_block_time: swapAgg.last_block_time,
    swaps_last_created_at: swapAgg.last_created_at,
    wallets_total: walletsTotal,
    entity_wallets_total: entityTotal,
    scam_farm_candidates_total: candTotal,
    wallet_intel_decisions_total: decisionsTotal,
    require_swap_coverage: env.requireSwapCoverage,
    warnings,
  };
  console.log(JSON.stringify(out, null, 2));

  if (env.requireSwapCoverage && swaps24 === 0) {
    console.error('MINT_DECISION недоступен: нет swaps за 24h при WALLET_INTEL_REQUIRE_SWAP_COVERAGE=1');
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
