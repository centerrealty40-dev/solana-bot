import { describe, expect, it } from 'vitest';
import { streamPrintContradictsDex } from '../../src/milddip/exit-engine.js';

describe('stream quarantine Dex veto', () => {
  it('rejects a stream print that contradicts the live Dex mark', () => {
    expect(
      streamPrintContradictsDex({
        markSource: 'stream',
        markPriceUsd: 0.0038841,
        dexCrossCheckPx: 0.0030022,
        jumpLimitPct: 8,
      }),
    ).toBe(true);
  });

  it('accepts a stream print within the cross-check limit', () => {
    expect(
      streamPrintContradictsDex({
        markSource: 'stream',
        markPriceUsd: 0.00302,
        dexCrossCheckPx: 0.0030022,
        jumpLimitPct: 8,
      }),
    ).toBe(false);
  });

  it('does not veto when Dex is silent', () => {
    expect(
      streamPrintContradictsDex({
        markSource: 'stream',
        markPriceUsd: 0.0038841,
        dexCrossCheckPx: null,
        jumpLimitPct: 8,
      }),
    ).toBe(false);
  });

  it('does not compare a Dex mark against itself', () => {
    expect(
      streamPrintContradictsDex({
        markSource: 'dex',
        markPriceUsd: 0.0038841,
        dexCrossCheckPx: 0.0030022,
        jumpLimitPct: 8,
      }),
    ).toBe(false);
  });

  it('does not veto when the jump limit is disabled', () => {
    expect(
      streamPrintContradictsDex({
        markSource: 'stream',
        markPriceUsd: 0.0038841,
        dexCrossCheckPx: 0.0030022,
        jumpLimitPct: 0,
      }),
    ).toBe(false);
  });
});
