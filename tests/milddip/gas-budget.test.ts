import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.833 — a mild-dip leg was costing 0.000055 SOL ($0.011 at $200/SOL):
 * 5_000 lamports of Solana base fee plus the full 50_000 priority cap. The cap is
 * halved-and-then-some to 20_000, and the base fee is the floor below which no
 * amount of tuning can go.
 */
describe('mild-dip gas budget', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const SOL_BASE_FEE_LAMPORTS = 5_000;
  const LAMPORTS_PER_SOL = 1_000_000_000;

  function mildDipPriorityMaxSol(): number {
    // The mild-dip app block is the one carrying MILD_DIP_MIN_FEE_SOL_RESERVE.
    const anchor = eco.indexOf('MILD_DIP_MIN_FEE_SOL_RESERVE');
    expect(anchor).toBeGreaterThan(0);
    const before = eco.slice(0, anchor);
    const key = 'LIVE_JUPITER_PRIORITY_MAX_SOL: ';
    const at = before.lastIndexOf(key);
    expect(at).toBeGreaterThan(0);
    const m = before.slice(at + key.length).match(/^'([\d.]+)'/);
    expect(m).not.toBeNull();
    return Number(m![1]);
  }

  it('caps the priority fee at 20_000 lamports', () => {
    expect(mildDipPriorityMaxSol() * LAMPORTS_PER_SOL).toBe(20_000);
  });

  it('keeps a worst-case leg at or under $0.006 at $200/SOL', () => {
    const lamports = mildDipPriorityMaxSol() * LAMPORTS_PER_SOL + SOL_BASE_FEE_LAMPORTS;
    const usd = (lamports / LAMPORTS_PER_SOL) * 200;
    expect(usd).toBeLessThanOrEqual(0.006);
  });

  it('does not chase $0.001 — that is the base fee, i.e. zero priority', () => {
    const baseFeeUsd = (SOL_BASE_FEE_LAMPORTS / LAMPORTS_PER_SOL) * 200;
    expect(baseFeeUsd).toBeCloseTo(0.001, 4);
    expect(mildDipPriorityMaxSol()).toBeGreaterThan(0);
  });
});
