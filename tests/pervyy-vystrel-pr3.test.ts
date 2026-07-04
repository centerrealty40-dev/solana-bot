import { describe, expect, it, beforeEach } from 'vitest';
import {
  evaluateLiveOscarPervyyVystrelDiscovery,
  resetPervyyVystrelWatchlistForTests,
} from '../src/papertrader/live-oscar-pervyy-vystrel.js';
import {
  onboardPervyyVystrelMint,
  PHASE_A_MIN_DWELL_MS,
  PHASE_A_PEAK_MCAP_USD,
  PHASE_A_TICK_THROTTLE_MS,
  resetPervyyVystrelWatchlistForTests as resetWatchlist,
  tickPervyyVystrelWatch,
} from '../src/papertrader/pervyy-vystrel-watchlist.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { PervyyVystrelMintMaterialized } from '../src/papertrader/discovery/pervyy-vystrel-snapshot-cache.js';
import type { PervyyVystrelConfig } from '../src/papertrader/live-oscar-pervyy-vystrel-config.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

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
    minVol1hUsd: 50_000,
    surveillanceMinVol1hUsd: 50_000,
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

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'live-oscar',
    discoveryMinMarketCapUsd: 2_000_000,
    runnerLiteMinMcapUsd: 500_000,
    runnerProbeMinMcapUsd: 1_000_000,
    pervyyVystrel: basePv(),
    runnerLiteEnabled: false,
    runnerProbeEnabled: false,
    ...over,
  } as PaperTraderConfig;
}

function row(over: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'Mint1111111111111111111111111111111111111',
    symbol: 'TST',
    holder_count: 100,
    token_age_min: 900,
    ts: new Date(),
    launch_ts: null,
    age_min: 900,
    price_usd: 0.001,
    liquidity_usd: 20_000,
    volume_5m: 10_000,
    volume_1h: 60_000,
    buys_5m: 10,
    sells_5m: 5,
    market_cap_usd: 150_000,
    pair_address: 'pair',
    source: 'pumpswap',
    ...over,
  };
}

const materializedPhaseD: PervyyVystrelMintMaterialized = {
  volAuth: {
    mint: 'MintPhaseD',
    windowHours: 1,
    computedAtMs: 1_700_000_000_000,
    signals: {
      swapCount: 42,
      uniqueBuyers: 30,
      uniqueSellers: 8,
      uniqueBuyerSellerRatio: 3.75,
      roundTripShare: 0.05,
      selfTradeRatio: 0.02,
      netNewWalletShare: 0.75,
      cycleShare: 0.05,
      totalVolumeUsd: 90_000,
      holderDelta30mPct: 8,
      volumeWithoutHolderGrowth: false,
    },
    washScore: 0.1,
    organicScore: 0.72,
    authenticPass: true,
    insufficientData: false,
    reasons: [],
  },
  organicFlow: {
    mint: 'MintPhaseD',
    windowHours: 1,
    computedAtMs: 1_700_000_000_000,
    uniqueBuyers1h: 31,
    clusterBuyerRatio: 0.2,
    unclusteredBuyers: 24,
    unclusteredBuyUsd: 48_000,
    totalBuyUsd: 60_000,
    pass: true,
    shadowPass: true,
    reasons: [],
  },
  clusterMap: null,
  clusterDumpShadow: {
    mint: 'MintPhaseD',
    clusterSellRatio: 0.68,
    clusterUniqueSellers: 4,
    top3ClusterSellShare: 0.52,
    retailPanicScore: 0.21,
    pass: true,
    shadowPass: true,
    reasons: [],
  },
};

