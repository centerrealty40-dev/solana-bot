import { describe, it, expect } from 'vitest';

import {
  buildMintCanonicalPoolMap,
  groupCanonicalRowsByTable,
} from '../src/scripts/market-snapshot-canonical-pool.js';
import {
  isMatureTokenMicroValleyArtifact,
  isRetraceContradictedByLatestSnapshot,
  isImpossibleMinuteBarSpike,
  isJupiterGhostSpikeMove,
  resolveBarMcapUsd,
  isBarMcapPlausible,
} from '../src/scripts/market-retrace-sanity.js';

describe('market-retrace-sanity', () => {
  it('TOES: micro valley + million% pump on mature mcap', () => {
    expect(isMatureTokenMicroValleyArtifact(1280, 7_240_000, 7_370_000, 563_996)).toBe(true);
  });

  it('real -20% retrace on $5M token — not micro valley artifact', () => {
    expect(isMatureTokenMicroValleyArtifact(4_000_000, 5_000_000, 4_800_000, 25)).toBe(false);
  });

  it('claimed -100% but latest px still at peak — glitch', () => {
    expect(isRetraceContradictedByLatestSnapshot(0.007243, 1.044e-7, 0.0072, 100)).toBe(true);
  });

  it('real -15% confirmed by latest px', () => {
    expect(isRetraceContradictedByLatestSnapshot(1.0, 0.85, 0.86, 15)).toBe(false);
  });

  it('LAYOFF-like: $1.38 peak px vs $0.001363 ref on $1.32M mcap — impossible spike', () => {
    expect(isImpossibleMinuteBarSpike(1.38, 0.001363, 1_320_000, 99.9)).toBe(true);
  });

  it('Jupiter ghost spike: +99419% from micro anchor without ref mcap', () => {
    expect(
      isJupiterGhostSpikeMove({
        anchorPx: 1e-9,
        nowPx: 0.001,
        refPx: 0,
        refMcap: 0,
        pct: 99_419,
      }),
    ).toBe(true);
  });

  it('real +35% pump on $3M token with sane px — not ghost', () => {
    expect(
      isJupiterGhostSpikeMove({
        anchorPx: 0.001,
        nowPx: 0.00135,
        refPx: 0.0013,
        refMcap: 3_000_000,
        pct: 35,
      }),
    ).toBe(false);
  });

  it('resolveBarMcapUsd prefers ref when bar px is ghost spike (LAYOFF)', () => {
    const resolved = resolveBarMcapUsd({
      barPxUsd: 1.38,
      barMcapUsd: 1_335_794_214,
      refMcapUsd: 1_320_000,
      refPxUsd: 0.001363,
    });
    expect(resolved).toBe(1_320_000);
    expect(isBarMcapPlausible(1_335_794_214, 1.38, 1_320_000, 0.001363)).toBe(false);
  });
});

describe('canonical pool map', () => {
  it('picks max liq pair per mint', () => {
    const map = buildMintCanonicalPoolMap([
      {
        table: 'meteora_pair_snapshots',
        rows: [{ base_mint: 'M', pair_address: 'dead', liq_usd: 38_000 }],
      },
      {
        table: 'pumpswap_pair_snapshots',
        rows: [{ base_mint: 'M', pair_address: 'live', liq_usd: 553_000 }],
      },
    ]);
    const grouped = groupCanonicalRowsByTable(map);
    expect(map.get('M')?.meta.pair_address).toBe('live');
    expect(grouped.get('pumpswap_pair_snapshots')?.[0].pair_address).toBe('live');
  });
});
