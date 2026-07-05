import { describe, expect, it } from 'vitest';
import {
  buildEarlyClusterMapFromSwaps,
  evaluateClusterDumpShadow,
} from '../src/papertrader/discovery/mint-early-cluster-map.js';
import {
  evaluateOrganicFlowGate,
  type OrganicFlowBuyerRow,
} from '../src/papertrader/discovery/mint-organic-flow-gate.js';
import {
  computeVolumeAuthenticitySnapshot,
  type VolAuthSwapRow,
  volumeAuthenticityThresholdsFromConfig,
} from '../src/papertrader/discovery/mint-volume-authenticity.js';
import type { PervyyVystrelConfig } from '../src/papertrader/live-oscar-pervyy-vystrel-config.js';

function basePv(over: Partial<PervyyVystrelConfig> = {}): PervyyVystrelConfig {
  return {
    enabled: false,
    mode: 'shadow',
    failOpen: true,
    legUsd: 25,
    positionUsd: 50,
    maxConcurrent: 4,
    maxExposureUsd: 200,
    stagedEntry: true,
    anchorMinMcapUsd: 100_000,
    anchorMaxMcapUsd: 250_000,
    entryMaxMcapUsd: 1_000_000,
    minVol1hUsd: 60_000,
    surveillanceMinVol1hUsd: 60_000,
    minAgeMin: 720,
    maxAgeMin: 2880,
    dumpMinPct: 50,
    dumpMinMultiple: 3,
    clusterSellRatioMin: 0.55,
    retailPanicMax: 0.45,
    minUniqueBuyers1h: 25,
    maxClusterBuyerRatio: 0.35,
    rerampMinFromBottomPct: 35,
    rerampMaxVsPeakPct: 0.85,
    watchTtlHours: 72,
    holderPollMin: 5,
    earlyBuyWindowSec: 180,
    killPct: 0.5,
    maxEntriesPerTick: 1,
    organicGateEnabled: false,
    organicGateMode: 'shadow',
    clusterDumpMode: 'shadow',
    volAuthEnabled: false,
    volAuthMode: 'shadow',
    volAuthWashMax: 0.55,
    volAuthOrganicMin: 0.45,
    volAuthMaxRoundTripShare: 0.45,
    volAuthFailOpen: true,
    volAuthWindowHours: 1,
    volAuthMinSwaps: 20,
    volAuthMaxCycleShare: 0.35,
    volAuthMinBsRatio: 1.15,
    volAuthMaxSelfTrade: 0.25,
    volAuthMinNetNewShare: 0.4,
    volAuthHolderStallPct: 0.5,
    minUnclusteredBuyers1h: 15,
    materializeEnabled: false,
    materializeIntervalMin: 15,
    ...over,
  };
}

function mkSwap(
  wallet: string,
  side: 'buy' | 'sell',
  usd: number,
  offsetMin: number,
  t0 = 1_700_000_000_000,
): VolAuthSwapRow {
  return {
    wallet,
    side,
    amountUsd: usd,
    blockTimeMs: t0 + offsetMin * 60_000,
  };
}

describe('mint-volume-authenticity (PR2)', () => {
  const thresholds = volumeAuthenticityThresholdsFromConfig(basePv());

  it('flags wash pattern: round-trip wallets, low net-new share', () => {
    const swaps: VolAuthSwapRow[] = [];
    for (let i = 0; i < 10; i++) {
      const w = `wash${i}`;
      swaps.push(mkSwap(w, 'buy', 5000, i));
      swaps.push(mkSwap(w, 'sell', 4800, i + 1));
    }
    for (let i = 0; i < 12; i++) {
      swaps.push(mkSwap(`extra${i}`, 'buy', 500, 30 + i));
    }

    const snap = computeVolumeAuthenticitySnapshot({
      mint: 'MintWash',
      windowHours: 1,
      swaps,
      thresholds,
    });

    expect(snap.insufficientData).toBe(false);
    expect(snap.signals.roundTripShare).toBeGreaterThan(0.4);
    expect(snap.washScore).toBeGreaterThan(0.5);
    expect(snap.authenticPass).toBe(false);
  });

  it('passes organic pattern: many unique buyers, net-new dominant', () => {
    const swaps: VolAuthSwapRow[] = [];
    for (let i = 0; i < 30; i++) {
      swaps.push(mkSwap(`buyer${i}`, 'buy', 2000, i % 50));
    }
    for (let i = 0; i < 8; i++) {
      swaps.push(mkSwap(`seller${i}`, 'sell', 800, 40 + i));
    }

    const snap = computeVolumeAuthenticitySnapshot({
      mint: 'MintOrganic',
      windowHours: 1,
      swaps,
      thresholds,
    });

    expect(snap.authenticPass).toBe(true);
    expect(snap.organicScore).toBeGreaterThanOrEqual(thresholds.organicMin);
    expect(snap.washScore).toBeLessThan(thresholds.washMax);
  });

  it('fail-open when swap count below minSwaps', () => {
    const snap = computeVolumeAuthenticitySnapshot({
      mint: 'MintSparse',
      windowHours: 1,
      swaps: [mkSwap('a', 'buy', 100, 0)],
      thresholds: { ...thresholds, failOpen: true },
    });
    expect(snap.insufficientData).toBe(true);
    expect(snap.authenticPass).toBe(true);
  });
});

