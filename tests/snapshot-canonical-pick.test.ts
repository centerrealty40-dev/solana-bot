import { describe, it, expect } from 'vitest';
import {
  pickCanonicalSnapshotRow,
  dedupeSnapshotTaggedByMintCanonical,
} from '../src/papertrader/discovery/snapshot-canonical-pick.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function row(partial: Partial<SnapshotCandidateRow> & { mint: string }): SnapshotCandidateRow {
  return {
    symbol: '?',
    holder_count: 0,
    token_age_min: 100,
    ts: new Date('2026-05-23T12:20:00Z'),
    launch_ts: null,
    age_min: 100,
    price_usd: 0.02,
    liquidity_usd: 100_000,
    volume_5m: 1000,
    volume_1h: 10_000,
    buys_5m: 1,
    sells_5m: 1,
    market_cap_usd: 1_000_000,
    pair_address: 'pairA',
    source: 'raydium',
    ...partial,
  };
}

describe('pickCanonicalSnapshotRow', () => {
  it('pippin case: Raydium $3.7M beats fresher Meteora $32k', () => {
    const mint = 'Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump';
    const raydium = row({
      mint,
      source: 'raydium',
      liquidity_usd: 3_676_967,
      ts: new Date('2026-05-23T12:22:00Z'),
      pair_address: '8WwcNqdZjCY5Pt7AkhupAFknV2txca9sq6YBkGzLbvdt',
    });
    const meteora = row({
      mint,
      source: 'meteora',
      liquidity_usd: 31_835,
      ts: new Date('2026-05-23T12:23:00Z'),
      volume_1h: 0,
      pair_address: 'BKXWSPeUCxLtrNnMy2by3gdC7qMdPmdADPS4K5CneJZq',
    });
    const pick = pickCanonicalSnapshotRow([meteora, raydium]);
    expect(pick?.source).toBe('raydium');
    expect(pick?.liquidity_usd).toBe(3_676_967);
  });

  it('dedupeSnapshotTaggedByMintCanonical keeps one row per mint', () => {
    const mint = 'Mint111111111111111111111111111111111111111';
    const tagged = dedupeSnapshotTaggedByMintCanonical([
      { row: row({ mint, source: 'meteora', liquidity_usd: 50_000 }), lane: 'post_migration' },
      { row: row({ mint, source: 'raydium', liquidity_usd: 2_000_000 }), lane: 'post_migration' },
    ]);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.row.source).toBe('raydium');
    expect(tagged[0]?.row.liquidity_usd).toBe(2_000_000);
  });
});
