import { describe, expect, it } from 'vitest';
import {
  formatMirrorBuyAttempt,
  formatMirrorBuySuccess,
  mirrorBuyGmgnUrl,
} from '../../src/milddip/mirror-buy-notify.js';

describe('mirror buy notifications', () => {
  const mint = 'So11111111111111111111111111111111111111112';

  it('formats the successful buy with GMGN and mint', () => {
    const text = formatMirrorBuySuccess({ mint, symbol: 'TEST', spentUsd: 100 });
    expect(text).toContain('Купил TEST на $100.00');
    expect(text).toContain(`<a href="${mirrorBuyGmgnUrl(mint)}">GMGN</a>`);
    expect(text).toContain(`<code>${mint}</code>`);
  });

  it('formats a failed attempt distinctly', () => {
    const text = formatMirrorBuyAttempt({
      mint,
      symbol: 'TEST',
      reason: 'insufficient_funds',
    });
    expect(text).toContain('Была попытка купить TEST — insufficient_funds');
    expect(text).toContain(`https://gmgn.ai/sol/token/${encodeURIComponent(mint)}`);
    expect(text).not.toContain('Купил TEST');
  });
});
