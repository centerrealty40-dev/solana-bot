import { describe, expect, it } from 'vitest';
import {
  mirrorBuyOnlyBoughtMintDecision,
  recordMirrorBuyOnlyMint,
} from '../../src/milddip/buy-only-once.js';
import { emptyMildDipState } from '../../src/milddip/state.js';

const mint = 'MintBought111111111111111111111111111111111111';

describe('buy-only one-time mint registry', () => {
  it('allows an unknown mint and skips a recorded mint', () => {
    const state = emptyMildDipState(1_000);
    expect(mirrorBuyOnlyBoughtMintDecision(state, mint)).toBe('allow');
    recordMirrorBuyOnlyMint(state, mint, 2_000);
    expect(mirrorBuyOnlyBoughtMintDecision(state, mint)).toBe('skip_already_bought');
  });

  it('records a mint once without changing its first timestamp', () => {
    const state = emptyMildDipState(1_000);
    expect(recordMirrorBuyOnlyMint(state, mint, 2_000)).toBe(true);
    expect(recordMirrorBuyOnlyMint(state, mint, 3_000)).toBe(false);
    expect(state.mirrorBuyOnlyBoughtMints).toEqual({ [mint]: 2_000 });
  });
});
