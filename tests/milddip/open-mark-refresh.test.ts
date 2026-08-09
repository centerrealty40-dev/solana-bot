import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetOpenMarkRefreshForTests,
  openMarkRefreshInFlightCount,
  requestOpenMarkRefresh,
} from '../../src/milddip/open-mark-refresh.js';

describe('requestOpenMarkRefresh', () => {
  beforeEach(() => {
    __resetOpenMarkRefreshForTests();
  });

  it('respects per-mint gap and max in-flight', () => {
    const now = 1_000_000;
    const base = {
      nowMs: now,
      minGapMs: 8_000,
      maxInFlight: 2,
      allowedDexIds: ['pumpswap'],
      cacheTtlMs: 15_000,
    };
    // We cannot easily mock undici here; just assert gating before fetch settles.
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'A'.repeat(32) + 'pump' }),
    ).toBe(true);
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'A'.repeat(32) + 'pump' }),
    ).toBe(false); // same mint gap / in-flight
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'B'.repeat(32) + 'pump' }),
    ).toBe(true);
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'C'.repeat(32) + 'pump' }),
    ).toBe(false); // maxInFlight=2
    expect(openMarkRefreshInFlightCount()).toBeLessThanOrEqual(2);
  });
});
