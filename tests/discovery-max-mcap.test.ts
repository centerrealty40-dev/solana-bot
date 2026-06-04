import { describe, expect, it } from 'vitest';
import {
  appendDiscoveryMcapGateReasons,
  passesDiscoveryMaxMarketCap,
  passesDiscoveryMinMarketCap,
} from '../src/papertrader/filters/snapshot-filter.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function row(mcap: number): SnapshotCandidateRow {
  return {
    mint: 'mint1111111111111111111111111111111111111111',
    symbol: 'TEST',
    holder_count: 0,
    token_age_min: 100,
    ts: new Date(),
    launch_ts: null,
    age_min: 100,
    price_usd: 1,
    liquidity_usd: 50_000,
    volume_5m: 10_000,
    volume_1h: 50_000,
    buys_5m: 10,
    sells_5m: 10,
    market_cap_usd: mcap,
    pair_address: null,
    source: 'meteora',
  };
}

describe('discovery max mcap', () => {
  const cfg = {
    discoveryMinMarketCapUsd: 1_300_000,
    discoveryMaxMarketCapUsd: 50_000_000,
  } as Parameters<typeof passesDiscoveryMaxMarketCap>[0];

  it('rejects mcap above max', () => {
    expect(passesDiscoveryMaxMarketCap(cfg, row(60_000_000))).toBe(false);
    const reasons: string[] = [];
    appendDiscoveryMcapGateReasons(cfg, row(60_000_000), reasons);
    expect(reasons).toContain('mcap>50000000');
  });

  it('accepts mcap within band', () => {
    expect(passesDiscoveryMinMarketCap(cfg, row(5_000_000))).toBe(true);
    expect(passesDiscoveryMaxMarketCap(cfg, row(5_000_000))).toBe(true);
  });

  it('exempts open mint from max cap', () => {
    const r = row(80_000_000);
    expect(passesDiscoveryMaxMarketCap(cfg, r, new Set([r.mint]))).toBe(true);
  });
});
