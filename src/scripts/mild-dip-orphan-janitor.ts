#!/usr/bin/env node
/**
 * One-shot: burn+close junk orphan ATAs on the mild-dip wallet.
 *
 *   npx tsx src/scripts/mild-dip-orphan-janitor.ts           # dry-run
 *   npx tsx src/scripts/mild-dip-orphan-janitor.ts --execute
 *   npx tsx src/scripts/mild-dip-orphan-janitor.ts --execute --limit 20
 */
import 'dotenv/config';
import { loadMildDipConfig } from '../milddip/config.js';
import {
  protectMintsFromMildDipState,
  runOrphanJanitor,
} from '../milddip/orphan-janitor.js';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const limitIdx = process.argv.indexOf('--limit');
  const limit =
    limitIdx >= 0 && process.argv[limitIdx + 1]
      ? Number(process.argv[limitIdx + 1])
      : undefined;

  const cfg = loadMildDipConfig();
  if (!cfg.walletSecret) {
    throw new Error('MILD_DIP_WALLET_SECRET missing');
  }
  const protect = protectMintsFromMildDipState(cfg.statePath);
  console.log(
    `[mild-dip-orphan-janitor] mode=${execute ? 'EXECUTE' : 'dry-run'} ` +
      `protectOpen=${protect.length} wallet=${cfg.walletPubkeyExpected ?? 'n/a'}`,
  );

  const result = await runOrphanJanitor({
    rpcUrl: cfg.rpcUrl,
    walletSecret: cfg.walletSecret,
    protectMints: protect,
    execute,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  console.log(
    `[mild-dip-orphan-janitor] candidates=${result.candidates} ` +
      `burnedClosed=${result.burnedClosed} skipped=${result.skipped} ` +
      `reclaimedSol=${(result.reclaimedLamports / 1e9).toFixed(4)} ` +
      `sigs=${result.signatures.length} errors=${result.errors.length}`,
  );
  for (const e of result.errors.slice(0, 10)) {
    console.warn(`  err: ${e}`);
  }
  if (!execute && result.candidates > 0) {
    console.log('[mild-dip-orphan-janitor] re-run with --execute to burn+close');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
