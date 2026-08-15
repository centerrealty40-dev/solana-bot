import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MONEY_MOTIVATED_EXIT_REASONS,
  NEVER_DEFER_REASONS,
} from '../../src/milddip/exit-defer.js';

/**
 * 1.11.883 — the mark that decides an exit is a mid; the quote in the executor
 * is the price we can get. Over 2009 live sells those differed by a median
 * 0.99% and p25 −3.59%, so a sell taken *because* there was money on the table
 * routinely filled under our cost: 8PecVcC took the bounce half at −3.26% with
 * MFE 0.12%, twice.
 */
describe('cost floor on money-motivated sells', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
  const live = readFileSync(resolve('src/copytrader/live-exec.ts'), 'utf8');

  it('covers the exits taken for the money', () => {
    for (const reason of [
      'tp_grid',
      'mfe_bank_1',
      'mfe_bank_2',
      'mfe_bank_sleeve',
      'never_arm_bounce',
      'breakeven_stop',
    ]) {
      expect(MONEY_MOTIVATED_EXIT_REASONS.has(reason)).toBe(true);
    }
  });

  it('never blocks an exit that is leaving regardless', () => {
    for (const reason of [
      'hard_stop',
      'cliff_dump',
      'never_arm_freefall',
      'never_arm_time_red',
      'never_arm_dead',
      'never_arm_stale',
      'never_arm_timeout',
      'max_hold_underwater',
      'dust_close',
    ]) {
      expect(MONEY_MOTIVATED_EXIT_REASONS.has(reason)).toBe(false);
    }
    // The stops are also the ones the would-buy check may never defer.
    for (const reason of ['hard_stop', 'cliff_dump', 'never_arm_freefall']) {
      expect(NEVER_DEFER_REASONS.has(reason)).toBe(true);
    }
  });

  it('the floor is cost: the fill, or the mark beside it when that sat higher', () => {
    expect(loop).toContain('const costPriceUsd = Math.max(');
    expect(loop).toContain('MONEY_MOTIVATED_EXIT_REASONS.has(decision.reason) &&');
    expect(loop).toContain('guardedMinExitPriceUsd');
    expect(loop).toContain('minExitPriceGuard');
  });

  it('a decision already below cost is a cut, and cuts are never floored', () => {
    // 9PXM1p sat eleven hours at -27% issuing 2898 refused sells at
    // sell_quote_below_floor:-26.86%, one Jupiter quote each: breakeven_stop
    // also fires on a deeply red bag, and a floor at cost is unreachable there.
    expect(loop).toContain('decision.gainPct >= 0');
  });

  it('the executor checks the real quote before it signs', () => {
    // Before sendSwap, not after: an aborted sell must cost nothing on chain.
    const guardAt = live.indexOf('sell_quote_below_floor');
    const sendAt = live.indexOf("const sent = await sendSwap(cfg, prep.swapBuild.b64, {\n      side: 'sell',");
    expect(guardAt).toBeGreaterThan(0);
    expect(sendAt).toBeGreaterThan(guardAt);
    expect(live).toContain('exitPriceUsd < args.minExitPriceUsd');
  });

  it('uses a distinct journal kind for a refused profit fill', () => {
    expect(live).toContain('sell_quote_below_profit_slippage');
    expect(live).toContain("args.minExitPriceGuard === 'profit_fill_slippage'");
    expect(loop).toContain("minExitPriceGuard: sell.minExitPriceGuard ?? null");
  });
});
