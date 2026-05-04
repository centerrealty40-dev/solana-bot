import 'dotenv/config';
import { tagAtlas } from '../intel/wallet-tagger.js';
import { runScamFarmDetectivePass } from '../intel/scam-farm-detective/run-detective.js';
import {
  insertWalletIntelRunRecord,
  runWalletIntelMaterialize,
} from '../intel/wallet-intel/run-materialize.js';
import { readProductRuleSetVersion } from '../intel/wallet-intel/read-version.js';
import { loadWalletIntelEnv } from '../intel/wallet-intel/load-policy-env.js';

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

async function main(): Promise<void> {
  if (hasHelpFlag()) {
    console.log(`wallet-intel-pipeline — tagAtlas (optional) → scam-farm → wallet-intel-policy

Env:
  WALLET_INTEL_RUN_TAGGER=1   — перед детективом запустить tagAtlas (тяжёлый)
  WALLET_INTEL_TAGGER_LOOKBACK_HOURS  — окно для tagAtlas (default 168)
  SCAM_FARM_* , WALLET_INTEL_*

Flags:
  --dry-run-policy   materialize policy без записи (детектив и теггер всё равно пишут при своих флагах)
`);
    process.exit(0);
  }

  const dryPolicy = process.argv.includes('--dry-run-policy');
  const env = loadWalletIntelEnv();
  const ruleSetVersion = readProductRuleSetVersion(env.ruleSetVersionOverride);
  const startedAt = new Date();
  const steps: Record<string, unknown> = {};

  try {
    if (env.runTagger) {
      const t = await tagAtlas(env.taggerLookbackHours);
      steps.tagAtlas = t;
    }

    const scamMetrics = await runScamFarmDetectivePass();
    steps.scamFarmDetective = scamMetrics;

    const policyMetrics = await runWalletIntelMaterialize({
      dryRun: dryPolicy,
    });
    steps.walletIntelPolicy = policyMetrics;

    const finishedAt = new Date();
    if (!dryPolicy) {
      await insertWalletIntelRunRecord({
        ruleSetVersion,
        metrics: { pipeline: 'wallet-intel-pipeline', steps },
        status: 'ok',
        startedAt,
        finishedAt,
      });
    }

    console.log(JSON.stringify({ ok: true, steps }, null, 2));
    process.exit(0);
  } catch (e) {
    const finishedAt = new Date();
    const err = String((e as Error)?.message || e);
    if (!dryPolicy) {
      await insertWalletIntelRunRecord({
        ruleSetVersion,
        metrics: { pipeline: 'wallet-intel-pipeline', steps, error: err },
        status: 'failed',
        error: err,
        startedAt,
        finishedAt,
      });
    }
    console.error(JSON.stringify({ ok: false, error: err, steps }));
    process.exit(1);
  }
}

main();
