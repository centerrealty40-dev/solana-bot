import { describe, expect, it } from 'vitest';
import { judgeGreenStreamMark } from '../../src/milddip/exit-engine.js';

describe('judgeGreenStreamMark', () => {
  const base = {
    markSource: 'stream' as string | null,
    markPriceUsd: 0.00017138,
    lastMarkPriceUsd: 0.00022356 as number | null,
    dexCrossCheckPx: null as number | null,
    pendingMarkPriceUsd: null as number | null,
    pendingMarkAtMs: null as number | null,
    nowMs: 1_000_000,
    jumpLimitPct: 8,
    quarantineMaxMs: 8_000,
  };

  it('leaves a Dex mark alone', () => {
    expect(judgeGreenStreamMark({ ...base, markSource: 'dex' })).toBe('use');
  });

  it('is off when no jump limit is configured', () => {
    expect(judgeGreenStreamMark({ ...base, jumpLimitPct: 0 })).toBe('use');
  });

  it('accepts a move inside the limit', () => {
    expect(judgeGreenStreamMark({ ...base, markPriceUsd: 0.00022 })).toBe('use');
  });

  it('quarantines the live phantom print with no second feed', () => {
    expect(judgeGreenStreamMark(base)).toBe('quarantine');
  });

  it('quarantines a print the live Dex contradicts', () => {
    expect(judgeGreenStreamMark({ ...base, dexCrossCheckPx: 0.000223 })).toBe('quarantine');
  });

  it('uses a print the Dex confirms', () => {
    expect(judgeGreenStreamMark({ ...base, dexCrossCheckPx: 0.000172 })).toBe('use');
  });

  it('uses a print a second non-identical stream tick backs', () => {
    expect(
      judgeGreenStreamMark({ ...base, pendingMarkPriceUsd: 0.0001714, pendingMarkAtMs: 999_000 }),
    ).toBe('use');
  });

  it('discards an identical repeat once its window aged out', () => {
    expect(
      judgeGreenStreamMark({
        ...base,
        pendingMarkPriceUsd: 0.00017138,
        pendingMarkAtMs: base.nowMs - 9_000,
      }),
    ).toBe('discard');
  });

  it('keeps an identical repeat quarantined inside the window', () => {
    expect(
      judgeGreenStreamMark({
        ...base,
        pendingMarkPriceUsd: 0.00017138,
        pendingMarkAtMs: base.nowMs - 2_000,
      }),
    ).toBe('quarantine');
  });
});
