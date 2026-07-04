import { describe, expect, it } from 'vitest';
import {
  resolveDiscoveryHardMcapMinUsd,
  resolveDiscoverySqlMinMarketCapUsd,
} from '../src/papertrader/discovery/discovery-mcap-floor.js';
import {
  evaluatePervyyVystrelShadowAnalyzers,
  evaluateLiveOscarPervyyVystrelDiscovery,
  isPervyyVystrelObservabilityActive,
} from '../src/papertrader/live-oscar-pervyy-vystrel.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { PervyyVystrelMintMaterialized } from '../src/papertrader/discovery/pervyy-vystrel-snapshot-cache.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'live-oscar',
    discoveryMinMarketCapUsd: 2_000_000,
    runnerLiteMinMcapUsd: 500_000,
    runnerProbeMinMcapUsd: 1_000_000,
    pervyyVystrel: {
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
    },
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

describe('discovery-mcap-floor (pervyy_vystrel PR1)', () => {
  it('widens SQL min mcap to $100k when pervyy shadow observability is on', () => {
    const cfg = baseCfg();
    expect(resolveDiscoverySqlMinMarketCapUsd(cfg)).toBe(100_000);
  });

  it('volume-leader hard floor uses widened min, not prod $2M', () => {
    const cfg = baseCfg();
    expect(resolveDiscoveryHardMcapMinUsd(cfg, { volumeLeader: true })).toBe(100_000);
    expect(resolveDiscoveryHardMcapMinUsd(cfg)).toBe(2_000_000);
  });

  it('observability active when MODE=shadow and ENABLED=0', () => {
    expect(isPervyyVystrelObservabilityActive(baseCfg())).toBe(true);
    expect(
      isPervyyVystrelObservabilityActive(
        baseCfg({ pervyyVystrel: { ...baseCfg().pervyyVystrel, mode: 'off' } }),
      ),
    ).toBe(false);
  });
});

describe('evaluateLiveOscarPervyyVystrelDiscovery (PR1 shadow)', () => {
  it('wouldOnboard Phase 0 candidate in anchor band with vol1h', () => {
    const cfg = baseCfg();
    const evalRes = evaluateLiveOscarPervyyVystrelDiscovery({
      cfg,
      row: row(),
      lane: 'post_migration',
      refMcap: 150_000,
      ageMin: 900,
      discoveryMcap: { refMcapUsd: 150_000, source: 'pg_snapshot', pgMcapUsd: 150_000 },
    });
    expect(evalRes.wouldOnboard).toBe(true);
    expect(evalRes.pass).toBe(false);
    expect(evalRes.phase).toBe('phase0');
    expect(evalRes.reasons).toContain('pervyy_vystrel_phase0_would_onboard');
  });

  it('rejects low vol1h in anchor band', () => {
    const cfg = baseCfg();
    const evalRes = evaluateLiveOscarPervyyVystrelDiscovery({
      cfg,
      row: row({ volume_1h: 10_000 }),
      lane: 'post_migration',
      refMcap: 150_000,
      ageMin: 900,
      discoveryMcap: { refMcapUsd: 150_000, source: 'pg_snapshot', pgMcapUsd: 150_000 },
    });
    expect(evalRes.wouldOnboard).toBe(false);
    expect(evalRes.reasons.some((x) => x.includes('vol1h'))).toBe(true);
  });
});

describe('pervyy_vystrel Phase D phantom replay', () => {
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

  it('logs missing materialized snapshot when materialize is disabled', () => {
    const cfg = baseCfg({
      pervyyVystrel: {
        ...baseCfg().pervyyVystrel,
        materializeEnabled: false,
        organicGateEnabled: true,
        volAuthEnabled: true,
      },
    });

    const shadow = evaluatePervyyVystrelShadowAnalyzers({
      cfg,
      mint: 'MintNoMaterialize',
      refMcap: 150_000,
    });

    expect(shadow.journalEvents).toContainEqual({
      kind: 'pervyy_vystrel_phase_d_missing_materialized_snapshot',
      mint: 'MintNoMaterialize',
      materialize_enabled: false,
      pass: false,
      reasons: ['pervyy_vystrel_phase_d_missing_materialized_snapshot'],
    });
  });

  it('emits Phase C/D phantom events without live open when materialized snapshot passes', () => {
    const cfg = baseCfg({
      pervyyVystrel: {
        ...baseCfg().pervyyVystrel,
        enabled: false,
        mode: 'shadow',
        materializeEnabled: true,
        organicGateEnabled: true,
        volAuthEnabled: true,
      },
    });

    const evalRes = evaluateLiveOscarPervyyVystrelDiscovery({
      cfg,
      row: row({ mint: 'MintPhaseD', market_cap_usd: 600_000, volume_1h: 90_000 }),
      lane: 'post_migration',
      refMcap: 600_000,
      ageMin: 900,
      discoveryMcap: { refMcapUsd: 600_000, source: 'pg_snapshot', pgMcapUsd: 600_000 },
      materialized: materializedPhaseD,
    });

    expect(evalRes.pass).toBe(false);
    expect(evalRes.wouldOnboard).toBe(false);
    expect(evalRes.phase).toBe('phase_d');
    expect(evalRes.reasons).toContain('pervyy_vystrel_phase_d_phantom_replay_only');

    const events = evalRes.shadowAnalyzers?.journalEvents ?? [];
    expect(events.map((ev) => ev.kind)).toContain('pervyy_vystrel_phase_c_candidate');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'pervyy_vystrel_phase_d_candidate',
        pass: false,
        would_enter: false,
        cluster_dump_completed: true,
        fresh_retail_absorption: true,
        reramp_confirmation: true,
      }),
    );
    expect(events.some((ev) => ev.kind === 'live_position_open')).toBe(false);
  });
});
