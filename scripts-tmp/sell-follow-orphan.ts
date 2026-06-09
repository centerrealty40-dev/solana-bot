/**
 * One-off: liquidate a wallet token not tracked in follow state.
 * Usage: npx tsx scripts-tmp/sell-follow-orphan.ts <mint>
 */
import 'dotenv/config';
import { loadPumpswapComboFollowConfig } from '../src/pumpswap-combo-follow/config.js';
import { toComboExecutorConfig } from '../src/pumpswap-combo-follow/config.js';
import { executeComboSell } from '../src/pumpswap-combo/executor.js';
import { quoteExitPriceUsd } from '../src/pumpswap-combo/pricing.js';
import { comboLiveBridge } from '../src/pumpswap-combo/live-bridge.js';
import { resolveMintPumpPool } from '../src/pumpswap-combo/pool-resolve.js';

async function main(): Promise<void> {
  const mint = process.argv[2]?.trim();
  if (!mint) {
    console.error('usage: sell-follow-orphan.ts <mint>');
    process.exit(1);
  }

  const cfg = loadPumpswapComboFollowConfig();
  if (cfg.executionMode !== 'live') {
    console.error('live mode required');
    process.exit(1);
  }
  const execCfg = toComboExecutorConfig(cfg);
  const liveCfg = comboLiveBridge(execCfg);
  const pool = await resolveMintPumpPool(cfg.rpcUrl, mint);
  if (!pool) {
    console.error('pool not found for', mint);
    process.exit(1);
  }
  const q = await quoteExitPriceUsd(liveCfg, mint, pool);
  const mark = q.priceUsd ?? 0;
  console.log(JSON.stringify({ mint, pool, mark }, null, 2));
  const res = await executeComboSell({
    cfg: execCfg,
    mint,
    symbol: mint.slice(0, 6),
    poolAddress: pool,
    markPriceUsd: mark > 0 ? mark : 1e-8,
    investedUsd: 1,
    pnlPctAtMark: 0,
    exitReason: 'orphan_cleanup',
    intent: 'tp2_full',
    sellFrac: 1,
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
