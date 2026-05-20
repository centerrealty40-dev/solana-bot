import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { isAwaitingDipQualityHold } from '../src/papertrader/discovery/near-ready-dip-watch.js';
import { passesDiscoveryMinMarketCap } from '../src/papertrader/filters/snapshot-filter.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function row(mcap: number): SnapshotCandidateRow {
  return {
    mint: '6qdzMx4c9rL2X3Ns3SwZ8uEo4zReDPjdXpAEmpo7pump',
    symbol: 'BABYTROLL',
    holder_count: 1000,
    token_age_min: 5000,
    ts: new Date(),
    launch_ts: null,
    age_min: 5000,
    price_usd: 0.001,
    liquidity_usd: 200_000,
    volume_5m: 20_000,
    volume_1h: 50_000,
    buys_5m: 10,
    sells_5m: 5,
    market_cap_usd: mcap,
    pair_address: 'pair',
    source: 'pumpswap',
  };
}

describe('passesDiscoveryMinMarketCap', () => {
  const cfg = { discoveryMinMarketCapUsd: 3_000_000 } as PaperTraderConfig;

  it('rejects sub-threshold mcap', () => {
    expect(passesDiscoveryMinMarketCap(cfg, row(800_000))).toBe(false);
  });

  it('accepts at-threshold mcap', () => {
    expect(passesDiscoveryMinMarketCap(cfg, row(3_000_000))).toBe(true);
  });
});

describe('isAwaitingDipQualityHold', () => {
  it('treats mcap< as hard block (not near-ready horizon)', () => {
    expect(isAwaitingDipQualityHold(['dip_not_deep_enough', 'mcap<3000000'])).toBe(false);
  });
});
