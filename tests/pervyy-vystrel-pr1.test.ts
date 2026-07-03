import { describe, expect, it } from 'vitest';
import {
  resolveDiscoveryHardMcapMinUsd,
  resolveDiscoverySqlMinMarketCapUsd,
} from '../src/papertrader/discovery/discovery-mcap-floor.js';
import {
  evaluateLiveOscarPervyyVystrelDiscovery,
  isPervyyVystrelObservabilityActive,
} from '../src/papertrader/live-oscar-pervyy-vystrel.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
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
