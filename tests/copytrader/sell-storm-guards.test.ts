import { describe, expect, it } from 'vitest';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import {
  isPendingSellExhausted,
  isUnroutableSellError,
  nextSellRetryDelayMs,
} from '../../src/copytrader/pending-sell-retry.js';
import {
  copyPositionIsDust,
  syncPositionFromWallet,
} from '../../src/copytrader/position-reconcile.js';
import type { CopyPosition, PendingSell } from '../../src/copytrader/state.js';

const cfg = (over: Partial<CopyTraderConfig> = {}) =>
  ({
    dustMinUsd: 1,
    dustMinTokenRaw: 1_000,
    sharedOscarWallet: false,
    ...over,
  }) as CopyTraderConfig;

const pending = (over: Partial<PendingSell> = {}): PendingSell => ({
  id: 'ps_1',
  mint: 'm',
  symbol: 'S',
  leaderSignature: 'trail_exit:tp_rung',
  leaderSellTs: 0,
  dueTs: 0,
  fraction: 0.5,
  retryUntilTs: 3_600_000,
  ...over,
});

const position = (over: Partial<CopyPosition> = {}): CopyPosition =>
  ({
    mint: 'm',
    symbol: 'S',
    positionSource: 'copy_leader',
    entryTs: 0,
    entryPriceUsd: 0.0001,
    sizeUsd: 118.09,
    addCount: 0,
    leaderWallet: 'L',
    leaderEntrySig: 'sig',
    ...over,
  }) as CopyPosition;

describe('copyPositionIsDust', () => {
  it('treats the 6N46H85p leftover (tokenRaw=1) as dust', () => {
    // Production state carried `tokenRaw: "1"` — one raw unit, 1e-6 of a token —
    // while reporting sizeUsd $118.09. Every liveness check was `!== 0n`, so the
    // position stayed open and the trail policy kept scheduling real sells.
    expect(copyPositionIsDust(cfg(), 1n, 0.0001583)).toBe(true);
  });

  it('treats a zero balance as dust', () => {
    expect(copyPositionIsDust(cfg(), 0n, 0.0001)).toBe(true);
  });

  it('keeps a real position open', () => {
    // 953526249510 raw = 953526 tokens at $0.0001 = ~$95
    expect(copyPositionIsDust(cfg(), 953_526_249_510n, 0.0001)).toBe(false);
  });

  it('closes a balance worth less than the USD floor', () => {
    // 2_000_000 raw = 2 tokens at $0.01 = $0.02
    expect(copyPositionIsDust(cfg(), 2_000_000n, 0.01)).toBe(true);
  });

  it('does not call a real position dust when the price feed is down', () => {
    expect(copyPositionIsDust(cfg(), 953_526_249_510n, 0)).toBe(false);
  });

  it('still catches raw-floor dust with no price', () => {
    expect(copyPositionIsDust(cfg(), 999n, 0)).toBe(true);
  });

  it('honours disabled thresholds', () => {
    expect(copyPositionIsDust(cfg({ dustMinUsd: 0, dustMinTokenRaw: 0 }), 1n, 0.0001)).toBe(false);
  });
});

describe('syncPositionFromWallet', () => {
  it('clears the stale notional once the balance is swept', () => {
    const pos = position({ tokenRaw: '1' });
    syncPositionFromWallet(pos, 1n, 0.0001583, cfg());
    // Previously `if (notional > 0)` left sizeUsd frozen at $118.09, so the exit
    // policy sized sells off money the wallet no longer held.
    expect(pos.sizeUsd).toBe(0);
  });

  it('keeps the last known notional when the price is unavailable', () => {
    const pos = position({ tokenRaw: '953526249510' });
    syncPositionFromWallet(pos, 953_526_249_510n, 0, cfg());
    expect(pos.sizeUsd).toBe(118.09);
  });

  it('marks to market on a live balance', () => {
    const pos = position({ tokenRaw: '953526249510' });
    syncPositionFromWallet(pos, 953_526_249_510n, 0.0001, cfg());
    expect(pos.sizeUsd).toBeCloseTo(95.35, 1);
  });
});

describe('isPendingSellExhausted', () => {
  it('trips at the attempt cap', () => {
    expect(isPendingSellExhausted(pending({ attempts: 12 }), 12)).toBe(true);
  });

  it('allows attempts below the cap', () => {
    expect(isPendingSellExhausted(pending({ attempts: 11 }), 12)).toBe(false);
  });

  it('is off at cap 0', () => {
    expect(isPendingSellExhausted(pending({ attempts: 9_999 }), 0)).toBe(false);
  });

  it('handles a pending sell written before the field existed', () => {
    expect(isPendingSellExhausted(pending(), 12)).toBe(false);
  });
});

describe('isUnroutableSellError', () => {
  it('flags the failure that produced 1283 of the 1436 storm attempts', () => {
    expect(isUnroutableSellError('jupiter_sell_quote_failed')).toBe(true);
  });

  it('flags missing routes', () => {
    expect(isUnroutableSellError('no_quote')).toBe(true);
    expect(isUnroutableSellError('swap_build:route_not_found')).toBe(true);
  });

  it('does not flag slippage, which a moving price can clear', () => {
    expect(isUnroutableSellError('sim_failed:{"InstructionError":[3,{"Custom":6024}]}')).toBe(false);
    expect(
      isUnroutableSellError('rpc_error:Transaction simulation failed: custom program error: 0x1771'),
    ).toBe(false);
  });

  it('does not flag transient transport errors', () => {
    expect(isUnroutableSellError('confirm_timeout')).toBe(false);
    expect(isUnroutableSellError('qn_rate:Too Many Requests')).toBe(false);
  });
});

describe('nextSellRetryDelayMs', () => {
  it('backs off exponentially and caps', () => {
    expect(nextSellRetryDelayMs(1, 3_000, 60_000)).toBe(3_000);
    expect(nextSellRetryDelayMs(2, 3_000, 60_000)).toBe(6_000);
    expect(nextSellRetryDelayMs(3, 3_000, 60_000)).toBe(12_000);
    expect(nextSellRetryDelayMs(10, 3_000, 60_000)).toBe(60_000);
  });

  it('stays flat when the ceiling is disabled', () => {
    expect(nextSellRetryDelayMs(8, 3_000, 0)).toBe(3_000);
  });

  it('bounds an unroutable mint to minutes instead of an hour', () => {
    // FVZhiS1u burned 972 quotes over 63 min at a flat ~3.5s. Eight attempts with
    // backoff cover a few minutes and then hand off to the abandon cooldown.
    let total = 0;
    for (let i = 1; i <= 8; i++) total += nextSellRetryDelayMs(i, 3_000, 60_000);
    expect(total).toBeLessThan(10 * 60_000);
  });
});
