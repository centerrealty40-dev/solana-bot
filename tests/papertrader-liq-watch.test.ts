import { describe, it, expect } from 'vitest';
import {
  evaluateLiqDrainState,
  liqSourceDisagreementPct,
  refreshEntryLiqBaseline,
  shouldBlockLiqDrainOnDisagreement,
} from '../src/papertrader/pricing/liq-watch.js';

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
  liqWatchDisagreementPct: 25,
  liqWatchDiscoveryQuote: true,
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

  it('uses discovery liq and avoids false LIQ_DRAIN when PG is stale low', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 418_000,
      load: {
        liqUsd: 418_000,
        ageMs: 5_000,
        from: 'discovery',
        pgLiqUsd: 194_000,
        referenceLiqUsd: 418_000,
        referenceSource: 'birdeye',
      },
      consecutiveFailures: 1,
      positionAgeMs: 5 * minute,
    });
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.dropPct).toBe(0);
  });

  it('blocks force-close when PG vs reference disagree beyond threshold (RTM/JCK case)', () => {
    const v = evaluateLiqDrainState({
      cfg: baseCfg,
      entryLiqUsd: 418_000,
      load: {
        liqUsd: 194_000,
        ageMs: 5_000,
        from: 'snapshot',
        pgLiqUsd: 194_000,
        referenceLiqUsd: 418_000,
        referenceSource: 'birdeye',
      },
      consecutiveFailures: 1,
      positionAgeMs: 5 * minute,
    });
    expect(v.kind).toBe('skipped');
    if (v.kind === 'skipped') {
      expect(v.reason).toBe('liq-disagreement');
      expect(v.disagreementPct).toBeGreaterThan(25);
    }
  });
});

describe('liqSourceDisagreementPct', () => {
  it('computes relative disagreement', () => {
    expect(liqSourceDisagreementPct(418_000, 194_000)).toBeCloseTo(53.589, 2);
    expect(liqSourceDisagreementPct(100_000, 90_000)).toBe(10);
  });
});

describe('shouldBlockLiqDrainOnDisagreement', () => {
  it('does not block when sources agree within threshold', () => {
    const r = shouldBlockLiqDrainOnDisagreement({
      cfg: baseCfg,
      entryLiqUsd: 100_000,
      dropPct: 40,
      load: {
        liqUsd: 60_000,
        ageMs: 0,
        from: 'snapshot',
        pgLiqUsd: 60_000,
        referenceLiqUsd: 65_000,
      },
    });
    expect(r.block).toBe(false);
  });
});

describe('refreshEntryLiqBaseline', () => {
  it('keeps max of entry and current liq', () => {
    expect(refreshEntryLiqBaseline(418_000, 500_000)).toBe(500_000);
    expect(refreshEntryLiqBaseline(418_000, 194_000)).toBe(418_000);
    expect(refreshEntryLiqBaseline(null, 100_000)).toBe(100_000);
  });
});
