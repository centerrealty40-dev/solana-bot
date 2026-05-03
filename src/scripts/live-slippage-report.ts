/**
 * One-shot: execution shortfall vs Jupiter quote for all confirmed swaps in LIVE_TRADES_PATH.
 *
 * Preflight: `refreshSolPrice()` then SOL USD from env override or Jupiter lite-api price.
 *
 * Env:
 * - LIVE_SLIPPAGE_SOL_USD — optional fixed SOL/USD for USD column (else refreshed Jupiter spot).
 * - LIVE_SLIPPAGE_MAX_JOURNAL_BYTES — optional override when scanning large JSONL (default = LIVE_REPLAY_MAX_FILE_BYTES).
 *
 * From repo root on VPS, sets default LIVE_TRADES_PATH / LIVE_PARITY_PAPER_TRADES_PATH when unset if files exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadLiveOscarConfig } from '../live/config.js';
import { aggregateConfirmedSwapSlippage } from '../live/slippage-from-journal.js';
import { getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';

function applyRepoDefaultLiveEnv(): void {
  const root = process.cwd();
  const liveJournal = path.join(root, 'data/live/pt1-oscar-live.jsonl');
  const parityPaper = path.join(root, 'data/paper2/pt1-oscar.jsonl');
  if (!process.env.LIVE_TRADES_PATH?.trim() && fs.existsSync(liveJournal)) {
    process.env.LIVE_TRADES_PATH = liveJournal;
  }
  if (!process.env.LIVE_PARITY_PAPER_TRADES_PATH?.trim() && fs.existsSync(parityPaper)) {
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = parityPaper;
  }
  if (!process.env.LIVE_STRATEGY_ID?.trim()) process.env.LIVE_STRATEGY_ID = 'live-oscar';
}

function envPositiveNum(name: string): number | undefined {
  const s = process.env[name]?.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  applyRepoDefaultLiveEnv();
  const cfg = loadLiveOscarConfig();
  await refreshSolPrice();

  const solUsdEnv = envPositiveNum('LIVE_SLIPPAGE_SOL_USD');
  const solUsd = solUsdEnv ?? getSolUsd();

  const maxBytesEnv = envPositiveNum('LIVE_SLIPPAGE_MAX_JOURNAL_BYTES');
  const report = await aggregateConfirmedSwapSlippage(cfg, {
    solUsd,
    maxFileBytesOverride: maxBytesEnv,
  });

  const printable = {
    ...report,
    caveatUsd:
      'USD column uses SOL spot at report time (see solUsdUsed), not historical SOL/USD at each fill.',
  };

  console.log(JSON.stringify(printable, null, 2));

  if (report.journalTruncated) {
    console.error(
      `[live-slippage-report] journal truncated at LIVE_REPLAY_MAX_FILE_BYTES; increase LIVE_SLIPPAGE_MAX_JOURNAL_BYTES or archive.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
