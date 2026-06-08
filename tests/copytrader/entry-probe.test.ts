import { describe, expect, it } from 'vitest';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import {
  entryMinDeployUsd,
  isEntryFullyDeployed,
  resolveEntryDeployedCostUsd,
  shouldAbandonEntryDipOnLeaderSell,
} from '../../src/copytrader/entry-deploy.js';
import type { CopyPosition, CopyTraderState } from '../../src/copytrader/state.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';
import {
  entryDipMaxPriceUsd,
  entryDipSizeUsd,
  entryProbeSizeUsd,
  leaderDipTargetPx,
  usesDipOnlyEntry,
  usesSplitEntryProbe,
} from '../../src/copytrader/entry-probe.js';
import { evaluateCopyAdd, evaluateCopyEntryDip } from '../../src/copytrader/evaluate.js';

const baseCfg = {
  positionUsd: 950,
  entryProbeFraction: 350 / 950,
  entryDipDiscountPct: 4,
  entryMinDeployFraction: 0.99,
  addPriceMaxPremiumPct: 0,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
} as CopyTraderConfig;

describe('entry-probe sizing', () => {
  it('splits $350 probe + $600 dip on $950 position', () => {
    expect(usesSplitEntryProbe(baseCfg)).toBe(true);
    expect(entryProbeSizeUsd(baseCfg)).toBe(350);
    expect(entryDipSizeUsd(baseCfg)).toBe(600);
  });

  it('leader dip target at -4%', () => {
    expect(leaderDipTargetPx(0.001, 4)).toBeCloseTo(0.00096, 8);
  });

  it('dip-only when probe fraction is 0', () => {
    const cfg = { ...baseCfg, entryProbeFraction: 0 } as CopyTraderConfig;
    expect(usesDipOnlyEntry(cfg)).toBe(true);
    expect(entryDipSizeUsd(cfg)).toBe(950);
  });

  it('full deploy requires 99% of positionUsd on split entry', () => {
    expect(entryMinDeployUsd(baseCfg)).toBe(940.5);
    expect(isEntryFullyDeployed(baseCfg, 350)).toBe(false);
    expect(isEntryFullyDeployed(baseCfg, 940.5)).toBe(true);
    expect(isEntryFullyDeployed(baseCfg, 950)).toBe(true);
  });

  it('abandon dip when leader sells before full deploy', () => {
    const state = emptyCopyTraderState();
    const probeOnly: CopyPosition = {
      mint: 'Mint1111111111111111111111111111111111111',
      symbol: 'GO',
      entryTs: Date.now(),
      entryPriceUsd: 0.00068,
      sizeUsd: 350,
      entryDeployedCostUsd: 350,
      addCount: 0,
      leaderWallet: 'Leader111111111111111111111111111111111111',
      leaderEntrySig: 'sig',
    };
    state.positions[probeOnly.mint] = probeOnly;
    state.pendingBuys.push({
      id: 'pb1',
      mint: probeOnly.mint,
      symbol: 'GO',
      kind: 'entry',
      entryLeg: 'dip',
      sizeUsd: 600,
      leaderSignature: 'sig',
      leaderPriceUsd: 0.0007,
      leaderBuyUsd: 400,
      leaderBuyTs: Date.now(),
      dueTs: Date.now() + 60_000,
      retryUntilTs: Date.now() + 3_600_000,
    });
    expect(shouldAbandonEntryDipOnLeaderSell(baseCfg, state, probeOnly)).toBe(true);

    const fullEntry: CopyPosition = { ...probeOnly, entryDeployedCostUsd: 950, sizeUsd: 690 };
    state.positions[fullEntry.mint] = fullEntry;
    state.pendingBuys = [];
    expect(shouldAbandonEntryDipOnLeaderSell(baseCfg, state, fullEntry)).toBe(false);
  });

  it('GO-style: full entry cost allows adds even when mtm sizeUsd dropped', () => {
    const state = emptyCopyTraderState();
    const pos: CopyPosition = {
      mint: 'CujZ5W6GWYb5XYe3hsTJ6kjiaw5MdZjbKQEuGA6jpump',
      symbol: 'GO',
      entryTs: Date.now(),
      entryPriceUsd: 0.00068,
      sizeUsd: 689.79,
      entryDeployedCostUsd: 950,
      addCount: 1,
      leaderWallet: 'Leader111111111111111111111111111111111111',
      leaderEntrySig: 'sig',
    };
    state.positions[pos.mint] = pos;
    expect(resolveEntryDeployedCostUsd(baseCfg, state, pos)).toBe(950);
    expect(isEntryFullyDeployed(baseCfg, resolveEntryDeployedCostUsd(baseCfg, state, pos))).toBe(true);
  });

  it('legacy position infers full staged entry when dip pending is gone', () => {
    const state = emptyCopyTraderState();
    const pos: CopyPosition = {
      mint: 'CujZ5W6GWYb5XYe3hsTJ6kjiaw5MdZjbKQEuGA6jpump',
      symbol: 'GO',
      entryTs: Date.now(),
      entryPriceUsd: 0.00068,
      sizeUsd: 689.79,
      addCount: 1,
      leaderWallet: 'Leader111111111111111111111111111111111111',
      leaderEntrySig: 'sig',
    };
    state.positions[pos.mint] = pos;
    expect(resolveEntryDeployedCostUsd(baseCfg, state, pos)).toBe(950);
    expect(isEntryFullyDeployed(baseCfg, resolveEntryDeployedCostUsd(baseCfg, state, pos))).toBe(true);
  });
});

