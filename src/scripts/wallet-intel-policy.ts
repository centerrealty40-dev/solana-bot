import 'dotenv/config';
import { ensureDecisionsForWallets } from '../intel/wallet-intel/ensure-decisions.js';
import {
  insertWalletIntelRunRecord,
  runWalletIntelMaterialize,
} from '../intel/wallet-intel/run-materialize.js';
import { readProductRuleSetVersion } from '../intel/wallet-intel/read-version.js';
import { loadWalletIntelEnv } from '../intel/wallet-intel/load-policy-env.js';

function parseArgs(): { dryRun: boolean; limit?: number; ensureWallets?: string[] } {
  let dryRun = false;
  let limit: number | undefined;
  let ensureWallets: string[] | undefined;
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') dryRun = true;
    const lm = /^--limit=(\d+)$/.exec(a);
    if (lm) limit = Number(lm[1]);
    const em = /^--ensure-wallets=(.+)$/.exec(a);
    if (em) {
      ensureWallets = em[1]!
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return { dryRun, limit, ensureWallets };
}

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (hasHelpFlag()) {
    console.log(`wallet-intel-policy — materialize wallet_intel_decisions

Flags:
  --dry-run              не писать в БД
  --limit=N              переопределить WALLET_INTEL_POLICY_LIMIT для обычного прогона
  --ensure-wallets=a,b,c только эти адреса (без лимита entity/scam ordering batch)

Env: WALLET_INTEL_* (см. .env.example)
`);
    process.exit(0);
  }

  const env = loadWalletIntelEnv();
  const ruleSetVersion = readProductRuleSetVersion(env.ruleSetVersionOverride);
  const startedAt = new Date();

  try {
    let metrics: Record<string, unknown>;

    if (args.ensureWallets && args.ensureWallets.length > 0) {
      const full = await ensureDecisionsForWallets(args.ensureWallets, { dryRun: args.dryRun, env });
      const { decisionsByWallet: _dm, ...rest } = full;
      void _dm;
      metrics = { ...rest, mode: 'ensure-wallets', wallets: args.ensureWallets.length };
    } else {
      const m = await runWalletIntelMaterialize({ dryRun: args.dryRun, limitOverride: args.limit });
      metrics = { ...m, mode: 'batch' };
    }

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
