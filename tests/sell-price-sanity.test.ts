import { describe, expect, it } from 'vitest';
import {
  LIVE_PARTIAL_SELL_MAX_CHAIN_FRACTION,
  LIVE_SELL_GHOST_QUOTE_MAX_DEVIATION_FRAC,
  capPartialSellTokenRaw,
  fractionOfTokenRaw,
  isGhostMtmExitTick,
  liveSellPriceUsdSane,
  liveSellQuotePriceSanity,
  resolveLiveSellReferencePriceUsd,
  resolveObservedPriceUsdForJournal,
} from '../src/live/sell-price-sanity.js';

describe('liveSellQuotePriceSanity', () => {
  it('accepts quote within 25% of reference (DdPrHY entry ~0.0135)', () => {
    const r = liveSellQuotePriceSanity({
      quotePriceUsd: 0.012,
      referencePriceUsd: 0.0135,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects ghost quote ~4× too low vs reference (DdPrHY RCA)', () => {
    const r = liveSellQuotePriceSanity({
      quotePriceUsd: 0.003547,
      referencePriceUsd: 0.0135,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ghost_price_quote_rejected');
      expect(r.deviationFrac).toBeGreaterThan(LIVE_SELL_GHOST_QUOTE_MAX_DEVIATION_FRAC);
    }
  });

  it('rejects ghost quote ~4× too high vs reference', () => {
    const r = liveSellQuotePriceSanity({
      quotePriceUsd: 0.054,
      referencePriceUsd: 0.0135,
    });
    expect(r.ok).toBe(false);
  });

  it('passes when no reference anchor (floor-only)', () => {
    expect(liveSellQuotePriceSanity({ quotePriceUsd: 0.0055, referencePriceUsd: null }).ok).toBe(true);
  });

  it('rejects sub-floor prices even without reference', () => {
    const r = liveSellQuotePriceSanity({ quotePriceUsd: 6.11e-6, referencePriceUsd: 0.01 });
    expect(r.ok).toBe(false);
  });
});

describe('liveSellPriceUsdSane', () => {
  it('rejects ghost hot-tick prices below floor', () => {
    expect(liveSellPriceUsdSane(0.0055)).toBe(true);
    expect(liveSellPriceUsdSane(6.11e-6)).toBe(false);
    expect(liveSellPriceUsdSane(0)).toBe(false);
  });
});

describe('resolveLiveSellReferencePriceUsd', () => {
  it('prefers lastObserved over entry anchors', () => {
    expect(
      resolveLiveSellReferencePriceUsd({
        lastObservedPriceUsd: 0.012,
        avgEntryMarket: 0.0135,
        avgEntry: 0.013,
      }),
    ).toBe(0.012);
  });
});

describe('capPartialSellTokenRaw', () => {
  it('never sells more than 50% of chain on partial intent', () => {
    const chain = 1_000_000n;
    const computed = 900_000n;
    const r = capPartialSellTokenRaw({
      intentKind: 'sell_partial',
      computedRaw: computed,
      chainAmt: chain,
    });
    const maxAllowed = fractionOfTokenRaw(chain, LIVE_PARTIAL_SELL_MAX_CHAIN_FRACTION);
    expect(r.raw).toBe(maxAllowed);
    expect(r.cappedByPartialMax).toBe(true);
  });

  it('uses full chain balance on sell_full', () => {
    const chain = 1_000_000n;
    const r = capPartialSellTokenRaw({
      intentKind: 'sell_full',
      computedRaw: 100n,
      chainAmt: chain,
    });
    expect(r.raw).toBe(chain);
    expect(r.cappedByPartialMax).toBe(false);
  });

  it('does not cap when computed is below partial max', () => {
    const chain = 1_000_000n;
    const computed = 100_000n;
    const r = capPartialSellTokenRaw({
      intentKind: 'sell_partial',
      computedRaw: computed,
      chainAmt: chain,
    });
    expect(r.raw).toBe(computed);
    expect(r.cappedByPartialMax).toBe(false);
  });
});

describe('isGhostMtmExitTick', () => {
  it('detects single-tick plunge corrected by clamp', () => {
    expect(
      isGhostMtmExitTick({
        previousObservedUsd: 0.0135,
        rawUsd: 0.003547,
        clampedUsd: 0.01188,
      }),
    ).toBe(true);
  });

  it('returns false for normal tick within band', () => {
    expect(
      isGhostMtmExitTick({
        previousObservedUsd: 0.0135,
        rawUsd: 0.013,
        clampedUsd: 0.013,
      }),
    ).toBe(false);
  });
});

describe('resolveObservedPriceUsdForJournal', () => {
  it('stores clamped MTM when ghost raw deviates', () => {
    expect(resolveObservedPriceUsdForJournal(0.003547, 0.01188)).toBe(0.01188);
  });

  it('stores raw when clamp did not change tick', () => {
    expect(resolveObservedPriceUsdForJournal(0.013, 0.013)).toBe(0.013);
  });
});
