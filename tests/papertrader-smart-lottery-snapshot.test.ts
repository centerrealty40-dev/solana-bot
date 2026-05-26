import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { evaluateSnapshotSmartLottery } from '../src/papertrader/filters/snapshot-filter.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    laneMigMinLiqUsd: 1,
    laneMigMaxLiqUsd: 0,
    laneMigMinVol5mUsd: 1,
    laneMigMinBuys5m: 1,
    laneMigMinSells5m: 1,
    laneMigMinAgeMin: 0,
    laneMigMaxAgeMin: 0,
    lanePostMinLiqUsd: 1,
    lanePostMaxLiqUsd: 0,
    lanePostMinVol5mUsd: 1,
    lanePostMinBuys5m: 1,
    lanePostMinSells5m: 1,
    lanePostMinAgeMin: 0,
    lanePostMaxAgeMin: 0,
    smlotMigMinLiqUsd: 10_000,
    smlotMigMaxLiqUsd: 0,
    smlotMigMinVol5mUsd: 2000,
    smlotMigMinBuys5m: 10,
    smlotMigMinSells5m: 5,
    smlotMigMinAgeMin: 2,
    smlotMigMaxAgeMin: 60,
    smlotPostMinLiqUsd: 15_000,
    smlotPostMaxLiqUsd: 0,
    smlotPostMinVol5mUsd: 2500,
    smlotPostMinBuys5m: 16,
    smlotPostMinSells5m: 10,
    smlotPostMinAgeMin: 25,
    smlotPostMaxAgeMin: 180,
    snapshotMinBs: 1,
    vol5m1hGuardEnabled: false,
    vol1hMinUsd: 36_000,
    vol5mSpikeMaxMult: 7,
    ...over,
  } as unknown as PaperTraderConfig;
}

function row(partial: Partial<SnapshotCandidateRow>): SnapshotCandidateRow {
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'T',
    holder_count: 100,
    token_age_min: 10,
    ts: new Date(),
    launch_ts: null,
    age_min: 5,
    price_usd: 1,
    liquidity_usd: 20_000,
    volume_5m: 5000,
    volume_1h: 60_000,
    buys_5m: 20,
    sells_5m: 10,
    market_cap_usd: 1e6,
    pair_address: 'p',
    source: 'raydium',
    ...partial,
  } as SnapshotCandidateRow;
}

describe('evaluateSnapshotSmartLottery', () => {
  it('passes when row meets migration lane thresholds', () => {
    const cfg = baseCfg();
    const r = evaluateSnapshotSmartLottery(cfg, row({}), 'migration_event');
    expect(r.pass).toBe(true);
  });

  it('fails when liquidity below smlot migration floor', () => {
    const cfg = baseCfg();
    const r = evaluateSnapshotSmartLottery(
      cfg,
      row({ liquidity_usd: 1000 }),
      'migration_event',
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('liq<'))).toBe(true);
  });
});
