import { describe, expect, it } from 'vitest';
import {
  fundingTopUpRemainderUsd,
  resolveFundingPartialClip,
} from '../../src/copytrader/funding-partial-clip.js';

describe('resolveFundingPartialClip', () => {
  const base = {
    enabled: true,
    fraction: 0.5,
    minUsd: 50,
  };

  it('defers when disabled', () => {
    expect(
      resolveFundingPartialClip({ ...base, enabled: false, requiredUsd: 500, availableUsd: 400 }),
    ).toEqual({ action: 'defer' });
  });

  it('defers when wallet already covers the full size', () => {
    expect(
      resolveFundingPartialClip({ ...base, requiredUsd: 500, availableUsd: 500 }),
    ).toEqual({ action: 'defer' });
  });

  it('clips to 50% of planned size when USDC covers that half', () => {
    const v = resolveFundingPartialClip({ ...base, requiredUsd: 533, availableUsd: 462 });
    expect(v).toEqual({
      action: 'clip',
      clipUsd: 266.5,
      remainderUsd: 266.5,
      originalUsd: 533,
    });
  });

  it('defers when free USDC cannot fund the 50% clip', () => {
    expect(
      resolveFundingPartialClip({ ...base, requiredUsd: 533, availableUsd: 200 }),
    ).toEqual({ action: 'defer' });
  });

  it('defers when the 50% clip is below the min floor', () => {
    expect(
      resolveFundingPartialClip({ ...base, requiredUsd: 80, availableUsd: 70 }),
    ).toEqual({ action: 'defer' });
  });
});

describe('fundingTopUpRemainderUsd', () => {
  it('returns remaining USD toward target above the min floor', () => {
    expect(
      fundingTopUpRemainderUsd({ entryTargetUsd: 533, deployedUsd: 266.5, minUsd: 50 }),
    ).toBe(266.5);
  });

  it('returns 0 when remainder is dust under the min floor', () => {
    expect(
      fundingTopUpRemainderUsd({ entryTargetUsd: 100, deployedUsd: 80, minUsd: 50 }),
    ).toBe(0);
  });
});