describe('pervyy-vystrel watchlist state machine (PR3)', () => {
  beforeEach(() => {
    resetWatchlist();
    resetPervyyVystrelWatchlistForTests();
  });

  it('onboards to phase_a and emits phase_a_tick (throttled)', () => {
    const t0 = 1_700_000_000_000;
    onboardPervyyVystrelMint({
      mint: 'MintA',
      refMcapUsd: 150_000,
      priceUsd: 0.001,
      nowMs: t0,
    });
    const tick1 = tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintA',
        refMcapUsd: 180_000,
        priceUsd: 0.0012,
        vol1hUsd: 55_000,
        nowMs: t0 + PHASE_A_TICK_THROTTLE_MS,
      },
    });
    expect(tick1?.state.phase).toBe('phase_a');
    expect(tick1?.journalEvents.some((e) => e.kind === 'pervyy_vystrel_phase_a_tick')).toBe(true);
  });

  it('transitions phase_a → phase_b when peak mcap threshold reached', () => {
    const t0 = 1_700_000_000_000;
    onboardPervyyVystrelMint({ mint: 'MintB', refMcapUsd: 200_000, priceUsd: 0.001, nowMs: t0 });
    const tick = tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintB',
        refMcapUsd: PHASE_A_PEAK_MCAP_USD + 10_000,
        priceUsd: 0.004,
        vol1hUsd: 80_000,
        nowMs: t0 + 60_000,
      },
    });
    expect(tick?.state.phase).toBe('phase_b');
    expect(tick?.phaseChanged).toBe(true);
  });

  it('transitions phase_b → phase_c on dump trigger (50% from peak)', () => {
    const t0 = 1_700_000_000_000;
    onboardPervyyVystrelMint({ mint: 'MintC', refMcapUsd: 200_000, priceUsd: 0.001, nowMs: t0 });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintC',
        refMcapUsd: 800_000,
        priceUsd: 0.008,
        vol1hUsd: 80_000,
        nowMs: t0 + 1000,
      },
    });
    const dumpTick = tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintC',
        refMcapUsd: 350_000,
        priceUsd: 0.0035,
        vol1hUsd: 70_000,
        nowMs: t0 + 2000,
      },
    });
    expect(dumpTick?.state.phase).toBe('phase_c');
    expect(dumpTick?.state.bottomMcapUsd).toBe(350_000);
  });

  it('confirms cluster dump → phase_d with journal events', () => {
    const t0 = 1_700_000_000_000;
    onboardPervyyVystrelMint({ mint: 'MintD', refMcapUsd: 200_000, priceUsd: 0.001, nowMs: t0 });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintD',
        refMcapUsd: 800_000,
        priceUsd: 0.008,
        vol1hUsd: 80_000,
        nowMs: t0 + 1000,
      },
    });
    const phaseCTick = tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintD',
        refMcapUsd: 200_000,
        priceUsd: 0.002,
        vol1hUsd: 60_000,
        materialized: materializedPhaseD,
        nowMs: t0 + 2000,
      },
    });
    expect(phaseCTick?.state.phase).toBe('phase_d');
    const kinds = phaseCTick?.journalEvents.map((e) => e.kind) ?? [];
    expect(kinds).toContain('pervyy_vystrel_cluster_dump_confirmed');
    expect(kinds).toContain('pervyy_vystrel_phase_d_armed');
    expect(kinds).toContain('pervyy_vystrel_phase_c_candidate');
  });

  it('retail dump → cooldown with dump_retail_skipped', () => {
    const t0 = 1_700_000_000_000;
    onboardPervyyVystrelMint({ mint: 'MintRetail', refMcapUsd: 200_000, priceUsd: 0.001, nowMs: t0 });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintRetail',
        refMcapUsd: 800_000,
        priceUsd: 0.008,
        vol1hUsd: 80_000,
        nowMs: t0 + 1000,
      },
    });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintRetail',
        refMcapUsd: 200_000,
        priceUsd: 0.002,
        vol1hUsd: 60_000,
        nowMs: t0 + 2000,
      },
    });
    const retailMat: PervyyVystrelMintMaterialized = {
      ...materializedPhaseD,
      clusterDumpShadow: {
        ...materializedPhaseD.clusterDumpShadow!,
        pass: false,
        retailPanicScore: 0.72,
        reasons: ['retail_panic>0.45'],
      },
    };
    const tick = tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintRetail',
        refMcapUsd: 200_000,
        priceUsd: 0.002,
        vol1hUsd: 60_000,
        materialized: retailMat,
        nowMs: t0 + 3000,
      },
    });
    expect(tick?.state.phase).toBe('cooldown');
    expect(tick?.journalEvents.some((e) => e.kind === 'pervyy_vystrel_dump_retail_skipped')).toBe(true);
  });

  it('phase_d phantom gates pass emits entry_signal with would_enter:false', () => {
    const t0 = 1_700_000_000_000;
    onboardPervyyVystrelMint({ mint: 'MintE', refMcapUsd: 200_000, priceUsd: 0.001, nowMs: t0 });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: { mint: 'MintE', refMcapUsd: 800_000, priceUsd: 0.008, vol1hUsd: 80_000, nowMs: t0 + 1 },
    });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintE',
        refMcapUsd: 200_000,
        priceUsd: 0.002,
        vol1hUsd: 60_000,
        materialized: materializedPhaseD,
        nowMs: t0 + 2,
      },
    });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintE',
        refMcapUsd: 200_000,
        priceUsd: 0.002,
        vol1hUsd: 60_000,
        materialized: materializedPhaseD,
        nowMs: t0 + 3,
      },
    });
    const rerampTick = tickPervyyVystrelWatch({
      cfg: basePv({ volAuthEnabled: true, organicGateEnabled: true }),
      input: {
        mint: 'MintE',
        refMcapUsd: 300_000,
        priceUsd: 0.003,
        vol1hUsd: 70_000,
        buys5m: 15,
        sells5m: 10,
        materialized: materializedPhaseD,
        nowMs: t0 + 4,
      },
    });
    expect(rerampTick?.phantomGatesPass).toBe(true);
    const entryEv = rerampTick?.journalEvents.find((e) => e.kind === 'pervyy_vystrel_entry_signal');
    expect(entryEv).toMatchObject({ would_enter: false, enter: false });
    const dCand = rerampTick?.journalEvents.find((e) => e.kind === 'pervyy_vystrel_phase_d_candidate');
    expect(dCand).toMatchObject({ pass: false, would_enter: false });
  });

  it('evaluateLiveOscarPervyyVystrelDiscovery never sets pass:true', () => {
    const cfg = baseCfg({
      pervyyVystrel: basePv({ materializeEnabled: true, organicGateEnabled: true, volAuthEnabled: true }),
    });
    const evalRes = evaluateLiveOscarPervyyVystrelDiscovery({
      cfg,
      row: row({ mint: 'MintPhaseD', market_cap_usd: 150_000, volume_1h: 90_000 }),
      lane: 'post_migration',
      refMcap: 150_000,
      ageMin: 900,
      discoveryMcap: { refMcapUsd: 150_000, source: 'pg_snapshot', pgMcapUsd: 150_000 },
      materialized: materializedPhaseD,
      nowMs: 1_700_000_000_000,
    });
    expect(evalRes.pass).toBe(false);
    expect(evalRes.shadowMode).toBe(true);
    expect(evalRes.watchlistActive).toBe(true);
  });

  it('phase_a → phase_b via 4h dwell + vol sustain', () => {
    const t0 = 1_700_000_000_000;
    onboardPervyyVystrelMint({ mint: 'MintDwell', refMcapUsd: 150_000, priceUsd: 0.001, nowMs: t0 });
    tickPervyyVystrelWatch({
      cfg: basePv(),
      input: { mint: 'MintDwell', refMcapUsd: 160_000, priceUsd: 0.001, vol1hUsd: 55_000, nowMs: t0 + 1000 },
    });
    const tick = tickPervyyVystrelWatch({
      cfg: basePv(),
      input: {
        mint: 'MintDwell',
        refMcapUsd: 170_000,
        priceUsd: 0.0011,
        vol1hUsd: 55_000,
        nowMs: t0 + PHASE_A_MIN_DWELL_MS + 1000,
      },
    });
    expect(tick?.state.phase).toBe('phase_b');
  });
});
