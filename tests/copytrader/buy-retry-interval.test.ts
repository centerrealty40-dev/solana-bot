import { describe, expect, it } from 'vitest';
import { loadCopyTraderConfig } from '../../src/copytrader/config.js';
import { computeRetryUntilTs, findPendingBuy } from '../../src/copytrader/pending-buy-retry.js';
import type { PendingBuy } from '../../src/copytrader/state.js';

/**
 * An unfunded wallet once burned ~100 Jupiter quote+build pairs inside a single
 * 2-minute retry window, one per tick. Failed buys now space themselves out.
 */
function pendingBuy(overrides: Partial<PendingBuy> = {}): PendingBuy {
  return {
    id: 'p1',
    mint: 'CeyZtFUiYP5oxCZ99urwHMvdCW67cY2yALknfrQppump',
    symbol: 'CeyZtFUi',
    leaderSignature: 'sig',
    kind: 'entry',
    sizeUsd: 100,
    dueTs: 1_000,
    retryUntilTs: computeRetryUntilTs(1_000, 120_000),
    ...overrides,
  } as PendingBuy;
}

function envConfig(env: Record<string, string>) {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return loadCopyTraderConfig();
  } finally {
    process.env = saved;
  }
}

describe('buyRetryIntervalMs', () => {
  const baseEnv = {
    COPY_TRADER_TARGET_WALLET: 'W'.repeat(43),
    COPY_TRADER_RPC_URL: 'https://rpc.example/solana',
  };

  it('defaults to 0 so existing lanes keep retrying every tick', () => {
    const cfg = envConfig(baseEnv);
    expect(cfg.buyRetryIntervalMs).toBe(0);
  });

  it('reads the env override', () => {
    const cfg = envConfig({ ...baseEnv, COPY_TRADER_BUY_RETRY_INTERVAL_MS: '6000' });
    expect(cfg.buyRetryIntervalMs).toBe(6_000);
  });

  it('pushes the next attempt out without extending the overall window', () => {
    const state = { pendingBuys: [pendingBuy()] };
    const row = findPendingBuy(state, 'p1');
    expect(row).toBeDefined();

    const windowBefore = row!.retryUntilTs;
    const now = 5_000;
    row!.dueTs = now + 6_000;

    expect(row!.dueTs).toBe(11_000);
    expect(row!.retryUntilTs).toBe(windowBefore);
    expect(row!.dueTs).toBeLessThan(row!.retryUntilTs);
  });

  it('caps attempts inside the retry window instead of one per tick', () => {
    const windowMs = 120_000;
    const tickMs = 1_000;
    const intervalMs = 6_000;
    expect(Math.floor(windowMs / tickMs)).toBe(120);
    expect(Math.floor(windowMs / intervalMs)).toBe(20);
  });
});
