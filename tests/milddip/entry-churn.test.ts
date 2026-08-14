import { describe, expect, it } from 'vitest';
import type { MildDipConfig } from '../../src/milddip/config.js';
import {
  ENTRY_CHURN_WINDOW_MS,
  maxEntriesBlock,
  noteMintEntry,
  recentEntryCount,
  sanitizeRecentEntryMsByMint,
} from '../../src/milddip/entry-churn.js';
import { emptyMildDipState } from '../../src/milddip/state.js';

function stubCfg(max = 3): MildDipConfig {
  return { maxEntriesPerMint24h: max } as MildDipConfig;
}

describe('entry-churn', () => {
  it('blocks at limit within 24h window', () => {
    const cfg = stubCfg(3);
    const state = emptyMildDipState(1_000_000);
    const mint = 'M'.repeat(44);
    noteMintEntry(state, mint, 900_000);
    noteMintEntry(state, mint, 950_000);
    expect(maxEntriesBlock(cfg, state, mint, 1_000_000).block).toBe(false);
    noteMintEntry(state, mint, 990_000);
    expect(maxEntriesBlock(cfg, state, mint, 1_000_000)).toEqual({
      block: true,
      count: 3,
      limit: 3,
    });
  });

  it('prunes entries older than window', () => {
    const state = emptyMildDipState();
    const mint = 'A'.repeat(44);
    const now = 10_000_000;
    state.recentEntryMsByMint = {
      [mint]: [now - ENTRY_CHURN_WINDOW_MS - 1, now - 1000, now - 500],
    };
    expect(recentEntryCount(state, mint, now)).toBe(2);
    noteMintEntry(state, mint, now);
    expect(recentEntryCount(state, mint, now)).toBe(3);
  });

  it('sanitize drops invalid mint stamps', () => {
    const mint = 'B'.repeat(44);
    expect(
      sanitizeRecentEntryMsByMint({
        short: [1],
        [mint]: [100, 200],
      }),
    ).toEqual({ [mint]: [100, 200] });
  });
});
