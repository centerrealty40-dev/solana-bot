import { describe, expect, it } from 'vitest';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';
import {
  discoverySnapshotSanityCfg,
  filterSaneDiscoverySnapshotRows,
  isDiscoverySnapshotRowSane,
  pickCanonicalSnapshotRowFromPool,
} from '../src/papertrader/discovery/snapshot-row-sanity.js';
import { dedupeSnapshotTaggedByMintCanonical } from '../src/papertrader/discovery/snapshot-canonical-pick.js';

const SANITY = {
  enabled: true,
  refMcapMinUsd: 2_000_000,
  minLiqToRefMcapRatio: 0.002,
  minLiqShareOfMintMax: 0.1,
  zeroLiqMaxMcapUsd: 500_000,
};

function row(overrides: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'T',
    holder_count: 100,
    token_age_min: 60,
    ts: new Date(),
    launch_ts: null,
    age_min: 30,
    price_usd: 1,
    liquidity_usd: 400_000,
    volume_5m: 10_000,
    volume_1h: 50_000,
    buys_5m: 10,
    sells_5m: 5,
    market_cap_usd: 5_000_000,
    pair_address: 'pairA',
    source: 'pumpswap',
    ...overrides,
  };
}

describe('snapshot-row-sanity', () => {
  it('rejects liq=0 with high mcap', () => {
    expect(
      isDiscoverySnapshotRowSane(
        row({ liquidity_usd: 0, market_cap_usd: 6_000_000 }),
        SANITY,
      ),
    ).toBe(false);
  });

  it('rejects liq/mcap mismatch on large cap', () => {
    expect(
      isDiscoverySnapshotRowSane(
        row({ liquidity_usd: 5_000, market_cap_usd: 5_000_000 }),
        SANITY,
      ),
    ).toBe(false);
  });

  it('rejects dead pool below mint max liq share', () => {
    const live = row({ liquidity_usd: 553_000, pair_address: 'live', source: 'pumpswap' });
    const dead = row({ liquidity_usd: 38_000, pair_address: 'dead', source: 'meteora' });
    const sane = filterSaneDiscoverySnapshotRows([live, dead], SANITY);
    expect(sane).toHaveLength(1);
    expect(sane[0]?.pair_address).toBe('live');
  });

  it('canonical pick prefers live pool after sanity filter', () => {
    const mint = 'Mint222222222222222222222222222222222222222';
    const pick = pickCanonicalSnapshotRowFromPool(
      [
        row({ mint, liquidity_usd: 38_000, volume_1h: 200_000, source: 'meteora', pair_address: 'dead' }),
        row({ mint, liquidity_usd: 553_000, volume_1h: 80_000, source: 'pumpswap', pair_address: 'live' }),
      ],
      SANITY,
      { canonicalByVolume: true },
    );
    expect(pick?.pair_address).toBe('live');
  });

  it('dedupe drops mint when all pools fail sanity', () => {
    const mint = 'Mint333333333333333333333333333333333333333';
    const tagged = dedupeSnapshotTaggedByMintCanonical(
      [
        {
          row: row({ mint, liquidity_usd: 0, market_cap_usd: 8_000_000 }),
          lane: 'post_migration',
        },
      ],
      { sanityCfg: SANITY },
    );
    expect(tagged).toHaveLength(0);
  });

  it('discoverySnapshotSanityCfg defaults enabled from paper config shape', () => {
    const cfg = discoverySnapshotSanityCfg({
      discoverySnapshotSanityEnabled: true,
      discoverySnapshotSanityRefMcapMinUsd: 2_000_000,
      discoverySnapshotSanityMinLiqToMcapRatio: 0.002,
      discoverySnapshotSanityMinLiqShareOfMintMax: 0.1,
      discoverySnapshotSanityZeroLiqMaxMcapUsd: 500_000,
    } as never);
    expect(cfg.enabled).toBe(true);
  });
});
