import { describe, expect, it } from 'vitest';
import {
  COPY_TRADER_GHOST_RECONCILE_GRACE_MS,
  COPY_TRADER_TOKEN_UI_SCALE,
  syncPositionFromWallet,
  walletNotionalUsdFromRaw,
} from '../../src/copytrader/position-reconcile.js';
import type { CopyPosition } from '../../src/copytrader/state.js';

describe('walletNotionalUsdFromRaw', () => {
  it('converts 6-decimal raw balance to USD notional', () => {
    const oneMillionRaw = 1_000_000n;
    expect(walletNotionalUsdFromRaw(oneMillionRaw, 0.5)).toBe(0.5);
    expect(walletNotionalUsdFromRaw(2_000_000n, 1.25)).toBe(2.5);
  });

  it('returns 0 for empty balance or invalid price', () => {
    expect(walletNotionalUsdFromRaw(0n, 1)).toBe(0);
    expect(walletNotionalUsdFromRaw(1_000_000n, 0)).toBe(0);
    expect(walletNotionalUsdFromRaw(1_000_000n, -1)).toBe(0);
  });
});

describe('ghost reconcile grace', () => {
  it('allows 5 minutes after entry before RPC zero can clear state', () => {
    expect(COPY_TRADER_GHOST_RECONCILE_GRACE_MS).toBe(5 * 60_000);
  });
});

describe('syncPositionFromWallet', () => {
  it('updates tokenRaw and sizeUsd from wallet balance', () => {
    const pos: CopyPosition = {
      mint: 'mint1',
      symbol: 'TOK',
      entryTs: 1,
      entryPriceUsd: 0.4,
      sizeUsd: 50,
      addCount: 0,
      leaderWallet: 'leader',
      leaderEntrySig: 'sig',
    };
    const raw = 5_000_000n;
    const notional = syncPositionFromWallet(pos, raw, 0.2);
    expect(pos.tokenRaw).toBe(raw.toString());
    expect(pos.sizeUsd).toBe(1);
    expect(notional).toBe(1);
    expect(COPY_TRADER_TOKEN_UI_SCALE).toBe(1_000_000);
  });
});
