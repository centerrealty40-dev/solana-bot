import { Connection } from '@solana/web3.js';
import 'dotenv/config';
import { createRequire } from 'node:module';
import { loadLiveKeypairFromSecretEnv } from '../src/live/wallet.js';
import { getSolUsd } from '../src/papertrader/pricing.js';
import { jupiterQuoteSellPriceUsd } from '../src/papertrader/pricing/price-verify.js';
import { loadMildDipConfig } from '../src/milddip/config.js';
import { loadMildDipState, saveMildDipState, appendMildDipJournal } from '../src/milddip/state.js';
import { listOrphanTokenAccounts, burnAndCloseOne } from '../src/milddip/orphan-janitor.js';
import { confirmUnroutableRoute } from '../src/milddip/unroutable-route.js';
import { writeUsSellFill } from '../src/milddip/trade-journal.js';

type EcosystemApp = { name?: string; env?: Record<string, unknown> };
const require = createRequire(import.meta.url);
const ecosystem = require('../ecosystem.config.cjs') as {
  apps?: EcosystemApp[];
  allApps?: EcosystemApp[];
};
const own2 = (ecosystem.allApps ?? ecosystem.apps)?.find(
  (app) => app.name === 'mild-dip-own2',
);
if (!own2?.env) throw new Error('mild-dip-own2 ecosystem configuration unavailable');
for (const [key, value] of Object.entries(own2.env)) {
  if (typeof value === 'string') process.env[key] = value;
}

const commit = process.argv.includes('--commit');
const cfg = loadMildDipConfig();
const state = loadMildDipState(cfg.statePath);
const owner = cfg.walletPubkeyExpected?.trim();
if (!owner || !cfg.walletSecret?.trim()) throw new Error('own2 wallet configuration is missing');

const rows = await listOrphanTokenAccounts({ rpcUrl: cfg.rpcUrl, owner });
const connection = new Connection(cfg.rpcUrl, 'confirmed');
const signer = loadLiveKeypairFromSecretEnv(cfg.walletSecret);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowMs = Date.now();

for (const row of rows) {
  const solUsd = getSolUsd();
  const tokenAmount = Number(row.amountRaw) / Math.pow(10, Math.max(0, row.decimals));
  const probe = await confirmUnroutableRoute({
    quote: () =>
      jupiterQuoteSellPriceUsd({
        mint: row.mint,
        tokenDecimals: row.decimals,
        usdNotional: tokenAmount,
        solUsd,
        snapshotPriceUsd: 1,
        slippageBps: 150,
        timeoutMs: 4_000,
      }),
    sleep,
  });
  console.log(`${row.mint} status=${probe.status} tokenRaw=${row.amountRaw}`);
  if (probe.status !== 'unroutable' || !commit) continue;

  const position = state.open[row.mint];
  if (position) {
    const costUsd = Math.max(0, Number(position.sizeUsd) || 0);
    writeUsSellFill({
      tradesPath: cfg.tradesPath,
      wallet: owner,
      mint: row.mint,
      symbol: position.symbol,
      ok: true,
      signature: null,
      sizeUsdIntent: costUsd,
      fraction: 1,
      quoteReceivedUsd: 0,
      costBasisUsdOverride: costUsd,
      markPnlPct: -100,
      reason: 'unroutable_writeoff',
      lane: position.lane ?? 'dip',
      nowMs,
    });
    delete state.open[row.mint];
    state.lastExitByMint ??= {};
    state.lastExitByMint[row.mint] = {
      priceUsd: Math.max(0.000000001, position.entryPriceUsd),
      atMs: nowMs,
      pnlPct: -100,
      preExitTokenRaw: row.amountRaw,
    };
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_unroutable_writeoff',
      mint: row.mint,
      symbol: position.symbol,
      tokenRaw: row.amountRaw,
      costUsd,
      checks: 1,
      ageMs: 0,
      source: 'one_shot_tool',
    });
  }
  const result = await burnAndCloseOne({ connection, signer, row });
  console.log(
    `${row.mint} signature=${result.signature ?? 'none'} returnedLamports=${result.reclaimedLamports}`,
  );
}
if (commit) saveMildDipState(cfg.statePath, state);
