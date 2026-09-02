import { afterEach, describe, expect, it } from 'vitest';
import {
  clearExitRouteMissing,
  exitRouteGuardResetForTests,
  isExitRouteMissingCached,
  markExitRouteMissing,
} from '../../src/copytrader/exit-route-guard.js';

describe('exit-route-guard', () => {
  afterEach(() => {
    exitRouteGuardResetForTests();
  });

  it('caches a missing route until the TTL expires', () => {
    markExitRouteMissing('mint', 1_000);
    expect(isExitRouteMissingCached('mint', 1_001, 600_000)).toBe(true);
    expect(isExitRouteMissingCached('mint', 601_000, 600_000)).toBe(false);
  });

  it('clears a cached missing route', () => {
    markExitRouteMissing('mint', 1_000);
    clearExitRouteMissing('mint');
    expect(isExitRouteMissingCached('mint', 1_001, 600_000)).toBe(false);
  });

  it('resets all cached missing routes', () => {
    markExitRouteMissing('mint-a', 1_000);
    markExitRouteMissing('mint-b', 1_000);
    exitRouteGuardResetForTests();
    expect(isExitRouteMissingCached('mint-a', 1_001, 600_000)).toBe(false);
    expect(isExitRouteMissingCached('mint-b', 1_001, 600_000)).toBe(false);
  });
});
