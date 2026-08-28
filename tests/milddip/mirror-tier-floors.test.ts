import { describe, expect, it } from 'vitest';
import {
  resolveMirrorEntryRiskFloors,
  shouldApplyMirrorEntryStructuralDataVeto,
} from '../../src/milddip/entry-attempt.js';

const mirrorFloors = {
  mirrorMinPairAgeHours: 1,
  mirrorMinLiquidityUsd: 40_000,
  mirrorMaxVol5mToLiq: 2,
};

const defaults = {
  defaultMinPairAgeHours: 2,
  defaultMinLiquidityUsd: 5_000,
  defaultMaxVol5mToLiq: 3,
};

describe('mirror tier entry risk floors', () => {
  it('removes all structural risk floors for tier with the override enabled', () => {
    expect(resolveMirrorEntryRiskFloors({
      ...mirrorFloors,
      ...defaults,
      isMirror: true,
      isTier: true,
      tierIgnoreFloors: true,
    })).toEqual({
      minPairAgeHours: 0,
      minLiquidityUsd: 0,
      maxVol5mToLiq: 0,
    });
    expect(shouldApplyMirrorEntryStructuralDataVeto(true, true)).toBe(false);
  });

  it('keeps mirror liquidity and volume-ratio floors for tier without override', () => {
    expect(resolveMirrorEntryRiskFloors({
      ...mirrorFloors,
      ...defaults,
      isMirror: true,
      isTier: true,
      tierIgnoreFloors: false,
    })).toEqual({
      minPairAgeHours: 0,
      minLiquidityUsd: 40_000,
      maxVol5mToLiq: 2,
    });
    expect(shouldApplyMirrorEntryStructuralDataVeto(true, false)).toBe(true);
  });

  it('preserves all ordinary mirror floors', () => {
    expect(resolveMirrorEntryRiskFloors({
      ...mirrorFloors,
      ...defaults,
      isMirror: true,
      isTier: false,
      tierIgnoreFloors: false,
    })).toEqual({
      minPairAgeHours: 1,
      minLiquidityUsd: 40_000,
      maxVol5mToLiq: 2,
    });
    expect(shouldApplyMirrorEntryStructuralDataVeto(true, false)).toBe(true);
  });

  it('removes mirror floors when the instant green path requests the bypass', () => {
    expect(resolveMirrorEntryRiskFloors({
      ...mirrorFloors,
      ...defaults,
      isMirror: true,
      isTier: false,
      tierIgnoreFloors: false,
      structuralGatesEnabled: false,
    })).toEqual({
      minPairAgeHours: 0,
      minLiquidityUsd: 0,
      maxVol5mToLiq: 0,
    });
    expect(shouldApplyMirrorEntryStructuralDataVeto(true, false, false)).toBe(false);
  });
});
