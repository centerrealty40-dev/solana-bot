import 'dotenv/config';
import { runBotBucketPass } from '../intel/bot-bucket/run-bot-bucket.js';

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

function parseCli(): { dryRun?: boolean; force?: boolean; sinceHours?: number } {
  const out: { dryRun?: boolean; force?: boolean; sinceHours?: number } = {};
  if (process.argv.includes('--dry-run')) out.dryRun = true;
  if (process.argv.includes('--force')) out.force = true;
  for (const a of process.argv) {
    const m = /^--since-hours=(\d+)$/.exec(a);
    if (m) out.sinceHours = Number(m[1]);
  }
  return out;
}

if (hasHelpFlag()) {
  console.log(`intel-bot-bucket — W6.10 M2: umbrella-тег bot + SQL-эвристики (swaps / money_flows)

Env:
  BOT_BUCKET_ENABLED=0|1       мастер-выключатель (default 0)
  BOT_BUCKET_DRY_RUN=0|1       default 1 — без записей в wallet_tags
  BOT_LAYER_B_SINCE_HOURS      окно слоя B (default 24)
  BOT_* пороги — см. .env.example

Flags:
  --force              выполнить даже при BOT_BUCKET_ENABLED=0
  --dry-run            не писать в БД
  --since-hours=N      переопределить окно lookback для слоя B

Порядок пайплайна (рекомендация W6.10): tagWallet → intel:bot-bucket → scam-farm → wallet-intel-policy
`);
  process.exit(0);
}

const cli = parseCli();

runBotBucketPass({
  force: cli.force,
  dryRun: cli.dryRun,
  sinceHoursOverride: cli.sinceHours,
})
  .then((m) => {
    console.log(JSON.stringify({ ok: true, metrics: m }));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    process.exit(1);
  });
