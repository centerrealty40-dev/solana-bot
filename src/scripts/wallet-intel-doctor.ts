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
`);
    process.exit(0);
  }

  const env = loadWalletIntelEnv();

  const swaps24 = await countSwapsHours(24);
  const flows24 = await countMoneyFlowsHours(24);
  const walletsTotal = await countAll('wallets');
  const entityTotal = await countAll('entity_wallets');
  const candTotal = await countAll('scam_farm_candidates');
  const decisionsTotal = await countAll('wallet_intel_decisions');

  const out = {
    swaps_last_24h: swaps24,
    money_flows_last_24h: flows24,
    wallets_total: walletsTotal,
    entity_wallets_total: entityTotal,
    scam_farm_candidates_total: candTotal,
    wallet_intel_decisions_total: decisionsTotal,
    require_swap_coverage: env.requireSwapCoverage,
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
