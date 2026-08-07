import { describe, expect, it } from 'vitest';
import { MildDipHotMintBuffer } from '../../src/milddip/hot-mints.js';

describe('MildDipHotMintBuffer', () => {
  it('keeps recent mints and drops by TTL', () => {
    const buf = new MildDipHotMintBuffer({ maxMints: 10, ttlMs: 1_000 });
    buf.note('Mint111111111111111111111111111111111111111', 1000);
    buf.note('Mint222222222222222222222222222222222222222', 1500);
    expect(buf.size(1600)).toBe(2);
    expect(buf.list(1600)[0]).toContain('Mint2');
    expect(buf.size(2600)).toBe(0);
  });

  it('evicts oldest when over max', () => {
    const buf = new MildDipHotMintBuffer({ maxMints: 2, ttlMs: 60_000 });
    buf.note('MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1);
    buf.note('MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 2);
    buf.note('MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 3);
    const list = buf.list(4);
    expect(list).toHaveLength(2);
    expect(list.join('')).not.toContain('MintA');
  });

  it('force-enrich first-seen respects per-minute cap and does not double-grant', () => {
    const buf = new MildDipHotMintBuffer({ maxMints: 20, ttlMs: 600_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) {
      buf.note(`Mint${String(i).padStart(39, 'X')}`, t0 + i);
    }
    const batch1 = buf.takeForceEnrichFirstSeen(t0 + 10, 4);
    expect(batch1).toHaveLength(4);
    const batch2 = buf.takeForceEnrichFirstSeen(t0 + 20, 4);
    expect(batch2).toHaveLength(0); // cap exhausted in window
    // Keep mints alive; window rolls so 2 remaining first-seens can grant.
    for (let i = 0; i < 6; i++) {
      buf.note(`Mint${String(i).padStart(39, 'X')}`, t0 + 65_000);
    }
    const later = buf.takeForceEnrichFirstSeen(t0 + 65_000, 4);
    expect(later.length).toBe(2);
    expect(later.every((m) => !batch1.includes(m))).toBe(true);
  });
});
