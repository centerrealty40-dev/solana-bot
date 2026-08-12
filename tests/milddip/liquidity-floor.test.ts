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

  it('is raised to $15k on the trading lane', () => {
    expect(Number(botEnv('MILD_DIP_MIN_LIQUIDITY_USD'))).toBe(15_000);
  });

  it('stays inside the range the sample actually covers', () => {
    const floor = Number(botEnv('MILD_DIP_MIN_LIQUIDITY_USD'));
    // Below $10k the mean was negative in every split; above $25k the sample
    // thins out to 76 bags and the relationship inverts.
    expect(floor).toBeGreaterThanOrEqual(12_000);
    expect(floor).toBeLessThanOrEqual(25_000);
  });

  it('leaves the observer lane untouched — it fits gates, it does not trade', () => {
    expect(eco).toContain("LEADER_OBSERVER_MIN_LIQUIDITY_USD: '5000'");
  });

  it('keeps the volume and mcap floors where they were', () => {
    expect(botEnv('MILD_DIP_MIN_VOLUME_5M_USD')).toBe('300');
    expect(botEnv('MILD_DIP_MIN_MCAP_USD')).toBe('5000');
  });
});
