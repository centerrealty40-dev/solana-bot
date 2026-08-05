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
});
