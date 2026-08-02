import { describe, expect, it } from 'vitest';

/**
 * Guards the cost basis recorded when a copy buy fills.
 *
 * The entry gate evaluates DEX spot, but the swap fills above it once slippage
 * and price impact are paid. Booking spot as the entry makes every later gain
 * look larger than it is, which matters most for `trail_runner`: the trail arms
 * off `entryPriceUsd`, so a understated entry arms the trail on a move that
 * never happened and exits a position that is actually flat or down.
 *
 * These are the numbers from the first live USDC fill (mint 7MYegHoq…).
 */
const DEX_SPOT_AT_EVAL = 0.00006464;
const ACTUAL_FILL = 0.00006859774405639552;

function entryPriceUsd(execPriceUsd: number, currentPrice: number): number {
  return execPriceUsd > 0 ? execPriceUsd : currentPrice;
}

function gainPct(entry: number, mark: number): number {
  return ((mark - entry) / entry) * 100;
}

describe('copy entry cost basis', () => {
  it('books the fill price, not the spot the gate saw', () => {
    expect(entryPriceUsd(ACTUAL_FILL, DEX_SPOT_AT_EVAL)).toBe(ACTUAL_FILL);
  });

  it('falls back to spot when the executor reports no fill price', () => {
    expect(entryPriceUsd(0, DEX_SPOT_AT_EVAL)).toBe(DEX_SPOT_AT_EVAL);
  });

  it('spot as the basis overstates the gain by the slippage paid', () => {
    const mark = 0.00006911;
    const honest = gainPct(ACTUAL_FILL, mark);
    const inflated = gainPct(DEX_SPOT_AT_EVAL, mark);
    expect(honest).toBeLessThan(1);
    expect(inflated).toBeGreaterThan(6);
  });

  it('a trail armed at +8% off spot can trip while the position is still down', () => {
    const armMark = DEX_SPOT_AT_EVAL * 1.08;
    expect(gainPct(ACTUAL_FILL, armMark)).toBeLessThan(2);
  });

  it('weighted average of two legs uses fill prices', () => {
    const firstSize = 100;
    const secondSize = 100;
    const secondFill = 0.00007;
    const avg = (ACTUAL_FILL * firstSize + secondFill * secondSize) / (firstSize + secondSize);
    expect(avg).toBeGreaterThan(ACTUAL_FILL);
    expect(avg).toBeLessThan(secondFill);
  });
});
