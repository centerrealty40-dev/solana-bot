import { describe, expect, it } from 'vitest';
import { attemptMirrorFirstClipLeg } from '../../src/milddip/entry-attempt.js';
import { attemptMirrorAverage, executeQueuedSell } from '../../src/milddip/loop.js';

const cfg = {
  journalPath: '/tmp/milddip-buy-only-loop-journal.jsonl',
  statePath: '/tmp/milddip-buy-only-loop-state.json',
  leaderMirror: {
    buyOnly: true,
    firstClipLegs: 2,
  },
} as any;

const pos = {
  mint: 'MintBuyOnly1111111111111111111111111111111111',
  symbol: 'TEST',
  lane: 'leader_mirror',
  entryPriceUsd: 1,
  sizeUsd: 100,
  openedAtMs: 1,
  buySignature: null,
};

describe('buy-only mirror loop guards', () => {
  it('does not execute queued sells for leader mirror positions', async () => {
    const state = { open: { [pos.mint]: pos } };
    await executeQueuedSell({
      cfg,
      state,
      decision: { mint: pos.mint, reason: 'hard_stop', fraction: 1 } as any,
      nowMs: 2,
    });
    expect(state.open[pos.mint]).toBe(pos);
  });

  it('does not average buy-only leader mirror positions', async () => {
    const state = { open: { [pos.mint]: pos } };
    await attemptMirrorAverage({
      cfg,
      state,
      pos,
      markPriceUsd: 0.5,
      nowMs: 2,
      leaderHeld: true,
    });
    expect(state.open[pos.mint]).toBe(pos);
  });

  it('skips the first clip leg for buy-only positions', async () => {
    const result = await attemptMirrorFirstClipLeg({
      cfg,
      state: { open: { [pos.mint]: pos } },
      candidate: { mint: pos.mint, symbol: 'TEST' },
    } as any);
    expect(result).toBe('skip');
  });
});
