import { describe, expect, it } from 'vitest';
import {
  evaluatePostCrashFastPath,
  shouldBypassLocalHighVetoForPostCrash,
  type PostCrashContextFeatures,
} from '../src/papertrader/discovery/post-crash-fast-path.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function cfg(partial: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    postCrashFastPathEnabled: true,
    postCrashFastPathLookbackMin: 180,
    postCrashFastPathMinPgSamples: 8,
    postCrashFastPathMinDropPct: -16,
    postCrashFastPathMaxDropPct: -50,
    postCrashFastPathMinVolSpikeMult: 5,
    postCrashFastPathStabilizeMin: 15,
    postCrashFastPathMaxAgeMin: 240,
    postCrashFastPathMaxKnife15mPct: -8,
    postCrashFastPathBypassLocalHighVeto: true,
    dipMinAgeMin: 0,
    ...partial,
  } as PaperTraderConfig;
}

function row(priceUsd: number): SnapshotCandidateRow {
  return { mint: 'm1', price_usd: priceUsd, token_age_min: 100 } as SnapshotCandidateRow;
}

function ctx(overrides: Partial<PostCrashContextFeatures> = {}): PostCrashContextFeatures {
  return {
    lookbackMin: 180,
    peakPx: 0.016,
    minutesSincePeak: 45,
    dropFromPeakPct: null,
    maxVol5mSpikeRatio: 8,
    price15mAgo: 0.011,
    priceChange15mPct: null,
    pgSnapsCount: 50,
    coverageOk: true,
    ...overrides,
  };
}

describe('post-crash-fast-path', () => {
  it('passes swarms-like plateau after spike crash', () => {
    const res = evaluatePostCrashFastPath(cfg(), row(0.011), ctx());
    expect(res.pass).toBe(true);
    expect(res.features.dropFromPeakPct).toBeCloseTo(-31.25, 1);
    expect(res.reasons[0]).toContain('post_crash_fast');
  });

  it('blocks during knife (15m still falling)', () => {
    const res = evaluatePostCrashFastPath(
      cfg(),
      row(0.0105),
      ctx({ price15mAgo: 0.012 }),
    );
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.startsWith('post_crash_knife_15m'))).toBe(true);
  });

  it('blocks too fresh after peak', () => {
    const res = evaluatePostCrashFastPath(cfg(), row(0.011), ctx({ minutesSincePeak: 10 }));
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.startsWith('post_crash_too_fresh'))).toBe(true);
  });

  it('blocks without vol spike evidence', () => {
    const res = evaluatePostCrashFastPath(cfg(), row(0.011), ctx({ maxVol5mSpikeRatio: 3 }));
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.startsWith('post_crash_spike<'))).toBe(true);
  });

  it('bypasses local-high veto when post_crash entry', () => {
    expect(
      shouldBypassLocalHighVetoForPostCrash(
        cfg(),
        { pass: true, reasons: [], features: ctx(), dipLookbackUsedMin: 45 },
        'post_crash_fast',
      ),
    ).toBe(true);
    expect(
      shouldBypassLocalHighVetoForPostCrash(
        cfg(),
        { pass: true, reasons: [], features: ctx(), dipLookbackUsedMin: 45 },
        'dip_windows',
      ),
    ).toBe(false);
  });
});
