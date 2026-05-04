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

/** Полный dry-run: scam-farm без записи в БД + policy dry; tagger пропускается (иначе пишет теги). */
function fullDryRun(): boolean {
  return process.argv.includes('--dry-run');
}

function dryPolicyOnly(): boolean {
  return process.argv.includes('--dry-run-policy');
}

async function main(): Promise<void> {
  if (hasHelpFlag()) {
    console.log(`wallet-intel-pipeline — tagAtlas (optional) → scam-farm → wallet-intel-policy

Env:
  WALLET_INTEL_RUN_TAGGER=1   — перед детективом запустить tagAtlas (тяжёлый)
  WALLET_INTEL_TAGGER_LOOKBACK_HOURS  — окно для tagAtlas (default 168)
  SCAM_FARM_* , WALLET_INTEL_*

Flags:
  --dry-run          весь пайплайн без побочных записей: SCAM_FARM_DRY_RUN=1, WRITE_ATLAS=0, policy dry-run; tagger не запускается
  --dry-run-policy   только policy dry-run (scam-farm и теггер — по вашим SCAM_FARM_* / RUN_TAGGER)
`);
    process.exit(0);
  }

  const fullDry = fullDryRun();
  const dryPol = dryPolicyOnly();

  const prevDry = process.env.SCAM_FARM_DRY_RUN;
  const prevAtlas = process.env.SCAM_FARM_WRITE_ATLAS;

  if (fullDry) {
    process.env.SCAM_FARM_DRY_RUN = '1';
    process.env.SCAM_FARM_WRITE_ATLAS = '0';
  }

  const env = loadWalletIntelEnv();
  const ruleSetVersion = readProductRuleSetVersion(env.ruleSetVersionOverride);
  const startedAt = new Date();
  const steps: Record<string, unknown> = {};

  try {
    if (env.runTagger && !fullDry) {
      const t = await tagAtlas(env.taggerLookbackHours);
      steps.tagAtlas = t;
    } else if (env.runTagger && fullDry) {
      steps.tagAtlas = { skipped: true, reason: 'full_dry_run' };
    }

    const scamMetrics = await runScamFarmDetectivePass();
    steps.scamFarmDetective = scamMetrics;

    const policyMetrics = await runWalletIntelMaterialize({
      dryRun: fullDry || dryPol,
    });
    steps.walletIntelPolicy = policyMetrics;

    const finishedAt = new Date();
    const persistRunRecord = !fullDry && !dryPol;
    if (persistRunRecord) {
      await insertWalletIntelRunRecord({
        ruleSetVersion,
        metrics: { pipeline: 'wallet-intel-pipeline', steps },
        status: 'ok',
        startedAt,
        finishedAt,
      });
    }

    console.log(JSON.stringify({ ok: true, dry_run: fullDry, dry_run_policy_only: dryPol, steps }, null, 2));
    process.exit(0);
  } catch (e) {
    const finishedAt = new Date();
    const err = String((e as Error)?.message || e);
    const persistRunRecord = !fullDry && !dryPol;
    if (persistRunRecord) {
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
  } finally {
    if (fullDry) {
      if (prevDry !== undefined) process.env.SCAM_FARM_DRY_RUN = prevDry;
      else delete process.env.SCAM_FARM_DRY_RUN;
      if (prevAtlas !== undefined) process.env.SCAM_FARM_WRITE_ATLAS = prevAtlas;
      else delete process.env.SCAM_FARM_WRITE_ATLAS;
    }
  }
}

main();
