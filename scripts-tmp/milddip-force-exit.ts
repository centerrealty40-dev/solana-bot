/**
 * One-off: force-close one managed mild-dip position by mint.
 * Usage: npx tsx scripts-tmp/milddip-force-exit.ts <mint>
 *
 * This is an operational tool, not a new exit policy: it requires live mode,
 * refuses protected stable/WSOL mints and dust balances, and never edits
 * data/milddip/state.json. After the token disappears, the running bot
 * settles the position itself through verdictDropEmptyOnNoBalance →
 * confirmed_empty (120s grace; this position is already older than one day).
 */
import 'dotenv/config';
import { executeCopySell } from '../src/copytrader/executor.js';
import { fetchMintBalanceRaw } from '../src/copytrader/live-exec.js';
import { loadMildDipConfig } from '../src/milddip/config.js';
import { mildDipToCopyTraderConfig } from '../src/milddip/exec-bridge.js';
import { HOLDING_DUST_RAW } from '../src/milddip/sell-empty-guard.js';

const PROTECTED_MINTS = new Set([
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
]);

function printResult(args: {
  mint: string;
  mark: number | null;
  result: unknown;
  signature?: string | null;
}): void {
  console.log(
    JSON.stringify(
      {
        mint: args.mint,
        mark: args.mark,
        result: args.result,
        signature: args.signature ?? null,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const mint = process.argv[2]?.trim();
  if (!mint) {
    console.error('usage: milddip-force-exit.ts <mint>');
    process.exit(1);
  }

  if (PROTECTED_MINTS.has(mint)) {
    printResult({
      mint,
      mark: null,
      result: { ok: false, reason: 'protected_mint' },
    });
    process.exit(1);
  }

  const cfg = loadMildDipConfig();
  if (cfg.executionMode !== 'live') {
    printResult({
      mint,
      mark: null,
      result: { ok: false, reason: 'live_mode_required' },
    });
    process.exit(1);
  }

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  const balanceRaw = await fetchMintBalanceRaw(copyCfg, mint);
  const onchainRaw = balanceRaw && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : 0n;
  if (onchainRaw <= HOLDING_DUST_RAW) {
    printResult({
      mint,
      mark: null,
      result: {
        ok: false,
        reason: 'onchain_balance_at_or_below_dust',
        tokenRaw: balanceRaw,
        dustRaw: HOLDING_DUST_RAW.toString(),
      },
    });
    process.exit(1);
  }

  const result = await executeCopySell({
    cfg: copyCfg,
    mint,
    symbol: mint.slice(0, 6),
    entryPriceUsd: 0,
    exitPriceUsd: 0,
    sizeUsd: 0,
    fraction: 1,
    leaderSignature: `milddip_manual_force_exit_${Date.now()}`,
    sellDelayMs: 0,
    tokenRawBase: onchainRaw.toString(),
  });
  printResult({
    mint,
    mark: result.priceUsd ?? null,
    result,
    signature: result.signature ?? null,
  });
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