describe('evaluateCopyEntryDip', () => {
  const dex = {
    symbol: 'TEST',
    name: 'Test',
    priceUsd: 0.00094,
    marketCap: 500_000,
    liquidityUsd: 40_000,
    volume24h: 100_000,
    volume1h: 5_000,
    pairCreatedAtMs: Date.now() - 48 * 3600_000,
    dexId: 'raydium',
  };

  it('passes at -4% from leader', () => {
    const r = evaluateCopyEntryDip(
      { ...baseCfg, entryDipDiscountPct: 4 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 400,
        currentPriceUsd: 0.00096,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(true);
  });

  it('rejects above dip threshold', () => {
    const r = evaluateCopyEntryDip(
      { ...baseCfg, entryDipDiscountPct: 4 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 400,
        currentPriceUsd: 0.00097,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('price_not_low_enough'))).toBe(true);
  });

  it('rejects dip near probe when probe bought below leader (GO-style)', () => {
    const cfg = { ...baseCfg, entryDipDiscountPct: 4, entryDipVsProbePct: 2 } as CopyTraderConfig;
    const leaderPriceUsd = 0.00070484;
    const probeEntryPriceUsd = 0.00068048;
    const dipQuoteUsd = 0.00067644;
    expect(entryDipMaxPriceUsd(cfg, leaderPriceUsd, probeEntryPriceUsd)).toBeLessThan(dipQuoteUsd);

    const r = evaluateCopyEntryDip(cfg, {
      mint: 'Mint1111111111111111111111111111111111111',
      leaderPriceUsd,
      leaderBuyUsd: 400,
      currentPriceUsd: dipQuoteUsd,
      probeEntryPriceUsd,
      dex,
      nowMs: Date.now(),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('probe_cap'))).toBe(true);
  });

  it('passes dip when quote is below probe discount cap', () => {
    const cfg = { ...baseCfg, entryDipDiscountPct: 4, entryDipVsProbePct: 2 } as CopyTraderConfig;
    const leaderPriceUsd = 0.00070484;
    const probeEntryPriceUsd = 0.00068048;
    const r = evaluateCopyEntryDip(cfg, {
      mint: 'Mint1111111111111111111111111111111111111',
      leaderPriceUsd,
      leaderBuyUsd: 400,
      currentPriceUsd: 0.000666,
      probeEntryPriceUsd,
      dex,
      nowMs: Date.now(),
    });
    expect(r.pass).toBe(true);
  });
});

describe('evaluateCopyAdd', () => {
  const dex = {
    symbol: 'TEST',
    name: 'Test',
    priceUsd: 0.0009,
    marketCap: 500_000,
    liquidityUsd: 40_000,
    volume24h: 100_000,
    volume1h: 5_000,
    pairCreatedAtMs: Date.now() - 48 * 3600_000,
    dexId: 'raydium',
  };

  it('passes at leader add price', () => {
    const r = evaluateCopyAdd(
      { ...baseCfg, addPriceMaxPremiumPct: 0 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 200,
        currentPriceUsd: 0.001,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(true);
  });

  it('rejects above leader add price when premium is 0', () => {
    const r = evaluateCopyAdd(
      { ...baseCfg, addPriceMaxPremiumPct: 0 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 200,
        currentPriceUsd: 0.00101,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('add_price_too_high'))).toBe(true);
  });
});
