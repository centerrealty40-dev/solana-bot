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
  entryScheduleDelayMs,
  entryTargetUsd,
  isEntryProbePending,
  isLowMcapEntryTier,
  leaderDipTargetPx,
  leaderInitialEntryUsd,
  resolveEntryBuyDelayMs,
  usesDipOnlyEntry,
  usesInitialLeaderMirror,
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

const prodEntryCfg = {
  positionUsd: 1000,
  entryProbeFraction: 500 / 1000,
  entryDipDiscountPct: 10,
  entryMinDeployFraction: 0.99,
  addPriceMaxPremiumPct: 0,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
} as CopyTraderConfig;

describe('entry-probe sizing', () => {
  it('mirrors 50% of leader buy on initial entry when configured', () => {
    const mirrorCfg = {
      ...prodEntryCfg,
      initialMirrorRatio: 0.5,
      minMirrorEntryUsd: 0,
      entryProbeFraction: 1,
      entryDipDiscountPct: 0,
    } as CopyTraderConfig;
    expect(usesInitialLeaderMirror(mirrorCfg)).toBe(true);
    expect(leaderInitialEntryUsd(mirrorCfg, 1000)).toBe(500);
    expect(entryTargetUsd(mirrorCfg, undefined, 1000)).toBe(500);
    expect(entryProbeSizeUsd(mirrorCfg, undefined, 1000)).toBe(500);
    expect(entryDipSizeUsd(mirrorCfg, undefined, 1000)).toBe(0);
    expect(entryTargetUsd(mirrorCfg, undefined, 400)).toBe(200);
  });

  it('floors mirrored entry at minMirrorEntryUsd', () => {
    const mirrorCfg = {
      ...prodEntryCfg,
      initialMirrorRatio: 0.5,
      minMirrorEntryUsd: 100,
      entryProbeFraction: 1,
      entryDipDiscountPct: 0,
    } as CopyTraderConfig;
    expect(leaderInitialEntryUsd(mirrorCfg, 1000)).toBe(500);
    expect(leaderInitialEntryUsd(mirrorCfg, 150)).toBe(100);
    expect(entryTargetUsd(mirrorCfg, undefined, 150)).toBe(100);
  });

  it('caps mirrored entry at maxPositionUsd', () => {
    const mirrorCfg = {
      ...prodEntryCfg,
      initialMirrorRatio: 0.7,
      minMirrorEntryUsd: 120,
      maxPositionUsd: 500,
      entryProbeFraction: 1,
      entryDipDiscountPct: 0,
    } as CopyTraderConfig;
    expect(leaderInitialEntryUsd(mirrorCfg, 1100)).toBe(500);
    expect(entryTargetUsd(mirrorCfg, undefined, 1100)).toBe(500);
    expect(entryTargetUsd(mirrorCfg, undefined, 400)).toBe(280);
  });

  it('uses fixed $50 clip for mcap $30k–$150k even with leader mirror', () => {
    const cfg = {
      ...prodEntryCfg,
      initialMirrorRatio: 0.5,
      minMirrorEntryUsd: 100,
      entryProbeFraction: 1,
      entryDipDiscountPct: 0,
      entryLowMcapMinUsd: 30_000,
      entryLowMcapMaxUsd: 150_000,
      entryLowPositionUsd: 50,
    } as CopyTraderConfig;
    expect(isLowMcapEntryTier(cfg, 80_000)).toBe(true);
    expect(entryTargetUsd(cfg, 80_000, 1_000)).toBe(50);
    expect(entryTargetUsd(cfg, 30_000, 1_000)).toBe(50);
    expect(isLowMcapEntryTier(cfg, 150_000)).toBe(false);
    expect(entryTargetUsd(cfg, 150_000, 1_000)).toBe(500);
    expect(entryTargetUsd(cfg, 20_000, 1_000)).toBe(500);
  });

  it('uses two fixed mcap clips: $100k–$200k → $50, $200k–$300k → $100', () => {
    const cfg = {
      ...prodEntryCfg,
      initialMirrorRatio: 0.8,
      minMirrorEntryUsd: 200,
      maxPositionUsd: 700,
      entryProbeFraction: 1,
      entryDipDiscountPct: 0,
      entryLowMcapMinUsd: 100_000,
      entryLowMcapMaxUsd: 200_000,
      entryLowPositionUsd: 50,
      entryLow2McapMinUsd: 200_000,
      entryLow2McapMaxUsd: 300_000,
      entryLow2PositionUsd: 100,
    } as CopyTraderConfig;
    expect(entryTargetUsd(cfg, 150_000, 1_000)).toBe(50);
    expect(entryTargetUsd(cfg, 199_999, 1_000)).toBe(50);
    expect(entryTargetUsd(cfg, 200_000, 1_000)).toBe(100);
    expect(entryTargetUsd(cfg, 250_000, 1_000)).toBe(100);
    expect(isLowMcapEntryTier(cfg, 300_000)).toBe(false);
    expect(entryTargetUsd(cfg, 300_000, 1_000)).toBe(700);
  });

  it('keeps fixed positionUsd when initialMirrorRatio is 0', () => {
    const fixedCfg = { ...prodEntryCfg, initialMirrorRatio: 0 } as CopyTraderConfig;
    expect(usesInitialLeaderMirror(fixedCfg)).toBe(false);
    expect(entryTargetUsd(fixedCfg, undefined, 1000)).toBe(1000);
  });

  it('splits $500 probe + $500 dip on $1000 position (prod)', () => {
    expect(usesSplitEntryProbe(prodEntryCfg)).toBe(true);
    expect(entryProbeSizeUsd(prodEntryCfg)).toBe(500);
    expect(entryDipSizeUsd(prodEntryCfg)).toBe(500);
  });

  it('splits $300+$300 when mcap is $500k–$1M', () => {
    const midTierCfg = {
      ...prodEntryCfg,
      entryFullMcapUsd: 1_000_000,
      entryMidPositionUsd: 600,
      entryMidLegUsd: 300,
    } as CopyTraderConfig;
    expect(entryTargetUsd(midTierCfg, 750_000)).toBe(600);
    expect(entryProbeSizeUsd(midTierCfg, 750_000)).toBe(300);
    expect(entryDipSizeUsd(midTierCfg, 750_000)).toBe(300);
    expect(entryMinDeployUsd(midTierCfg, { entryMcapUsd: 750_000 } as CopyPosition)).toBe(594);
  });

  it('keeps $500+$500 when mcap ≥ $1M', () => {
    const midTierCfg = {
      ...prodEntryCfg,
      entryFullMcapUsd: 1_000_000,
      entryMidPositionUsd: 600,
      entryMidLegUsd: 300,
    } as CopyTraderConfig;
    expect(entryTargetUsd(midTierCfg, 1_500_000)).toBe(1000);
    expect(entryProbeSizeUsd(midTierCfg, 1_500_000)).toBe(500);
    expect(entryDipSizeUsd(midTierCfg, 1_500_000)).toBe(500);
  });

  it('splits $350 probe + $600 dip on $950 position (legacy)', () => {
    expect(usesSplitEntryProbe(baseCfg)).toBe(true);
    expect(entryProbeSizeUsd(baseCfg)).toBe(350);
    expect(entryDipSizeUsd(baseCfg)).toBe(600);
  });

  it('leader dip target at -10%', () => {
    expect(leaderDipTargetPx(0.001, 10)).toBeCloseTo(0.0009, 8);
  });

  it('leader dip target at -4% (legacy)', () => {
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

describe('entryScheduleDelayMs', () => {
  const cfg = {
    ...prodEntryCfg,
    buyDelayMs: 30_000,
    entryProbeBuyDelayMs: 0,
  } as CopyTraderConfig;

  it('probe leg fires immediately after leader', () => {
    expect(entryScheduleDelayMs(cfg, { kind: 'entry', entryLeg: 'probe' })).toBe(0);
  });

  it('dip leg schedules without extra buy delay', () => {
    expect(entryScheduleDelayMs(cfg, { kind: 'entry', entryLeg: 'dip' })).toBe(0);
  });

  it('adds keep leader buy delay', () => {
    expect(entryScheduleDelayMs(cfg, { kind: 'add' })).toBe(30_000);
  });
});

describe('resolveEntryBuyDelayMs', () => {
  const cfg = {
    ...prodEntryCfg,
    buyDelayMs: 10_000,
    entryProbeBuyDelayMs: 0,
    buyDelaySkipMaxPremiumPct: 2,
  } as CopyTraderConfig;

  it('skips delay when mark is within +2%', () => {
    expect(
      resolveEntryBuyDelayMs(cfg, {
        kind: 'entry',
        leaderPriceUsd: 1,
        currentPriceUsd: 1.02,
      }),
    ).toBe(0);
  });

  it('keeps delay when mark is above +2%', () => {
    expect(
      resolveEntryBuyDelayMs(cfg, {
        kind: 'entry',
        leaderPriceUsd: 1,
        currentPriceUsd: 1.021,
      }),
    ).toBe(10_000);
  });

  it('keeps delay when mark is unknown', () => {
    expect(
      resolveEntryBuyDelayMs(cfg, {
        kind: 'entry',
        leaderPriceUsd: 1,
        currentPriceUsd: null,
      }),
    ).toBe(10_000);
  });
});

describe('isEntryProbePending', () => {
  it('treats probe and full entry as probe path', () => {
    expect(isEntryProbePending({ kind: 'entry', entryLeg: 'probe', usesDipOnly: false })).toBe(true);
    expect(isEntryProbePending({ kind: 'entry', usesDipOnly: false })).toBe(true);
    expect(isEntryProbePending({ kind: 'entry', entryLeg: 'dip', usesDipOnly: false })).toBe(false);
    expect(isEntryProbePending({ kind: 'entry', entryLeg: 'dip', usesDipOnly: true })).toBe(false);
  });
});
