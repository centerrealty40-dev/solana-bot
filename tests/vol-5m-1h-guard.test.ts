import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { evaluateVol5m1hGuard, evaluateSnapshot } from '../src/papertrader/filters/snapshot-filter.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function baseRow(over: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'T',
    ts: new Date(),
    launch_ts: null,
    age_min: 3000,
    price_usd: 1,
    liquidity_usd: 50_000,
    volume_5m: 12_000,
    volume_1h: 200_000,
    buys_5m: 10,
    sells_5m: 8,
    market_cap_usd: 1e6,
    source: 'raydium',
    holder_count: 4000,
    token_age_min: 3000,
    pair_address: null,
    ...over,
  };
}

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  const cfg = {
    vol5m1hGuardEnabled: true,
    vol1hMinUsd: 36_000,
    vol5mSpikeMaxMult: 7,
    snapshotMinBs: 0.98,
    lanePostMinLiqUsd: 25_000,
    lanePostMinVol5mUsd: 10_000,
    lanePostMinBuys5m: 4,
    lanePostMinSells5m: 3,
    lanePostMinAgeMin: 2880,
    lanePostMaxAgeMin: 0,
    lanePostMaxLiqUsd: 0,
    laneMigMinLiqUsd: 12_000,
    laneMigMinVol5mUsd: 1800,
    laneMigMinBuys5m: 18,
    laneMigMinSells5m: 8,
    laneMigMinAgeMin: 2,
    laneMigMaxAgeMin: 25,
    laneMigMaxLiqUsd: 0,
  } as unknown as PaperTraderConfig;
  return { ...cfg, ...over };
}

describe('evaluateVol5m1hGuard', () => {
  it('passes when guard disabled', () => {
    const row = baseRow({ volume_5m: 500_000, volume_1h: 1000 });
    const cfg = baseCfg({ vol5m1hGuardEnabled: false });
    expect(evaluateVol5m1hGuard(cfg, row).pass).toBe(true);
  });

  it('rejects missing hour volume', () => {
    const cfg = baseCfg();
    expect(evaluateVol5m1hGuard(cfg, baseRow({ volume_1h: 0 })).reasons).toContain('vol1h_missing');
  });

  it('rejects hour below floor', () => {
    const cfg = baseCfg();
    const r = evaluateVol5m1hGuard(cfg, baseRow({ volume_1h: 35_000, volume_5m: 10_000 }));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol1h<'))).toBe(true);
  });

  it('rejects suspicious 5m spike vs hour average', () => {
    const cfg = baseCfg({ vol5mSpikeMaxMult: 6 });
    // baseline = 72k/12 = 6k; vol5m = 50k → ratio ~8.3 > 6
    const r = evaluateVol5m1hGuard(cfg, baseRow({ volume_5m: 50_000, volume_1h: 72_000 }));
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/vol5m_spike/);
  });

  it('allows moderate 5m vs hour', () => {
    const cfg = baseCfg({ vol5mSpikeMaxMult: 7 });
    // baseline = 120k/12 = 10k; vol5m = 12k → ratio 1.2
    const r = evaluateVol5m1hGuard(cfg, baseRow({ volume_5m: 12_000, volume_1h: 120_000 }));
    expect(r.pass).toBe(true);
  });
});

describe('evaluateSnapshot integrates guard', () => {
  it('rejects liquidity above post lane max when set', () => {
    const cfg = baseCfg({ lanePostMaxLiqUsd: 200_000 });
    const row = baseRow({ liquidity_usd: 250_000 });
    const v = evaluateSnapshot(cfg, row, 'post_migration');
    expect(v.pass).toBe(false);
    expect(v.reasons.some((x) => x.startsWith('liq>'))).toBe(true);
  });

  it('includes vol spike reason in snapshot failure', () => {
    const cfg = baseCfg({ vol5mSpikeMaxMult: 4 });
    const row = baseRow({ volume_5m: 40_000, volume_1h: 48_000 }); // baseline 4k, ratio 10
    const v = evaluateSnapshot(cfg, row, 'post_migration');
    expect(v.pass).toBe(false);
    expect(v.reasons.some((x) => x.includes('vol5m_spike'))).toBe(true);
  });
});
