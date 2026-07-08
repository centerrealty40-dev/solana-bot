import { describe, it, expect } from 'vitest';
import {
  evaluateVolCollapseState,
  refreshVolBaseline,
} from '../src/papertrader/pricing/vol-watch.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    volWatchEnabled: true,
    volWatchForceClose: true,
    volWatchCollapsePct: 90, // collapse when current <= 10% of baseline
    volWatchSustainHours: 3,
    volWatchMinBaselineUsd: 2000,
    volWatchMinAgeMin: 30,
    volWatchSnapshotMaxAgeMs: 120_000,
    volWatchStampOnTrack: false,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

const AGE_OK = 60 * 60 * 1000; // 1h > minAge 30m
const T0 = 1_000_000_000_000;

describe('refreshVolBaseline (high-water mark)', () => {
  it('seeds from current when no baseline', () => {
    expect(refreshVolBaseline(null, 5000)).toBe(5000);
  });
  it('keeps the max of baseline and current', () => {
    expect(refreshVolBaseline(8000, 3000)).toBe(8000);
    expect(refreshVolBaseline(8000, 12000)).toBe(12000);
  });
  it('holds baseline when current is missing', () => {
    expect(refreshVolBaseline(8000, null)).toBe(8000);
  });
});

describe('evaluateVolCollapseState', () => {
  it('disabled feature → skipped', () => {
    const v = evaluateVolCollapseState({
      cfg: cfg({ volWatchEnabled: false }),
      baselineUsd: 100_000,
      currentVolUsd: 100,
      collapseSinceTs: null,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v.kind).toBe('skipped');
  });

  it('too young → skipped (pre-min-age)', () => {
    const v = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 100_000,
      currentVolUsd: 100,
      collapseSinceTs: null,
      positionAgeMs: 60 * 1000,
      nowTs: T0,
    });
    expect(v).toMatchObject({ kind: 'skipped', reason: 'pre-min-age' });
  });

  it('baseline below noise floor → skipped and clears streak', () => {
    const v = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 500,
      currentVolUsd: 10,
      collapseSinceTs: T0 - 10 * 3_600_000,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v).toMatchObject({ kind: 'skipped', reason: 'baseline-too-small', collapseSinceTs: null });
  });

  it('healthy volume → ok, streak reset', () => {
    const v = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 100_000,
      currentVolUsd: 40_000, // 60% drop, below 90% threshold
      collapseSinceTs: T0 - 5 * 3_600_000,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v.kind).toBe('ok');
    expect(v.collapseSinceTs).toBeNull();
  });

  it('collapse detected but not yet sustained → pending, anchors streak', () => {
    const v = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 200_000,
      currentVolUsd: 15_000, // 92.5% drop >= 90% threshold
      collapseSinceTs: null,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v.kind).toBe('pending');
    expect(v.collapseSinceTs).toBe(T0);
  });

  it('collapse sustained >= sustainHours → force-close', () => {
    const since = T0 - 3 * 3_600_000; // exactly 3h ago
    const v = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 200_000,
      currentVolUsd: 15_000,
      collapseSinceTs: since,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v).toMatchObject({ kind: 'force-close', reason: 'VOL_COLLAPSE', collapseSinceTs: since });
    if (v.kind === 'force-close') {
      expect(v.sustainedMs).toBe(3 * 3_600_000);
      expect(v.dropPct).toBeCloseTo(92.5, 1);
    }
  });

  it('recovery before sustain window → ok, resets streak (single noisy dip)', () => {
    // tick 1: collapse anchors streak
    const v1 = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 200_000,
      currentVolUsd: 10_000,
      collapseSinceTs: null,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v1.kind).toBe('pending');
    // tick 2 (1h later): volume recovers → ok, streak cleared
    const v2 = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 200_000,
      currentVolUsd: 120_000, // recovered
      collapseSinceTs: v1.collapseSinceTs,
      positionAgeMs: AGE_OK + 3_600_000,
      nowTs: T0 + 3_600_000,
    });
    expect(v2.kind).toBe('ok');
    expect(v2.collapseSinceTs).toBeNull();
  });

  it('no fresh volume this tick → pending, holds streak anchor', () => {
    const since = T0 - 1 * 3_600_000;
    const v = evaluateVolCollapseState({
      cfg: cfg(),
      baselineUsd: 200_000,
      currentVolUsd: null,
      collapseSinceTs: since,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v).toMatchObject({ kind: 'pending', currentVolUsd: null, collapseSinceTs: since });
  });

  it('shadow config still returns force-close verdict (enforcement gated by caller)', () => {
    const since = T0 - 4 * 3_600_000;
    const v = evaluateVolCollapseState({
      cfg: cfg({ volWatchForceClose: false }),
      baselineUsd: 200_000,
      currentVolUsd: 5_000,
      collapseSinceTs: since,
      positionAgeMs: AGE_OK,
      nowTs: T0,
    });
    expect(v.kind).toBe('force-close');
  });
});
