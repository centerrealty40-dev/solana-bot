/**
 * W6.12 — узкий прогон wallet-backfill под лимит QuickNode (без стрима).
 * Ставит консервативные дефолты SA_BACKFILL_* только если ключи пустые,
 * затем запускает wallet-backfill-run с переданными argv (--enqueue-from-wallets=N, --dry-run).
 *
 * Оценка верхней границы кредитов за прогон (billable RPC × QUICKNODE_CREDITS_PER_SOLANA_RPC):
 *   maxWallets × (sigPagesMax + maxTxPerWallet) × creditsPerRpc
 *
 * Требует SA_BACKFILL_ENABLED=1 для реальной записи (как и основной скрипт).
 *
 *   npm run wallet-backfill:pilot
 *   npm run wallet-backfill:pilot -- --enqueue-from-wallets=400
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const PILOT_DEFAULTS: Record<string, string> = {
  SA_BACKFILL_MAX_WALLETS_PER_RUN: '40',
  SA_BACKFILL_SIG_PAGES_MAX: '2',
  SA_BACKFILL_MAX_TX_PER_WALLET: '12',
  SA_BACKFILL_RPC_SLEEP_MS: '280',
};

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function estimateCreditsCeiling(): number {
  const cp = envNum('QUICKNODE_CREDITS_PER_SOLANA_RPC', 30);
  const w = envNum('SA_BACKFILL_MAX_WALLETS_PER_RUN', 40);
  const sig = envNum('SA_BACKFILL_SIG_PAGES_MAX', 2);
  const tx = envNum('SA_BACKFILL_MAX_TX_PER_WALLET', 12);
  return w * (sig + tx) * cp;
}

function findPassthroughArgs(): string[] {
  const marker = 'wallet-backfill-pilot';
  const idx = process.argv.findIndex((a) => a.includes(marker));
  return idx >= 0 ? process.argv.slice(idx + 1) : process.argv.slice(2);
}

for (const [k, v] of Object.entries(PILOT_DEFAULTS)) {
  if (process.env[k] === undefined || process.env[k] === '') {
    process.env[k] = v;
  }
}

const ceiling = estimateCreditsCeiling();
console.log(
  JSON.stringify({
    component: 'wallet-backfill-pilot',
    note: 'Upper-bound RPC credits if every wallet uses full sig+tx budget (actual usage usually lower).',
    estimatedCreditsCeiling: ceiling,
    env: {
      SA_BACKFILL_MAX_WALLETS_PER_RUN: process.env.SA_BACKFILL_MAX_WALLETS_PER_RUN,
      SA_BACKFILL_SIG_PAGES_MAX: process.env.SA_BACKFILL_SIG_PAGES_MAX,
      SA_BACKFILL_MAX_TX_PER_WALLET: process.env.SA_BACKFILL_MAX_TX_PER_WALLET,
      QUICKNODE_CREDITS_PER_SOLANA_RPC: process.env.QUICKNODE_CREDITS_PER_SOLANA_RPC ?? '30',
    },
  }),
);

const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const target = path.join(repoRoot, 'src/scripts/wallet-backfill-run.ts');
const passthrough = findPassthroughArgs();

const proc = spawnSync(process.execPath, [tsxCli, target, ...passthrough], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

process.exit(proc.status ?? 1);
