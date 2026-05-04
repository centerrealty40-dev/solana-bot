import 'dotenv/config';
import {
  insertWalletIntelRunRecord,
  runWalletIntelMaterialize,
} from '../intel/wallet-intel/run-materialize.js';
import { readProductRuleSetVersion } from '../intel/wallet-intel/read-version.js';
import { loadWalletIntelEnv } from '../intel/wallet-intel/load-policy-env.js';

function parseArgs(): { dryRun: boolean; limit?: number } {
  let dryRun = false;
  let limit: number | undefined;
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') dryRun = true;
    const m = /^--limit=(\d+)$/.exec(a);
    if (m) limit = Number(m[1]);
  }
  return { dryRun, limit };
}

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (hasHelpFlag()) {
    console.log(`wallet-intel-policy — materialize wallet_intel_decisions

Flags:
  --dry-run     не писать в БД
  --limit=N     переопределить WALLET_INTEL_POLICY_LIMIT для прогона

Env: WALLET_INTEL_* (см. .env.example)
`);
    process.exit(0);
  }

  const env = loadWalletIntelEnv();
  const ruleSetVersion = readProductRuleSetVersion(env.ruleSetVersionOverride);
  const startedAt = new Date();

  try {
    const metrics = await runWalletIntelMaterialize({ dryRun: args.dryRun, limitOverride: args.limit });
    const finishedAt = new Date();
    if (!args.dryRun) {
      await insertWalletIntelRunRecord({
        ruleSetVersion,
        metrics: { ...metrics, pipeline: 'wallet-intel-policy' },
        status: 'ok',
        startedAt,
        finishedAt,
      });
    }
    console.log(JSON.stringify({ ok: true, metrics }, null, 2));
    process.exit(0);
  } catch (e) {
    const finishedAt = new Date();
    const err = String((e as Error)?.message || e);
    if (!args.dryRun) {
      await insertWalletIntelRunRecord({
        ruleSetVersion,
        metrics: { pipeline: 'wallet-intel-policy', error: err },
        status: 'failed',
        error: err,
        startedAt,
        finishedAt,
      });
    }
    console.error(JSON.stringify({ ok: false, error: err }));
    process.exit(1);
  }
}

main();
