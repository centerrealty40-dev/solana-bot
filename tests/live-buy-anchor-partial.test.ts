import { describe, expect, it } from 'vitest';
import { appendLiveBuyAnchorsAfterDca } from '../src/live/live-buy-anchor.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function makeOpenTrade(): OpenTrade {
  return {
    legs: [{ ts: 0, price: 1, marketPrice: 1, sizeUsd: 1000, reason: 'staged_avg' }],
    totalInvestedUsd: 1000,
    avgEntry: 1,
    avgEntryMarket: 1,
    entryLegSignatures: [],
  } as unknown as OpenTrade;
}

describe('appendLiveBuyAnchorsAfterDca — partial on-chain fills are recorded', () => {
  it('records a partial (ok:true) fill: leg + invested reconciled to executed, sig attached', () => {
    const ot = makeOpenTrade();
    appendLiveBuyAnchorsAfterDca(ot, {
      ok: true,
      partial: true,
      anchorMode: 'chain',
      executedUsdNotional: 500,
      confirmedBuyTxSignatures: ['sig-0'],
    });
    expect(ot.legs[0]!.sizeUsd).toBe(500);
    expect(ot.totalInvestedUsd).toBe(500);
    expect(ot.entryLegSignatures).toEqual(['sig-0']);
    expect(ot.liveAnchorMode).toBe('chain');
  });

  it('defense-in-depth: confirmed on-chain buy is attached even when ok:false', () => {
    const ot = makeOpenTrade();
    appendLiveBuyAnchorsAfterDca(ot, {
      ok: false,
      anchorMode: 'chain',
      executedUsdNotional: 500,
      confirmedBuyTxSignature: 'sig-x',
    });
    expect(ot.entryLegSignatures).toEqual(['sig-x']);
    expect(ot.legs[0]!.sizeUsd).toBe(500);
  });

  it('no-op when ok:false with no on-chain fill', () => {
    const ot = makeOpenTrade();
    appendLiveBuyAnchorsAfterDca(ot, { ok: false, anchorMode: 'simulate' });
    expect(ot.legs[0]!.sizeUsd).toBe(1000);
    expect(ot.totalInvestedUsd).toBe(1000);
    expect(ot.entryLegSignatures).toEqual([]);
  });
});
