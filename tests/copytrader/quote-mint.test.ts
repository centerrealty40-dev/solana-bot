import { describe, expect, it } from 'vitest';
import {
  USDC_MINT,
  copyBuyInputAmountRaw,
  copyBuyQuotePriceUsd,
  copyQuoteNeedsSolUsd,
  copyQuoteRawToUsd,
  copyQuoteSpec,
  copySellQuotePriceUsd,
  parseCopyQuoteAsset,
} from '../../src/copytrader/quote-mint.js';

const WSOL = 'So11111111111111111111111111111111111111112';

describe('parseCopyQuoteAsset', () => {
  it('accepts aliases and raw mints', () => {
    expect(parseCopyQuoteAsset('USDC').asset).toBe('USDC');
    expect(parseCopyQuoteAsset('usdc').mint).toBe(USDC_MINT);
    expect(parseCopyQuoteAsset(USDC_MINT).asset).toBe('USDC');
    expect(parseCopyQuoteAsset('SOL').asset).toBe('SOL');
    expect(parseCopyQuoteAsset('WSOL').mint).toBe(WSOL);
    expect(parseCopyQuoteAsset(WSOL).asset).toBe('SOL');
  });

  it('defaults to SOL on missing or unknown input', () => {
    expect(parseCopyQuoteAsset(undefined).asset).toBe('SOL');
    expect(parseCopyQuoteAsset('').asset).toBe('SOL');
    expect(parseCopyQuoteAsset('garbage').asset).toBe('SOL');
  });

  it('carries the right decimals per asset', () => {
    expect(parseCopyQuoteAsset('SOL').unit).toBe(1e9);
    expect(parseCopyQuoteAsset('USDC').unit).toBe(1e6);
    expect(copyQuoteNeedsSolUsd(parseCopyQuoteAsset('SOL'))).toBe(true);
    expect(copyQuoteNeedsSolUsd(parseCopyQuoteAsset('USDC'))).toBe(false);
  });
});

describe('copyQuoteSpec', () => {
  it('reads the lane config and defaults to SOL', () => {
    expect(copyQuoteSpec({ quoteAsset: 'USDC' }).asset).toBe('USDC');
    expect(copyQuoteSpec({ quoteAsset: 'SOL' }).asset).toBe('SOL');
    expect(copyQuoteSpec({}).asset).toBe('SOL');
  });
});

describe('copyBuyInputAmountRaw', () => {
  it('sizes USDC 1:1 in micro units and SOL against the mark', () => {
    expect(copyBuyInputAmountRaw(parseCopyQuoteAsset('USDC'), 100, 0)).toBe(100_000_000);
    expect(copyBuyInputAmountRaw(parseCopyQuoteAsset('USDC'), 100, 200)).toBe(100_000_000);
    expect(copyBuyInputAmountRaw(parseCopyQuoteAsset('SOL'), 100, 200)).toBe(500_000_000);
  });

  it('survives a missing SOL mark only when USD-pegged', () => {
    expect(copyBuyInputAmountRaw(parseCopyQuoteAsset('USDC'), 100, 0)).toBe(100_000_000);
    expect(copyBuyInputAmountRaw(parseCopyQuoteAsset('SOL'), 100, 0)).toBeNull();
  });

  it('rejects a non-positive size', () => {
    expect(copyBuyInputAmountRaw(parseCopyQuoteAsset('USDC'), 0, 200)).toBeNull();
  });
});

describe('copyQuoteRawToUsd', () => {
  it('keeps the two decimal scales apart', () => {
    expect(copyQuoteRawToUsd(parseCopyQuoteAsset('USDC'), 100_000_000, 0)).toBe(100);
    expect(copyQuoteRawToUsd(parseCopyQuoteAsset('SOL'), 500_000_000, 200)).toBe(100);
  });

  it('cannot price SOL proceeds without a mark', () => {
    expect(copyQuoteRawToUsd(parseCopyQuoteAsset('SOL'), 500_000_000, 0)).toBe(0);
  });

  it('would misprice a fill badly if micro-USDC were read as lamports', () => {
    const correct = copyQuoteRawToUsd(parseCopyQuoteAsset('USDC'), 100_000_000, 200);
    const buggy = (100_000_000 / 1e9) * 200;
    expect(correct).toBe(100);
    expect(buggy).toBe(20);
  });
});

