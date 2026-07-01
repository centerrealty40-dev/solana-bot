import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import {
  checkCopyBuyOscarDupGuard,
  checkCopyBuyWalletCapGuard,
  copyTraderSharesPresetCWallet,
  oscarHasOpenPositionOnMint,
  shouldIgnoreLeaderForMint,
  skipBuyOpenWalletMintMinUsd,
} from '../../src/copytrader/oscar-position-guard.js';
import { COPY_TRADER_TOKEN_UI_SCALE } from '../../src/copytrader/position-reconcile.js';
import type { CopyPosition } from '../../src/copytrader/state.js';
import { LIVE_OPEN_SNAPSHOT_VERSION } from '../../src/live/open-snapshot.js';

const mint = 'MintOscarDup111111111111111111111111111';
const presetMint = 'MintPresetC111111111111111111111111111111';

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
  spareCapitalGateEnabled: false,
};

describe('copy-trader oscar position guard', () => {
  const tmpFiles: string[] = [];
  const prevMinUsd = process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD;
  const prevCopyWallet = process.env.COPY_TRADER_WALLET_PUBKEY;
  const prevPresetWallet = process.env.COPY_TRADER_PRESET_C_WALLET_PUBKEY;

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    if (prevMinUsd === undefined) delete process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD;
    else process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD = prevMinUsd;
    if (prevCopyWallet === undefined) delete process.env.COPY_TRADER_WALLET_PUBKEY;
    else process.env.COPY_TRADER_WALLET_PUBKEY = prevCopyWallet;
    if (prevPresetWallet === undefined) delete process.env.COPY_TRADER_PRESET_C_WALLET_PUBKEY;
    else process.env.COPY_TRADER_PRESET_C_WALLET_PUBKEY = prevPresetWallet;
  });

  function tmpFile(suffix: string): string {
    const fp = path.join(os.tmpdir(), `ct-dup-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
    tmpFiles.push(fp);
    return fp;
  }

  function writeSnapshot(fp: string, mints: string[]): void {
    fs.writeFileSync(
      fp,
      JSON.stringify({
        version: LIVE_OPEN_SNAPSHOT_VERSION,
        strategyId: 'live-oscar',
        updatedAtMs: Date.now(),
        openCount: mints.length,
        positions: mints.map((m) => ({
          mint: m,
          openTrade: { mint: m, totalInvestedUsd: 120, remainingFraction: 1 },
        })),
      }),
    );
  }

  it('does not guard when sharedOscarWallet is false', () => {
    const snap = tmpFile('.json');
    writeSnapshot(snap, [mint]);
    expect(
      shouldIgnoreLeaderForMint({
        cfg: { ...baseCfg, sharedOscarWallet: false },
        mint,
        snapshotPath: snap,
      }).ignore,
    ).toBe(false);
  });

  it('shouldIgnoreLeaderForMint when Oscar open snapshot contains mint', () => {
    const snap = tmpFile('.json');
    writeSnapshot(snap, [mint]);
    expect(oscarHasOpenPositionOnMint(mint, snap)).toBe(true);
    expect(
      shouldIgnoreLeaderForMint({
        cfg: baseCfg,
        mint,
        snapshotPath: snap,
      }),
    ).toEqual({ ignore: true, reason: 'oscar_position_open' });
  });

  it('checkCopyBuyOscarDupGuard maps oscar_position_open to already_in_oscar_position', () => {
    const snap = tmpFile('.json');
    writeSnapshot(snap, [mint]);
    const verdict = checkCopyBuyOscarDupGuard({
      cfg: baseCfg,
      mint,
      snapshotPath: snap,
    });
    expect(verdict).toEqual({ skip: true, reason: 'already_in_oscar_position' });
  });

  it('reads preset-c snapshot only when copy wallet matches preset-c wallet', () => {
    const presetSnap = tmpFile('-preset.json');
    writeSnapshot(presetSnap, [presetMint]);
    process.env.COPY_TRADER_WALLET_PUBKEY = 'SameWallet111111111111111111111111111111';
    process.env.COPY_TRADER_PRESET_C_WALLET_PUBKEY = 'SameWallet111111111111111111111111111111';

    expect(
      copyTraderSharesPresetCWallet({
        ...baseCfg,
        walletPubkeyExpected: 'SameWallet111111111111111111111111111111',
      }),
    ).toBe(true);

    expect(
      shouldIgnoreLeaderForMint({
        cfg: baseCfg,
        mint: presetMint,
        snapshotPath: presetSnap,
      }),
    ).toEqual({ ignore: true, reason: 'oscar_position_open' });

    expect(
      shouldIgnoreLeaderForMint({
        cfg: baseCfg,
        mint: presetMint,
      }).ignore,
    ).toBe(false);

    process.env.COPY_TRADER_PRESET_C_OPEN_SNAPSHOT_PATH = presetSnap;
    expect(
      shouldIgnoreLeaderForMint({
        cfg: {
          ...baseCfg,
          walletPubkeyExpected: 'SameWallet111111111111111111111111111111',
        },
        mint: presetMint,
      }),
    ).toEqual({ ignore: true, reason: 'oscar_position_open' });
  });

  it('skips when wallet holds Oscar leg over LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD', () => {
    process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD = '30';
    expect(skipBuyOpenWalletMintMinUsd()).toBe(30);

    const statePath = tmpFile('-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ positions: {} }));

    const priceUsd = 1;
    const walletRaw = BigInt(Math.floor(50 * COPY_TRADER_TOKEN_UI_SCALE));
    const verdict = checkCopyBuyWalletCapGuard({
      cfg: { ...baseCfg, statePath },
      mint,
      walletMintRaw: walletRaw,
      priceUsd,
      statePath,
    });
    expect(verdict.skip).toBe(true);
    if (verdict.skip) {
      expect(verdict.reason).toBe('wallet_holds_mint_over_usd_cap');
      expect(verdict.estUsd).toBe(50);
      expect(verdict.minUsd).toBe(30);
    }
  });

  it('allows entry when only copy-attributed wallet value remains', () => {
    process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD = '30';
    const statePath = tmpFile('-state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        positions: {
          [mint]: { entryDeployedCostUsd: 500, sizeUsd: 500, positionSource: 'copy_leader' },
        },
      }),
    );

    const priceUsd = 1;
    const walletRaw = BigInt(Math.floor(500 * COPY_TRADER_TOKEN_UI_SCALE));
    const verdict = checkCopyBuyWalletCapGuard({
      cfg: { ...baseCfg, statePath },
      mint,
      walletMintRaw: walletRaw,
      priceUsd,
      statePath,
    });
    expect(verdict.skip).toBe(false);
  });

  it('shouldIgnoreLeaderForMint when copy leg was promoted to Oscar', () => {
    const statePath = tmpFile('-state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        positions: {
          [mint]: {
            entryDeployedCostUsd: 500,
            sizeUsd: 500,
            positionSource: 'copy_leader',
            oscarPromotedAt: Date.now(),
          },
        },
      }),
    );

    const pos: CopyPosition = {
      mint,
      symbol: 'T',
      positionSource: 'copy_leader',
      entryTs: Date.now(),
      entryPriceUsd: 1,
      sizeUsd: 500,
      tokenRaw: '500000000',
      addCount: 0,
      leaderWallet: baseCfg.targetWallet,
      leaderEntrySig: 'sig',
      oscarPromotedAt: Date.now(),
    };

    expect(
      shouldIgnoreLeaderForMint({
        cfg: { ...baseCfg, statePath },
        mint,
        copyPosition: pos,
        statePath,
      }),
    ).toEqual({ ignore: true, reason: 'oscar_promoted_handoff' });
  });
});
