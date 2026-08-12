import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.844 — the liquidity floor is the one entry change the overnight analysis
 * supports on its own. Over 390 closed bags in 13h the mean outcome improves
 * monotonically with the floor across the well-sampled range ($5k −1.44%, $10k
 * −1.17%, $12k −0.57%, $15k +0.39%, $20k +1.39%) and only reverses at $30k where
 * n=76.
 *
 * $15k rather than the better-looking $20k: it is the highest floor that improves
 * the mean in all three sub-windows, and it keeps half the trade volume instead of
 * a third.
 */
describe('mild-dip liquidity floor', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  /** The bot block is the one carrying MILD_DIP_POSITION_USD. */
  function botEnv(key: string): string | null {
    const anchor = eco.indexOf("MILD_DIP_POSITION_USD: '");
    expect(anchor).toBeGreaterThan(0);
    const after = eco.slice(anchor);
    const m = after.match(new RegExp(`${key}: '([^']*)'`));
    return m ? m[1] : null;
  }

  it('sits inside the range the leaders trade, at $6k', () => {
    // 1288 leader buys with our own metrics within ten minutes: a $15k floor
    // blocked 65.9% of them, the largest single blocker by far. Their median
    // liquidity at entry is $11,344, p25 $6,726.
    expect(Number(botEnv('MILD_DIP_MIN_LIQUIDITY_USD'))).toBe(6_000);
  });

  it('does not go below the p10 of their entries', () => {
    const floor = Number(botEnv('MILD_DIP_MIN_LIQUIDITY_USD'));
    expect(floor).toBeGreaterThanOrEqual(4_300);
    expect(floor).toBeLessThanOrEqual(12_000);
  });

  it('leaves the observer lane untouched — it fits gates, it does not trade', () => {
    expect(eco).toContain("LEADER_OBSERVER_MIN_LIQUIDITY_USD: '5000'");
  });

  it('keeps the mcap floor and carries the widened volume floor', () => {
    expect(botEnv('MILD_DIP_MIN_VOLUME_5M_USD')).toBe('150');
    expect(botEnv('MILD_DIP_MIN_MCAP_USD')).toBe('5000');
  });
});

describe('1.11.864 the pair-age floor carries most of the risk control', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  function botEnv(key: string): string | null {
    const anchor = eco.indexOf("MILD_DIP_POSITION_USD: '");
    const m = eco.slice(anchor).match(new RegExp(`${key}: '([^']*)'`));
    return m ? m[1] : null;
  }

  it('admits nothing younger than six hours', () => {
    // 513 closed positions joined to the entry snapshot, counted in cash:
    // coins under 2h old carry 84.9% of the whole loss and under 6h, 91.6%.
    // A 6h floor keeps 211 of 513 and turns -$138.54 into -$11.43.
    expect(Number(botEnv('MILD_DIP_MIN_PAIR_AGE_HOURS'))).toBe(6);
  });

  it('still reaches the mature names the leaders trade', () => {
    // The other end stays wide: 32.7% of leader buys sit above 72h.
    expect(Number(botEnv('MILD_DIP_MAX_PAIR_AGE_HOURS'))).toBe(720);
  });
});
