import { describe, expect, it } from 'vitest';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import {
  bumpEntryDipPassStreak,
  entryDipConfirmReason,
  impliedBuyPriceUsdFromQuote,
  resetEntryDipPassStreak,
} from '../../src/copytrader/entry-dip-gate.js';
import { evaluateCopyEntryDip } from '../../src/copytrader/evaluate.js';
import { leaderDipTargetPx } from '../../src/copytrader/entry-probe.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';

const baseCfg = {
  positionUsd: 950,
  entryDipDiscountPct: 4,
  entryDipConfirmTicks: 2,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
} as CopyTraderConfig;

describe('impliedBuyPriceUsdFromQuote', () => {
  it('derives token price from Jupiter in/out amounts', () => {
    const solUsd = 150;
    const price = impliedBuyPriceUsdFromQuote(
      { inAmount: '1000000000', outAmount: '1000000000000' },
      solUsd,
    );
    expect(price).toBeCloseTo(0.00015, 8);
  });
});

describe('entry dip gate vs Bountywork incident', () => {
  const leader = 0.0008216620603848035;
  const target = leaderDipTargetPx(leader, 4);

  it('rejects dex flicker fill price above −4%', () => {
    const badFill = 0.0008010836860526911;
    expect(badFill).toBeGreaterThan(target);
    const r = evaluateCopyEntryDip(baseCfg, {
      mint: 'm',
      leaderPriceUsd: leader,
      leaderBuyUsd: 400,
      currentPriceUsd: badFill,
      dex: null,
      nowMs: Date.now(),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('price_not_low_enough'))).toBe(true);
  });

  it('requires consecutive pass ticks before fill', () => {
    const state = emptyCopyTraderState();
    state.pendingBuys.push({
      id: 'pb_1',
      mint: 'm',
      symbol: 'S',
      kind: 'entry',
      entryLeg: 'dip',
      sizeUsd: 600,
      leaderSignature: 'sig',
      leaderPriceUsd: leader,
      leaderBuyUsd: 400,
      leaderBuyTs: 0,
      dueTs: 0,
      retryUntilTs: 9999,
    });
    expect(bumpEntryDipPassStreak(state, 'pb_1')).toBe(1);
    expect(bumpEntryDipPassStreak(state, 'pb_1')).toBe(2);
    resetEntryDipPassStreak(state, 'pb_1');
    expect(state.pendingBuys[0]!.dipPassStreak).toBe(0);
  });

  it('formats confirm defer reason', () => {
    expect(entryDipConfirmReason(baseCfg, 1, target, leader)).toContain('1/2');
  });
});
