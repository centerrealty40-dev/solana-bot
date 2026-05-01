import { describe, it, expect } from 'vitest';
import { evaluateLiqDrainState } from '../src/papertrader/pricing/liq-watch.js';

const baseCfg = {
  liqWatchEnabled: true,
  liqWatchForceClose: true,
  liqWatchDrainPct: 35,
  liqWatchMinAgeMin: 1,
  liqWatchConsecutiveFailures: 2,
  liqWatchSnapshotMaxAgeMs: 120_000,
  liqWatchRpcFallback: false,
  liqWatchStampOnAllClose: true,
  liqWatchStampOnTrack: false,
} as never;

const minute = 60_000;

describe('evaluateLiqDrainState', () => {
  it('skips before min age', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 100_000,
      load: { liqUsd: 50_000, ageMs: 5_000, from: 'snapshot' },
      consecutiveFailures: 0,
      positionAgeMs: 30_000,
    });
    expect(v.kind).toBe('skipped');
    if (v.kind === 'skipped') expect(v.reason).toBe('pre-min-age');
  });

  it('returns ok when drop below threshold', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 100_000,
      load: { liqUsd: 80_000, ageMs: 5_000, from: 'snapshot' },
      consecutiveFailures: 0,
      positionAgeMs: 5 * minute,
    });
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.dropPct).toBe(20);
  });

  it('returns pending on first consecutive failure', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 100_000,
      load: { liqUsd: 50_000, ageMs: 5_000, from: 'snapshot' },
      consecutiveFailures: 0,
      positionAgeMs: 5 * minute,
    });
    expect(v.kind).toBe('pending');
    if (v.kind === 'pending') expect(v.consecutiveFailures).toBe(1);
  });

  it('returns force-close on second consecutive failure', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 100_000,
      load: { liqUsd: 50_000, ageMs: 5_000, from: 'snapshot' },
      consecutiveFailures: 1,
      positionAgeMs: 5 * minute,
    });
    expect(v.kind).toBe('force-close');
    if (v.kind === 'force-close') {
      expect(v.reason).toBe('LIQ_DRAIN');
      expect(v.dropPct).toBe(50);
    }
  });

  it('returns pending when load.from===none', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 100_000,
      load: { liqUsd: null, ageMs: 0, from: 'none' },
      consecutiveFailures: 0,
      positionAgeMs: 5 * minute,
    });
    expect(v.kind).toBe('pending');
  });

  it('skipped when entry liq missing', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 0,
      load: { liqUsd: 50_000, ageMs: 5_000, from: 'snapshot' },
      consecutiveFailures: 0,
      positionAgeMs: 5 * minute,
    });
    expect(v.kind).toBe('skipped');
    if (v.kind === 'skipped') expect(v.reason).toBe('no-entry-liq');
  });
});
