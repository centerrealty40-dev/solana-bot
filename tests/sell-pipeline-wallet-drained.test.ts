import { describe, expect, it } from 'vitest';
import { sellPipelineWalletDrained } from '../src/live/wallet-zero-policy.js';

describe('sellPipelineWalletDrained', () => {
  it('30% partial does not drain', () => {
    const chain = 210_267_657_763n;
    const sold = 105_133_828_881n;
    expect(sellPipelineWalletDrained('sell_partial', sold, chain)).toBe(false);
  });

  it('full sell drains', () => {
    const chain = 210_267_657_763n;
    expect(sellPipelineWalletDrained('sell_full', chain, chain)).toBe(true);
  });

  it('partial that sold 96% drains', () => {
    const chain = 1000n;
    const sold = 960n;
    expect(sellPipelineWalletDrained('sell_partial', sold, chain)).toBe(true);
  });
});