describe('copyBuyQuotePriceUsd', () => {
  it('prices $100 USDC for 1M tokens at $0.0001', () => {
    const priceUsd = copyBuyQuotePriceUsd({
      spec: parseCopyQuoteAsset('USDC'),
      inAmountRaw: '100000000',
      outAmountRaw: '1000000000000',
      solUsd: 0,
    });
    expect(priceUsd).toBeCloseTo(0.0001, 12);
  });

  it('agrees between SOL and USDC funding for an equivalent fill', () => {
    const viaUsdc = copyBuyQuotePriceUsd({
      spec: parseCopyQuoteAsset('USDC'),
      inAmountRaw: '100000000',
      outAmountRaw: '1000000000000',
      solUsd: 200,
    });
    const viaSol = copyBuyQuotePriceUsd({
      spec: parseCopyQuoteAsset('SOL'),
      inAmountRaw: '500000000',
      outAmountRaw: '1000000000000',
      solUsd: 200,
    });
    expect(viaUsdc).toBeCloseTo(viaSol, 12);
  });

  it('returns 0 on unusable input', () => {
    const spec = parseCopyQuoteAsset('USDC');
    expect(copyBuyQuotePriceUsd({ spec, inAmountRaw: '0', outAmountRaw: '1', solUsd: 1 })).toBe(0);
    expect(copyBuyQuotePriceUsd({ spec, inAmountRaw: '1', outAmountRaw: '0', solUsd: 1 })).toBe(0);
    expect(copyBuyQuotePriceUsd({ spec, inAmountRaw: null, outAmountRaw: 'x', solUsd: 1 })).toBe(0);
  });
});

describe('copySellQuotePriceUsd', () => {
  it('reads USDC proceeds at 6 decimals', () => {
    const { proceedsUsd, priceUsd } = copySellQuotePriceUsd({
      spec: parseCopyQuoteAsset('USDC'),
      outAmountRaw: '112000000',
      tokenAmountRaw: '1000000000000',
      solUsd: 0,
    });
    expect(proceedsUsd).toBe(112);
    expect(priceUsd).toBeCloseTo(0.000112, 12);
  });

  it('still uses the SOL mark for WSOL proceeds', () => {
    const { proceedsUsd } = copySellQuotePriceUsd({
      spec: parseCopyQuoteAsset('SOL'),
      outAmountRaw: '560000000',
      tokenAmountRaw: '1000000000000',
      solUsd: 200,
    });
    expect(proceedsUsd).toBeCloseTo(112, 9);
  });

  it('handles zero proceeds', () => {
    const { proceedsUsd, priceUsd } = copySellQuotePriceUsd({
      spec: parseCopyQuoteAsset('USDC'),
      outAmountRaw: '0',
      tokenAmountRaw: '1000000',
      solUsd: 0,
    });
    expect(proceedsUsd).toBe(0);
    expect(priceUsd).toBe(0);
  });
});

describe('USDC round trip', () => {
  it('reports the true +12% with no SOL mark at all', () => {
    const spec = parseCopyQuoteAsset('USDC');
    const entry = copyBuyQuotePriceUsd({
      spec,
      inAmountRaw: '100000000',
      outAmountRaw: '1000000000000',
      solUsd: 0,
    });
    const { priceUsd: exit } = copySellQuotePriceUsd({
      spec,
      outAmountRaw: '112000000',
      tokenAmountRaw: '1000000000000',
      solUsd: 0,
    });
    expect(((exit - entry) / entry) * 100).toBeCloseTo(12, 9);
  });

  it('is unaffected when SOL moves 30% between entry and exit', () => {
    const spec = parseCopyQuoteAsset('USDC');
    const entry = copyBuyQuotePriceUsd({
      spec,
      inAmountRaw: '100000000',
      outAmountRaw: '1000000000000',
      solUsd: 200,
    });
    const { priceUsd: exit } = copySellQuotePriceUsd({
      spec,
      outAmountRaw: '112000000',
      tokenAmountRaw: '1000000000000',
      solUsd: 140,
    });
    expect(((exit - entry) / entry) * 100).toBeCloseTo(12, 9);
  });

  it('would distort the same trade under SOL funding when SOL drops', () => {
    const spec = parseCopyQuoteAsset('SOL');
    const entry = copyBuyQuotePriceUsd({
      spec,
      inAmountRaw: '500000000',
      outAmountRaw: '1000000000000',
      solUsd: 200,
    });
    const { priceUsd: exit } = copySellQuotePriceUsd({
      spec,
      outAmountRaw: '560000000',
      tokenAmountRaw: '1000000000000',
      solUsd: 140,
    });
    expect(((exit - entry) / entry) * 100).toBeLessThan(0);
  });
});
