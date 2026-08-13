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

  it('sits at the p25 of their entries, $8k (1.11.894)', () => {
    // Below $8k is the only liquidity band negative in every window: -0.129 per
    // position over 12h, -0.070 over 24h, -0.112 across the journey, on 238
    // positions. Over 18,475 leader buy moments their p25 liquidity is $8,150,
    // so they essentially do not trade under it either.
    expect(Number(botEnv('MILD_DIP_MIN_LIQUIDITY_USD'))).toBe(8_000);
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

describe('1.11.870 a 5m volume ceiling keeps us out of the event', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  function botEnv(key: string): string | null {
    const anchor = eco.indexOf("MILD_DIP_POSITION_USD: '");
    const m = eco.slice(anchor).match(new RegExp(`${key}: '([^']*)'`));
    return m ? m[1] : null;
  }

  it('caps entry volume at $40k', () => {
    // 499 fully closed bags: the 94 entered above $40k of 5m volume carried
    // -$61.72 of a -$148.39 total at a 0.298 win rate, while every other
    // bucket sat between -$12.94 and -$29.82.
    expect(Number(botEnv('MILD_DIP_MAX_VOLUME_5M_USD'))).toBe(40_000);
  });

  it('the floor and the ceiling leave a working band', () => {
    const lo = Number(botEnv('MILD_DIP_MIN_VOLUME_5M_USD'));
    const hi = Number(botEnv('MILD_DIP_MAX_VOLUME_5M_USD'));
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo * 100);
  });

  it('the green lane is not bound by it — it wants hot names', () => {
    // Green is evaluated before these floors and asks for vol5m >= 8000.
    expect(eco).toContain("MILD_DIP_GREEN_MIN_VOL5M_USD");
  });
});

describe('1.11.872 entry overpay is capped', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  function botEnv(key: string): string | null {
    const anchor = eco.indexOf("MILD_DIP_POSITION_USD: '");
    const m = eco.slice(anchor).match(new RegExp(`${key}: '([^']*)'`));
    return m ? m[1] : null;
  }

  it('slippage tolerance is 200 bps, not 500', () => {
    // 472 buys against the Dex mark a median 1.02s before the fill: median
    // overpay +1.81%, p90 +7.5%, and 70.8% paid above the mark. Over 297 closed
    // bags the 4-8% overpay band ran -0.609 per bag at a 0.283 win rate.
    expect(Number(botEnv('MILD_DIP_SLIPPAGE_BPS'))).toBe(200);
  });

  it('both chase allowances match the measured 4% cap', () => {
    // Capping at 4% keeps 71.7% of bags and takes -$76.79 to -$33.34.
    expect(Number(botEnv('MILD_DIP_MAX_CHASE_PCT'))).toBe(4);
    expect(Number(botEnv('MILD_DIP_FAST_PATH_CHASE_PCT'))).toBe(4);
  });
});