describe('mint-organic-flow-gate (PR2)', () => {
  it('passes diverse unclustered buyers', () => {
    const buyers: OrganicFlowBuyerRow[] = [];
    for (let i = 0; i < 30; i++) {
      buyers.push({ wallet: `w${i}`, buyUsd: 1000, clusterId: i < 5 ? 'clusterA' : null });
    }
    const res = evaluateOrganicFlowGate({
      mint: 'MintOrganic',
      windowHours: 1,
      buyers,
      thresholds: {
        minUniqueBuyers1h: 25,
        maxClusterBuyerRatio: 0.35,
        minUnclusteredBuyers: 15,
      },
    });
    expect(res.pass).toBe(true);
    expect(res.unclusteredBuyers).toBeGreaterThanOrEqual(15);
  });

  it('fails high cluster buyer concentration', () => {
    const buyers: OrganicFlowBuyerRow[] = [];
    for (let i = 0; i < 30; i++) {
      buyers.push({ wallet: `w${i}`, buyUsd: 1000, clusterId: 'clusterA' });
    }
    const res = evaluateOrganicFlowGate({
      mint: 'MintCluster',
      windowHours: 1,
      buyers,
      thresholds: {
        minUniqueBuyers1h: 25,
        maxClusterBuyerRatio: 0.35,
        minUnclusteredBuyers: 15,
      },
    });
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.includes('cluster_buyer_ratio'))).toBe(true);
  });
});

describe('mint-early-cluster-map shadow (PR2)', () => {
  it('builds early wallet map within window', () => {
    const t0 = 1_700_000_000_000;
    const swaps = [
      { wallet: 'early1', side: 'buy', amountUsd: 5000, blockTimeMs: t0 },
      { wallet: 'early2', side: 'buy', amountUsd: 3000, blockTimeMs: t0 + 60_000 },
      { wallet: 'late1', side: 'buy', amountUsd: 9000, blockTimeMs: t0 + 400_000 },
    ];
    const clusters = new Map([
      ['early1', 'c1'],
      ['early2', 'c1'],
    ]);
    const map = buildEarlyClusterMapFromSwaps({
      mint: 'MintEarly',
      swaps,
      earlyBuyWindowSec: 180,
      walletClusters: clusters,
    });
    expect(map.earlyWallets.length).toBe(2);
    expect(map.clusterWalletIds).toContain('early1');
  });

  it('cluster dump shadow detects cabal sell concentration', () => {
    const t0 = 1_700_000_000_000;
    const clusterMap = buildEarlyClusterMapFromSwaps({
      mint: 'MintDump',
      swaps: [
        { wallet: 'c1', side: 'buy', amountUsd: 5000, blockTimeMs: t0 },
        { wallet: 'c2', side: 'buy', amountUsd: 4000, blockTimeMs: t0 + 1000 },
        { wallet: 'c3', side: 'buy', amountUsd: 3000, blockTimeMs: t0 + 2000 },
      ],
      earlyBuyWindowSec: 180,
      walletClusters: new Map([
        ['c1', 'cl'],
        ['c2', 'cl'],
        ['c3', 'cl'],
      ]),
    });
    const dumpSells = [
      { wallet: 'c1', side: 'sell', amountUsd: 8000, blockTimeMs: t0 + 3_600_000 },
      { wallet: 'c2', side: 'sell', amountUsd: 7000, blockTimeMs: t0 + 3_600_100 },
      { wallet: 'c3', side: 'sell', amountUsd: 6000, blockTimeMs: t0 + 3_600_200 },
      { wallet: 'retail1', side: 'sell', amountUsd: 1000, blockTimeMs: t0 + 3_600_300 },
    ];
    const evalRes = evaluateClusterDumpShadow({
      mint: 'MintDump',
      clusterMap,
      dumpSells,
    });
    expect(evalRes.clusterSellRatio).toBeGreaterThan(0.55);
    expect(evalRes.clusterUniqueSellers).toBeGreaterThanOrEqual(3);
    expect(evalRes.pass).toBe(true);
  });
});
