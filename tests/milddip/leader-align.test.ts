import { describe, expect, it } from 'vitest';
import {
  averageEntryAfterScaleIn,
  evaluateLeaderAlignDefer,
  LEADER_ALIGN_DEFER_REASONS,
} from '../../src/milddip/leader-align.js';

const hit = {
  mint: '39jq7BGb4UMNS57V8UH67b24QjroSmvyLnvFWkT5pump',
  lastSeenAtMs: 1_000_000,
  leader: '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
  signature: 'gpGDXisXPAciHbTufmBNw7hBPA3n',
  fillPriceUsd: 0.00028,
  isAdd: true,
};

describe('evaluateLeaderAlignDefer', () => {
  const base = {
    enabled: true,
    shouldExit: true,
    reason: 'never_arm_time_red' as const,
    pnlPct: -6.8,
    entryPriceUsd: 0.000345,
    markPriceUsd: 0.000322,
    nowMs: 1_000_000 + 30_000,
    hit,
    maxAgeMs: 120_000,
    requireRedPct: 3,
    minBelowEntryPct: 0,
    scaleInEnabled: true,
    scaleInDone: false,
    requireLeaderAdd: false,
  };

  it('defers soft exit + offers scale-in on fresh leader buy while red', () => {
    const v = evaluateLeaderAlignDefer(base);
    expect(v.defer).toBe(true);
    expect(v.scaleIn).toBe(true);
    expect(v.hit?.signature).toBe(hit.signature);
  });

  it('does not fire without shouldExit (not a casual −5% scale-in)', () => {
    const v = evaluateLeaderAlignDefer({ ...base, shouldExit: false });
    expect(v.defer).toBe(false);
    expect(v.reasons).toContain('not_exiting');
  });

  it('does not fire when only mildly red / green', () => {
    const v = evaluateLeaderAlignDefer({ ...base, pnlPct: -1 });
    expect(v.defer).toBe(false);
  });

  it('does not defer cliff_dump', () => {
    expect(LEADER_ALIGN_DEFER_REASONS.has('cliff_dump')).toBe(false);
    const v = evaluateLeaderAlignDefer({ ...base, reason: 'cliff_dump' });
    expect(v.defer).toBe(false);
  });

  it('does not defer hard_stop', () => {
    expect(LEADER_ALIGN_DEFER_REASONS.has('hard_stop')).toBe(false);
    const v = evaluateLeaderAlignDefer({ ...base, reason: 'hard_stop', pnlPct: -16 });
    expect(v.defer).toBe(false);
  });

  it('does not defer mfe_bank take-profit', () => {
    const v = evaluateLeaderAlignDefer({ ...base, reason: 'mfe_bank_1', pnlPct: 8 });
    expect(v.defer).toBe(false);
  });

  it('rejects stale leader hit', () => {
    const v = evaluateLeaderAlignDefer({
      ...base,
      nowMs: hit.lastSeenAtMs + 180_000,
    });
    expect(v.defer).toBe(false);
    expect(v.reasons.some((r) => r.startsWith('leader_stale'))).toBe(true);
  });

  it('rejects average-up (leader fill above entry)', () => {
    const v = evaluateLeaderAlignDefer({
      ...base,
      hit: { ...hit, fillPriceUsd: 0.0004 },
      markPriceUsd: 0.0004,
    });
    expect(v.defer).toBe(false);
  });

  it('scaleIn false after one-shot done (still defers)', () => {
    const v = evaluateLeaderAlignDefer({ ...base, scaleInDone: true });
    expect(v.defer).toBe(true);
    expect(v.scaleIn).toBe(false);
  });

  it('requireLeaderAdd blocks first-bag leader open', () => {
    const v = evaluateLeaderAlignDefer({
      ...base,
      requireLeaderAdd: true,
      hit: { ...hit, isAdd: false },
    });
    expect(v.defer).toBe(false);
    expect(v.reasons).toContain('leader_not_add');
  });
});

describe('averageEntryAfterScaleIn', () => {
  it('weights by USD size', () => {
    const avg = averageEntryAfterScaleIn({
      prevEntryUsd: 100,
      prevSizeUsd: 30,
      addFillUsd: 80,
      addSizeUsd: 15,
    });
    expect(avg).toBeCloseTo((100 * 30 + 80 * 15) / 45, 8);
  });
});
