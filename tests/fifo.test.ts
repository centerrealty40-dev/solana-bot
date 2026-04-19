import { describe, expect, it } from 'vitest';
import { buildWalletAggregate, computeTrancheRatio } from '../src/scoring/fifo.js';
import type { Swap } from '../src/scoring/types.js';

function mkSwap(overrides: Partial<Swap> & {
  blockTime: Date;
  side: 'buy' | 'sell';
  baseAmountRaw: bigint;
  amountUsd: number;
  priceUsd: number;
}): Swap {
  return {
    id: 0n,
    signature: 'sig' + Math.random(),
    slot: 1,
    wallet: 'W',
    baseMint: 'MINT',
    quoteMint: 'USDC',
    quoteAmountRaw: BigInt(Math.round(overrides.amountUsd * 1_000_000)),
    dex: 'raydium',
    source: 'helius_webhook',
    createdAt: new Date(),
    ...overrides,
  } as Swap;
}

describe('FIFO PnL', () => {
  it('computes a single round-trip win', () => {
    const swaps: Swap[] = [
      mkSwap({ blockTime: new Date('2026-01-01T00:00:00Z'), side: 'buy', baseAmountRaw: 1_000_000n, amountUsd: 100, priceUsd: 100 }),
      mkSwap({ blockTime: new Date('2026-01-01T01:00:00Z'), side: 'sell', baseAmountRaw: 1_000_000n, amountUsd: 200, priceUsd: 200 }),
    ];
    const agg = buildWalletAggregate('W', swaps);
    const pos = agg.positions.get('MINT')!;
    expect(pos.realizedPnlUsd).toBeGreaterThan(99);
    expect(pos.realizedPnlUsd).toBeLessThan(101);
    expect(pos.closedCount).toBe(1);
  });

  it('handles a partial exit', () => {
    const swaps: Swap[] = [
      mkSwap({ blockTime: new Date('2026-01-01T00:00:00Z'), side: 'buy', baseAmountRaw: 2_000_000n, amountUsd: 200, priceUsd: 100 }),
      mkSwap({ blockTime: new Date('2026-01-01T01:00:00Z'), side: 'sell', baseAmountRaw: 1_000_000n, amountUsd: 150, priceUsd: 150 }),
    ];
    const agg = buildWalletAggregate('W', swaps);
    const pos = agg.positions.get('MINT')!;
    expect(pos.realizedPnlUsd).toBeGreaterThan(0);
    expect(pos.closedCount).toBe(0);
  });

  it('detects multi-tranche exit', () => {
    const swaps: Swap[] = [
      mkSwap({ blockTime: new Date('2026-01-01T00:00:00Z'), side: 'buy', baseAmountRaw: 3_000_000n, amountUsd: 300, priceUsd: 100 }),
      mkSwap({ blockTime: new Date('2026-01-01T01:00:00Z'), side: 'sell', baseAmountRaw: 1_000_000n, amountUsd: 110, priceUsd: 110 }),
      mkSwap({ blockTime: new Date('2026-01-01T02:00:00Z'), side: 'sell', baseAmountRaw: 1_000_000n, amountUsd: 120, priceUsd: 120 }),
      mkSwap({ blockTime: new Date('2026-01-01T03:00:00Z'), side: 'sell', baseAmountRaw: 1_000_000n, amountUsd: 130, priceUsd: 130 }),
    ];
    expect(computeTrancheRatio(swaps)).toBeGreaterThan(0);
  });
});
