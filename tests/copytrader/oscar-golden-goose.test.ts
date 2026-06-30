import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCopyTraderIsolation } from '../../src/copytrader/isolation.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import { copySellableTokenRaw, copyTrackedTokenRaw } from '../../src/copytrader/position-reconcile.js';
import type { CopyPosition } from '../../src/copytrader/state.js';
import { oscarWalletMintUsdExcludingCopyLeader } from '../../src/live/copy-leader-attribution.js';

const baseCfg: CopyTraderConfig = {
  targetWallet: '498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma',
  rpcUrl: 'https://example.com',
  executionMode: 'live',
  journalPath: 'data/copytrader/journal.jsonl',
  statePath: 'data/copytrader/state.json',
  pollIntervalMs: 5000,
  signatureLimit: 25,
  tickIntervalMs: 2000,
  buyDelayMs: 5000,
  buyRetryWindowMs: 7_200_000,
  buyRetryDeferLogMs: 60_000,
  sellRetryWindowMs: 7_200_000,
  sellRetryIntervalMs: 3_000,
  sellRetryDeferLogMs: 30_000,
  sellDelayMinMs: 0,
  sellDelayMaxMs: 2000,
  positionUsd: 500,
  addPositionUsd: 500,
  maxPositionUsd: 0,
  maxAddsPerMint: 0,
  minProportionalAddUsd: 0,
  minProportionalSellFraction: 0,
  buyPriceMaxPremiumPct: 3,
  entryProbeFraction: 1,
  entryDipDiscountPct: 0,
  entryMinDeployFraction: 0.99,
  addPriceMaxPremiumPct: 0,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
  maxOpenPositions: 0,
  slippageBps: 100,
  sharedOscarWallet: true,
  spareCapitalGateEnabled: true,
  walletPubkeyExpected: '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc',
};

describe('oscar golden-goose protection', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  it('allows shared oscar wallet when COPY_TRADER_SHARED_OSCAR_WALLET=1', () => {
    const prev = process.env.COPY_TRADER_SHARED_OSCAR_WALLET;
    process.env.COPY_TRADER_SHARED_OSCAR_WALLET = '1';
    try {
      expect(() => assertCopyTraderIsolation(baseCfg)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.COPY_TRADER_SHARED_OSCAR_WALLET;
      else process.env.COPY_TRADER_SHARED_OSCAR_WALLET = prev;
    }
  });

  it('oscar can open full sizing when wallet holds copy leg only', () => {
    const mint = 'MintGoldenGoose111111111111111111111111111';
    const walletMintUsd = 500 + 2400;
    const fp = path.join(os.tmpdir(), `gg-${Date.now()}.json`);
    fs.writeFileSync(
      fp,
      JSON.stringify({
        positions: {
          [mint]: { entryDeployedCostUsd: 500, sizeUsd: 500, positionSource: 'copy_leader' },
        },
      }),
    );
    tmpFiles.push(fp);

    const attributed = oscarWalletMintUsdExcludingCopyLeader({
      walletMintUsd,
      mint,
      statePath: fp,
    });
    expect(attributed).toBe(2400);
  });

  it('shared wallet sells only copy-tracked tokens, not full wallet', () => {
    const pos: CopyPosition = {
      mint: 'm',
      symbol: 'T',
      positionSource: 'copy_leader',
      entryTs: Date.now(),
      entryPriceUsd: 1,
      sizeUsd: 500,
      tokenRaw: '500000000',
      addCount: 0,
      leaderWallet: baseCfg.targetWallet,
      leaderEntrySig: 'sig',
    };
    expect(copyTrackedTokenRaw(pos)).toBe(500_000_000n);
    expect(copySellableTokenRaw({ ...baseCfg, sharedOscarWallet: true }, pos)).toBe(500_000_000n);
  });
});
