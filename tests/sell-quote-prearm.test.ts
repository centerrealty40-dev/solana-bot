/** 1.11.231 — unit tests для sell quote pre-arm. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setArmedSellQuote,
  consumeArmedSellQuote,
  clearArmedSellQuote,
  armedSellQuoteSnapshot,
  _resetArmedSellQuoteForTests,
} from '../src/live/sell-quote-prearm.js';

vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: vi.fn(),
}));

const MINT = 'F4kE1aaa11aaa11aaa11aaa11aaa11aaa11aaa11';

function makeEntry(over: Partial<Parameters<typeof setArmedSellQuote>[1]> = {}) {
  const now = Date.now();
  return {
    armedAtMs: now,
    expiresAtMs: now + 5_000,
    quoteResponse: { fake: true },
    quoteSnapshot: { provider: 'jupiter' },
    swapBuildB64: 'FAKE_B64',
    intentKind: 'sell_partial' as const,
    tokenAmountRaw: '1000000',
    ...over,
  };
}

describe('sell-quote-prearm', () => {
  beforeEach(() => {
    _resetArmedSellQuoteForTests();
  });

  it('consume returns null when not armed', () => {
    const r = consumeArmedSellQuote({
      mint: MINT,
      intentKind: 'sell_partial',
      tokenAmountRaw: '1000000',
    });
    expect(r).toBeNull();
  });

  it('arm then consume — returns entry, then null on second consume', () => {
    setArmedSellQuote(MINT, makeEntry());
    const first = consumeArmedSellQuote({
      mint: MINT,
      intentKind: 'sell_partial',
      tokenAmountRaw: '1000000',
    });
    expect(first).not.toBeNull();
    expect(first?.swapBuildB64).toBe('FAKE_B64');
    const second = consumeArmedSellQuote({
      mint: MINT,
      intentKind: 'sell_partial',
      tokenAmountRaw: '1000000',
    });
    expect(second).toBeNull();
  });

  it('does not return expired entries', () => {
    setArmedSellQuote(
      MINT,
      makeEntry({ expiresAtMs: Date.now() - 1000 }),
    );
    const r = consumeArmedSellQuote({
      mint: MINT,
      intentKind: 'sell_partial',
      tokenAmountRaw: '1000000',
    });
    expect(r).toBeNull();
  });

  it('sell_partial: tokenAmountRaw mismatch → null (no consume)', () => {
    setArmedSellQuote(MINT, makeEntry());
    const r = consumeArmedSellQuote({
      mint: MINT,
      intentKind: 'sell_partial',
      tokenAmountRaw: '999999',
    });
    expect(r).toBeNull();
    /** Entry must still be present для будущих consume. */
    const snap = armedSellQuoteSnapshot();
    expect(snap.length).toBe(1);
  });

  it('sell_full: tokenAmountRaw mismatch → still consumes (chain raw varies)', () => {
    setArmedSellQuote(MINT, makeEntry({ intentKind: 'sell_full' }));
    const r = consumeArmedSellQuote({
      mint: MINT,
      intentKind: 'sell_full',
      tokenAmountRaw: '7777777',
    });
    expect(r).not.toBeNull();
  });

  it('intentKind mismatch → null', () => {
    setArmedSellQuote(MINT, makeEntry({ intentKind: 'sell_partial' }));
    const r = consumeArmedSellQuote({
      mint: MINT,
      intentKind: 'sell_full',
      tokenAmountRaw: '1000000',
    });
    expect(r).toBeNull();
  });

  it('clearArmedSellQuote removes the entry', () => {
    setArmedSellQuote(MINT, makeEntry());
    expect(clearArmedSellQuote(MINT)).toBe(true);
    expect(clearArmedSellQuote(MINT)).toBe(false);
  });
});
