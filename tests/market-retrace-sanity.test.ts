import { describe, it, expect } from 'vitest';

import {
  buildMintCanonicalPoolMap,
  groupCanonicalRowsByTable,
} from '../src/scripts/market-snapshot-canonical-pool.js';
import {
  isMatureTokenMicroValleyArtifact,
  isRetraceContradictedByLatestSnapshot,
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
