import 'dotenv/config';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { mintDecision } from '../intel/wallet-intel/mint-decision.js';
import { loadWalletIntelEnv } from '../intel/wallet-intel/load-policy-env.js';
import { readProductRuleSetVersion } from '../intel/wallet-intel/read-version.js';

function parseMint(): string | null {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--mint' && process.argv[i + 1]) return process.argv[i + 1]!.trim();
    const m = /^--mint=(.+)$/.exec(a);
    if (m) return m[1]!.trim();
  }
  return null;
}

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

async function main(): Promise<void> {
  if (hasHelpFlag()) {
    console.log(`wallet-intel-mint-check — MINT_DECISION для одного mint

  tsx src/scripts/wallet-intel-mint-check.ts --mint <BASE_MINT>

Берёт первые WALLET_INTEL_EARLY_BUYERS_K уникальных покупателей (buy) по времени.
`);
    process.exit(0);
  }

  const mint = parseMint();
  if (!mint) {
    console.error('Укажите --mint <address>');
    process.exit(1);
  }

  const env = loadWalletIntelEnv();
  const ruleSetVersion = readProductRuleSetVersion(env.ruleSetVersionOverride);

  const rows = await db
    .select({
      wallet: schema.swaps.wallet,
      blockTime: schema.swaps.blockTime,
    })
    .from(schema.swaps)
    .where(and(eq(schema.swaps.baseMint, mint), eq(schema.swaps.side, 'buy')))
    .orderBy(asc(schema.swaps.blockTime))
    .limit(Math.min(env.earlyBuyersK * 8, 50_000));

  const buyers: string[] = [];
  const seen = new Set<string>();
  let windowCutoff: Date | null = null;
  if (rows.length > 0) {
    const t0 = rows[0]!.blockTime;
    windowCutoff = new Date(t0.getTime() + env.earlyWindowMinutes * 60 * 1000);
  }

  for (const r of rows) {
    if (windowCutoff && r.blockTime > windowCutoff) break;
    if (seen.has(r.wallet)) continue;
    seen.add(r.wallet);
    buyers.push(r.wallet);
    if (buyers.length >= env.earlyBuyersK) break;
  }

  if (buyers.length === 0) {
    const decision = mintDecision([], new Map(), {
      requireSwapCoverage: env.requireSwapCoverage,
    });
    console.log(
      JSON.stringify(
        {
          mint,
          early_buyers: [],
          rule_set_version: ruleSetVersion,
          mint_decision: decision,
          note: 'no buy swaps for mint',
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const decRows2 = await db
    .select({
      wallet: schema.walletIntelDecisions.walletAddress,
      decision: schema.walletIntelDecisions.decision,
    })
    .from(schema.walletIntelDecisions)
    .where(
      and(
        eq(schema.walletIntelDecisions.ruleSetVersion, ruleSetVersion),
        inArray(schema.walletIntelDecisions.walletAddress, buyers),
      ),
    );

  const map = new Map<string, string>();
  for (const r of decRows2) {
    map.set(r.wallet, r.decision);
  }

  const decision = mintDecision(buyers, map, {
    requireSwapCoverage: env.requireSwapCoverage,
  });

  console.log(
    JSON.stringify(
      {
        mint,
        early_buyers_count: buyers.length,
        rule_set_version: ruleSetVersion,
        mint_decision: decision,
        missing_decisions: buyers.filter((w) => !map.has(w)).length,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
