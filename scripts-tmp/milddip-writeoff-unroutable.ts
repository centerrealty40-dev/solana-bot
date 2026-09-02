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

const PROTECT_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  'So11111111111111111111111111111111111111112',
];

const rows = await listOrphanTokenAccounts({
  rpcUrl: cfg.rpcUrl,
  owner,
  protectMints: PROTECT_MINTS,
});
const connection = new Connection(cfg.rpcUrl, 'confirmed');
const signer = loadLiveKeypairFromSecretEnv(cfg.walletSecret);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowMs = Date.now();
const worthlessMaxUsd =
  cfg.worthlessWriteoffMaxUsd > 0 ? cfg.worthlessWriteoffMaxUsd : 0.05;

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
    isWorthless: (value) => {
      if (value.kind !== 'ok') return false;
      const valueUsd = value.jupiterPriceUsd * tokenAmount;
      return Number.isFinite(valueUsd) && valueUsd <= worthlessMaxUsd;
    },
  });
  const valueUsd =
    probe.first.kind === 'ok' ? probe.first.jupiterPriceUsd * tokenAmount : null;
  console.log(
    `${row.mint} status=${probe.status} valueUsd=${valueUsd ?? 'n/a'} tokenRaw=${row.amountRaw}`,
  );
  if (
    (probe.status !== 'unroutable' && probe.status !== 'worthless') ||
    !commit
  ) continue;

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
      costBasisUsdFallback: costUsd,
      markPnlPct: -100,
      reason: probe.status === 'worthless' ? 'worthless_writeoff' : 'unroutable_writeoff',
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
      mode: probe.status === 'worthless' ? 'worthless' : 'unroutable',
      source: 'one_shot_tool',
    });
  }
  const result = await burnAndCloseOne({ connection, signer, row });
  console.log(
    `${row.mint} signature=${result.signature ?? 'none'} returnedLamports=${result.reclaimedLamports}`,
  );
}
if (commit) saveMildDipState(cfg.statePath, state);
