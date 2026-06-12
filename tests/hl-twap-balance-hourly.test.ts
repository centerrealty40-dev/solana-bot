import { afterEach, describe, expect, it } from 'vitest';

import {
  BALANCE_HOURLY_MS,
  balanceHourlyTelegramEnabled,
  formatBalanceHourlyMessage,
  formatUsdBalance,
  msUntilNextHourBoundary,
} from '../src/hyperliquid/twap/live/balance-hourly-telegram.js';

describe('balanceHourlyTelegramEnabled', () => {
  const prev = process.env.HL_TWAP_BALANCE_HOURLY_TELEGRAM;

  afterEach(() => {
    if (prev === undefined) delete process.env.HL_TWAP_BALANCE_HOURLY_TELEGRAM;
    else process.env.HL_TWAP_BALANCE_HOURLY_TELEGRAM = prev;
  });

  it('defaults on when live enabled and env unset', () => {
    delete process.env.HL_TWAP_BALANCE_HOURLY_TELEGRAM;
    expect(balanceHourlyTelegramEnabled(true)).toBe(true);
    expect(balanceHourlyTelegramEnabled(false)).toBe(false);
  });

  it('respects explicit 0/1', () => {
    process.env.HL_TWAP_BALANCE_HOURLY_TELEGRAM = '0';
    expect(balanceHourlyTelegramEnabled(true)).toBe(false);
    process.env.HL_TWAP_BALANCE_HOURLY_TELEGRAM = '1';
    expect(balanceHourlyTelegramEnabled(false)).toBe(true);
  });
});

describe('msUntilNextHourBoundary', () => {
  it('returns positive ms until next UTC hour', () => {
    const now = Date.UTC(2026, 5, 11, 14, 23, 45, 123);
    const delay = msUntilNextHourBoundary(now);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(BALANCE_HOURLY_MS);
    expect(now + delay).toBe(Date.UTC(2026, 5, 11, 15, 0, 0, 0));
  });

  it('at exact hour boundary schedules next hour', () => {
    const now = Date.UTC(2026, 5, 11, 15, 0, 0, 0);
    expect(msUntilNextHourBoundary(now)).toBe(BALANCE_HOURLY_MS);
  });
});

describe('formatUsdBalance', () => {
  it('formats with thousands separator and 2 decimals', () => {
    expect(formatUsdBalance(5776.36)).toBe('$5,776.36');
    expect(formatUsdBalance(500)).toBe('$500.00');
  });
});

describe('formatBalanceHourlyMessage', () => {
  it('minimal message with balance only', () => {
    expect(
      formatBalanceHourlyMessage({ equityUsd: 5776.36, openPositions: 0 }),
    ).toBe('💰 HL Total Balance: $5,776.36\n📊 Открыто: 0 позиций');
  });

  it('includes peak when above current equity', () => {
    const msg = formatBalanceHourlyMessage({
      equityUsd: 5500,
      peakUsd: 6000,
      openPositions: 2,
    });
    expect(msg).toContain('💰 HL Total Balance: $5,500.00');
    expect(msg).toContain('📈 Пик: $6,000.00');
    expect(msg).toContain('📊 Открыто: 2 позиции');
  });

  it('omits peak when not above equity', () => {
    const msg = formatBalanceHourlyMessage({
      equityUsd: 6000,
      peakUsd: 6000,
      openPositions: 1,
    });
    expect(msg).not.toContain('Пик');
    expect(msg).toContain('1 позиция');
  });
});
