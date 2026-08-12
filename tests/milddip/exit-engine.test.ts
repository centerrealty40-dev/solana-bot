import { describe, expect, it } from 'vitest';
import {
  applyMarkDecisionToPosition,
  decideMarkExit,
  mapPool,
  orderMintsForDexRefresh,
  orderMintsForMark,
} from '../../src/milddip/exit-engine.js';
import type { MildDipOpenPosition } from '../../src/milddip/state.js';

function pos(partial: Partial<MildDipOpenPosition> & { mint: string }): MildDipOpenPosition {
  return {
    symbol: partial.symbol ?? partial.mint.slice(0, 6),
    entryPriceUsd: partial.entryPriceUsd ?? 100,
    sizeUsd: partial.sizeUsd ?? 5,
    tokenRaw: partial.tokenRaw ?? '1',
    openedAtMs: partial.openedAtMs ?? 0,
    entryPc5mPct: partial.entryPc5mPct ?? -5,
    buySignature: partial.buySignature ?? null,
    peakPriceUsd: partial.peakPriceUsd,
    trailArmed: partial.trailArmed,
    scaleOutDone: partial.scaleOutDone,
    mint: partial.mint,
  };
}

describe('orderMintsForMark', () => {
  it('puts armed positions first, then older opens', () => {
    const open = {
      a: pos({ mint: 'a', openedAtMs: 100, trailArmed: false }),
      b: pos({ mint: 'b', openedAtMs: 300, trailArmed: true }),
      c: pos({ mint: 'c', openedAtMs: 200, trailArmed: false }),
      d: pos({ mint: 'd', openedAtMs: 50, trailArmed: true }),
    };
    expect(orderMintsForMark(open)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('orderMintsForDexRefresh', () => {
  it('puts missing/oldest ring age first (blind opens before fresh armed)', () => {
    const ages: Record<string, number> = {
      freshArmed: 1_000,
      mid: 60_000,
      blindNew: Number.POSITIVE_INFINITY,
      oldBlind: Number.POSITIVE_INFINITY,
    };
    const ordered = orderMintsForDexRefresh({
      mints: ['freshArmed', 'mid', 'blindNew', 'oldBlind'],
      nowMs: 1_000_000,
      ringAgeMs: (mint) => ages[mint] ?? 0,
    });
    expect(ordered.slice(0, 2).sort()).toEqual(['blindNew', 'oldBlind']);
    expect(ordered[2]).toBe('mid');
    expect(ordered[3]).toBe('freshArmed');
  });
});

const gatesForDust = {
  armPct: 5,
  partialGivebackPct: 3,
  scaleOutFraction: 0.5,
  givebackPct: 8,
  mfeBankEnabled: false,
  mfeBank1Pct: 8,
  mfeBank1Fraction: 0.4,
  mfeBank2Pct: 15,
  mfeBank2Fraction: 0.4,
  mfeBankSleeveGivebackPct: 12,
  neverArmPatienceMs: 0,
  neverArmMaxHoldMs: 5_400_000,
  neverArmDeadMinMs: 1_800_000,
  neverArmDeadPnlPct: 10,
  neverArmStaleMinMs: 600_000,
  neverArmStaleMaxMfePct: 2,
  neverArmStalePnlPct: 5,
  neverArmVolFadeMinMs: 900_000,
  neverArmVolFadeRatio: 0.25,
  neverArmVolFadeFloorUsd: 300,
  neverArmVolFadeSampleMs: 300_000,
  neverArmVolFadeWeakWindows: 3,
  cliffDumpPnlPct: 50,
  hardStopPnlPct: 15,
  hardStopPartialFraction: 0,
  neverArmBounceMinDumpPct: 8,
  neverArmBouncePct: 8,
  neverArmBounceMinTroughAgeMs: 60_000,
  neverArmBounceRequireRedPct: 3,
  neverArmBouncePartialFraction: 0.5,
  neverArmBounce2Pct: 16,
  mfeBankSleeveLossPartialFraction: 0.5,
  neverArmFreefallPnlPct: 25,
  neverArmFreefallMinMs: 60_000,
  neverArmTimeRedMinMs: 0,
  neverArmTimeRedPnlPct: 5,
  neverArmTimeRedMaxPc5mPct: 0,
  dustCloseUsd: 0,
  dustCloseMinHoldMs: 1_800_000,
};

describe('decideMarkExit / applyMarkDecisionToPosition', () => {
  const gates = {
    armPct: 5,
    partialGivebackPct: 3,
    scaleOutFraction: 0.5,
    givebackPct: 8,
    mfeBankEnabled: false,
    mfeBank1Pct: 8,
    mfeBank1Fraction: 0.4,
    mfeBank2Pct: 15,
    mfeBank2Fraction: 0.4,
    mfeBankSleeveGivebackPct: 12,
    neverArmPatienceMs: 0,
    neverArmMaxHoldMs: 5_400_000,
    neverArmDeadMinMs: 1_800_000,
    neverArmDeadPnlPct: 10,
    neverArmStaleMinMs: 600_000,
    neverArmStaleMaxMfePct: 2,
    neverArmStalePnlPct: 5,
    neverArmVolFadeMinMs: 900_000,
    neverArmVolFadeRatio: 0.25,
    neverArmVolFadeFloorUsd: 300,
    neverArmVolFadeSampleMs: 300_000,
    neverArmVolFadeWeakWindows: 3,
    cliffDumpPnlPct: 50,
    hardStopPnlPct: 15,
    hardStopPartialFraction: 0,
    neverArmBounceMinDumpPct: 8,
    neverArmBouncePct: 8,
    neverArmBounceMinTroughAgeMs: 60_000,
    neverArmBounceRequireRedPct: 3,
    neverArmBouncePartialFraction: 0.5,
    neverArmBounce2Pct: 16,
    mfeBankSleeveLossPartialFraction: 0.5,
    neverArmFreefallPnlPct: 25,
    neverArmFreefallMinMs: 60_000,
    neverArmTimeRedMinMs: 0,
    neverArmTimeRedPnlPct: 5,
    neverArmTimeRedMaxPc5mPct: 0,
    dustCloseUsd: 0,
    dustCloseMinHoldMs: 1_800_000,
  };

  describe('a mark above the fill is not profit (EUB1eZ, 1.11.848)', () => {
    // Filled at 7.683e-05 while the Dex mark held 8.492e-05 — the same value it
    // carried before the buy and for twelve seconds after. The bag read +10.52%,
    // armed, fired bank1 and sold at 7.279e-05.
    const FILL = 7.683396193886784e-5;
    const STALE_MARK = 8.492e-5;
    // entry-attempt seeds peakPriceUsd with the fill and records the Dex price
    // the entry was decided on.
    const fresh = (
      mint: string,
      entryPriceUsd: number,
      entryMarkPriceUsd?: number,
    ): MildDipOpenPosition => ({
      ...pos({ mint, entryPriceUsd, peakPriceUsd: entryPriceUsd, openedAtMs: 1_000_000 }),
      entryMarkPriceUsd,
    });
    const bankGates = {
      ...gates,
      mfeBankEnabled: true,
      mfeBank1Pct: 6,
      mfeBank1Fraction: 0.4,
      mfeBank2Pct: 8,
      mfeBank2Fraction: 0.6,
    };

    it('does not arm or bank when the price has not moved', () => {
      const p = fresh('eub', FILL, STALE_MARK);
      const d = decideMarkExit({
        mint: 'eub',
        pos: p,
        markPriceUsd: STALE_MARK,
        gates: bankGates,
        nowMs: 1_040_000,
      });
      expect(d?.mfePct).toBeCloseTo(0, 6);
      expect(d?.armed).toBe(false);
      expect(d?.shouldExit).toBe(false);
      // P&L still answers to the fill, so the stop keeps its real basis.
      expect(d?.pnlPct).toBeCloseTo(10.52, 1);
    });

    it('measures a later gain from the mark series, not the fill', () => {
      const p = fresh('eub2', FILL, STALE_MARK);
      const first = decideMarkExit({
        mint: 'eub2',
        pos: p,
        markPriceUsd: STALE_MARK,
        gates: bankGates,
        nowMs: 1_040_000,
      })!;
      applyMarkDecisionToPosition(p, first);
      expect(first.mfeBasisPriceUsd).toBeCloseTo(STALE_MARK, 12);

      const up = decideMarkExit({
        mint: 'eub2',
        pos: p,
        markPriceUsd: STALE_MARK * 1.07,
        gates: bankGates,
        nowMs: 1_100_000,
      });
      expect(up?.mfePct).toBeCloseTo(7, 1);
      expect(up?.shouldExit).toBe(true);
      expect(up?.reason).toBe('mfe_bank_1');
    });

    it('leaves the fill as the basis when the first mark comes in below it', () => {
      const p = fresh('eub3', FILL, FILL * 0.97);
      const d = decideMarkExit({
        mint: 'eub3',
        pos: p,
        markPriceUsd: FILL * 0.97,
        gates: bankGates,
        nowMs: 1_040_000,
      })!;
      applyMarkDecisionToPosition(p, d);
      expect(d.mfeBasisPriceUsd).toBeNull();
      expect(d.mfePct).toBeCloseTo(0, 6);
      expect(d.pnlPct).toBeCloseTo(-3, 1);
    });

    it('still counts a genuine move when the entry mark matched the fill', () => {
      const p = fresh('eub4', 100);
      const flat = decideMarkExit({
        mint: 'eub4',
        pos: p,
        markPriceUsd: 100,
        gates: bankGates,
        nowMs: 1_010_000,
      })!;
      applyMarkDecisionToPosition(p, flat);
      const up = decideMarkExit({
        mint: 'eub4',
        pos: p,
        markPriceUsd: 130,
        gates: bankGates,
        nowMs: 1_020_000,
      })!;
      expect(up.mfePct).toBeCloseTo(30, 6);
    });
  });

  describe('unbounded TP ladder, Oscar half8_runner (1.11.849)', () => {
    const grid = {
      ...gates,
      mfeBankEnabled: true,
      mfeBank1Pct: 6,
      mfeBank1Fraction: 0.4,
      mfeBank2Pct: 8,
      mfeBank2Fraction: 0.6,
      tpGridStepPct: 8,
      tpGridSellFraction: 0.5,
      mfeBankSleeveGivebackPct: 12,
      hardStopPnlPct: 25,
      mfeBankMinHoldMs: 20_000,
    };
    const bag = (mint: string, rungsDone?: number): MildDipOpenPosition => ({
      ...pos({ mint, entryPriceUsd: 100, peakPriceUsd: 100, openedAtMs: 1_000_000 }),
      tpRungsDone: rungsDone,
    });
    const at = (p: MildDipOpenPosition, price: number, heldMs = 60_000) =>
      decideMarkExit({ mint: p.mint, pos: p, markPriceUsd: price, gates: grid, nowMs: 1_000_000 + heldMs });

    it('takes half the remainder at the first +8% and leaves the bag alive', () => {
      const d = at(bag('g1'), 108);
      expect(d?.reason).toBe('tp_grid');
      expect(d?.fraction).toBe(0.5);
      expect(d?.tpRungIndex).toBe(1);
    });

    it('closes the bag on the rung that would leave under 20% (1.11.861)', () => {
      // Half-remainder steps: 1.00 -> 0.50 -> 0.25, and the next would be
      // 0.125, under the 0.20 floor, so rung 3 takes the whole remainder.
      const g = { ...grid, tpGridMinRemainderFraction: 0.2 };
      const r1 = decideMarkExit({ mint: 'f1', pos: bag('f1', 0), markPriceUsd: 108, gates: g, nowMs: 1_060_000 });
      expect(r1?.fraction).toBe(0.5);
      const r2 = decideMarkExit({ mint: 'f2', pos: bag('f2', 1), markPriceUsd: 116, gates: g, nowMs: 1_060_000 });
      expect(r2?.fraction).toBe(0.5);
      const r3 = decideMarkExit({ mint: 'f3', pos: bag('f3', 2), markPriceUsd: 124, gates: g, nowMs: 1_060_000 });
      expect(r3?.reason).toBe('tp_grid');
      expect(r3?.fraction).toBe(1);
      expect(r3?.tpRungIndex).toBe(3);
    });

    it('a floor of 0 leaves the ladder unbounded', () => {
      const g = { ...grid, tpGridMinRemainderFraction: 0 };
      const d = decideMarkExit({ mint: 'f0', pos: bag('f0', 2), markPriceUsd: 124, gates: g, nowMs: 1_060_000 });
      expect(d?.fraction).toBe(0.5);
    });

    it('a tighter step still stops at the same share of the bag', () => {
      // 0.25 per rung: 1.00 -> .75 -> .5625 -> .4219 -> .3164 -> .2373 -> .178,
      // so the sixth rung is the one that would breach 0.20.
      const g = { ...grid, tpGridSellFraction: 0.25, tpGridMinRemainderFraction: 0.2 };
      const fifth = decideMarkExit({ mint: 'q5', pos: bag('q5', 4), markPriceUsd: 148, gates: g, nowMs: 1_060_000 });
      expect(fifth?.fraction).toBe(0.25);
      const sixth = decideMarkExit({ mint: 'q6', pos: bag('q6', 5), markPriceUsd: 156, gates: g, nowMs: 1_060_000 });
      expect(sixth?.fraction).toBe(1);
    });

    it('keeps paying on every further +8% with no upper rung', () => {
      // With the floor off, the ladder still has no ceiling.
      const g = { ...grid, tpGridMinRemainderFraction: 0 };
      for (const [rungsDone, price, rung] of [
        [1, 116, 2],
        [2, 124, 3],
        [5, 148, 6],
        [11, 196, 12],
        [40, 428, 41],
      ] as const) {
        const d = decideMarkExit({
          mint: `g${rung}`,
          pos: bag(`g${rung}`, rungsDone),
          markPriceUsd: price,
          gates: g,
          nowMs: 1_060_000,
        });
        expect(d?.reason).toBe('tp_grid');
        expect(d?.tpRungIndex).toBe(rung);
        expect(d?.fraction).toBe(0.5);
      }
    });

    it('fires one rung per tick when the price gaps through several', () => {
      const d = at(bag('g_gap'), 140); // +40% supports rung 5
      expect(d?.tpRungIndex).toBe(1);
    });

    it('owes no rung the current price does not support, even after a high peak', () => {
      const p = bag('g_spent', 1);
      p.peakPriceUsd = 200; // MFE +100%, but the price has come back to +9%
      const d = decideMarkExit({
        mint: 'g_spent',
        pos: p,
        markPriceUsd: 109,
        gates: { ...grid, mfeBankSleeveGivebackPct: 0 },
        nowMs: 1_060_000,
      });
      expect(d?.shouldExit).toBe(false);
    });

    it('holds between rungs', () => {
      expect(at(bag('g_mid', 1), 112)?.shouldExit).toBe(false);
    });

    it('respects the settle grace before the first rung', () => {
      expect(at(bag('g_early'), 108, 5_000)?.shouldExit).toBe(false);
    });

    it('trails the remainder from the peak once the rungs are caught up', () => {
      const p = bag('g_trail', 3);
      p.peakPriceUsd = 150;
      const d = decideMarkExit({
        mint: 'g_trail',
        pos: p,
        markPriceUsd: 150 * 0.87,
        gates: grid,
        nowMs: 1_060_000,
      });
      expect(d?.reason).toBe('mfe_bank_sleeve');
      expect(d?.fraction).toBe(1);
    });

    it('leaves the loss exits exactly as they were', () => {
      const stop = at(bag('g_stop'), 74);
      expect(stop?.reason).toBe('hard_stop');
      expect(stop?.fraction).toBe(1);
      // The −25% floor is checked before the −50% cliff, so a −51% mark is
      // still a hard_stop; both are full exits and neither is touched here.
      const deep = at(bag('g_deep'), 49);
      expect(deep?.reason).toBe('hard_stop');
      expect(deep?.fraction).toBe(1);
    });

    it('falls back to the two-rung bank when the grid is off', () => {
      const off = { ...grid, tpGridStepPct: 0 };
      const d = decideMarkExit({
        mint: 'g_off',
        pos: bag('g_off'),
        markPriceUsd: 108,
        gates: off,
        nowMs: 1_060_000,
      });
      expect(d?.reason).toBe('mfe_bank_1');
    });
  });

  describe('the leader model: no ladder, one full exit on a 30% trail (1.11.850)', () => {
    // Both ladders off, no partial scale-out, trail 30% below the peak.
    const leader = {
      ...gates,
      mfeBankEnabled: true,
      mfeBank1Pct: 0,
      tpGridStepPct: 0,
      partialGivebackPct: 0,
      givebackPct: 30,
      armPct: 5,
      hardStopPnlPct: 25,
    };
    const bag = (mint: string, peak?: number, armed?: boolean): MildDipOpenPosition =>
      pos({ mint, entryPriceUsd: 100, peakPriceUsd: peak ?? 100, trailArmed: armed, openedAtMs: 1_000_000 });
    const at = (p: MildDipOpenPosition, price: number) =>
      decideMarkExit({ mint: p.mint, pos: p, markPriceUsd: price, gates: leader, nowMs: 1_120_000 });

    it('takes nothing on the way up, however far it runs', () => {
      for (const px of [108, 125, 160, 240, 600, 1200]) {
        const d = at(bag('l_up', px - 1, true), px);
        expect(d?.shouldExit).toBe(false);
      }
    });

    it('closes the whole bag once it gives back 30% of the peak', () => {
      const d = at(bag('l_trail', 600, true), 600 * 0.69);
      expect(d?.reason).toBe('peak_giveback');
      expect(d?.fraction).toBe(1);
    });

    it('holds while the giveback is still inside the trail', () => {
      expect(at(bag('l_hold', 600, true), 600 * 0.75)?.shouldExit).toBe(false);
    });

    it('does not arm below +5%, so the trail cannot fire early', () => {
      expect(at(bag('l_unarmed', 104), 104 * 0.69)?.reason).not.toBe('peak_giveback');
    });

    it('still stops the loss at −25%', () => {
      const d = at(bag('l_stop'), 74);
      expect(d?.reason).toBe('hard_stop');
      expect(d?.fraction).toBe(1);
    });
  });

  describe('never sell into a red bounce (6SyrTP, 1.11.851)', () => {
    // Entry 4.8871e-05, trough 3.8207e-05 (−21.8%), reclaim to 4.4354e-05.
    // The old gate demanded >=3% red, so it sold half at −7.42%; twenty seconds
    // later the mark was 4.9161e-05, above entry.
    const ENTRY = 4.8871e-5;
    const TROUGH = 3.8207e-5;
    const bounced = { ...gates, neverArmBounceRequireRedPct: 0, neverArmBounceMinPnlPct: 0 };
    const old = { ...gates, neverArmBounceRequireRedPct: 3, neverArmBounceMinPnlPct: -1000 };
    const bag = (mint: string): MildDipOpenPosition => ({
      ...pos({ mint, entryPriceUsd: ENTRY, peakPriceUsd: ENTRY, openedAtMs: 1_000_000 }),
      postEntryTroughUsd: TROUGH,
      postEntryTroughAtMs: 1_000_000,
    });
    const at = (g: typeof gates, mint: string, price: number) =>
      decideMarkExit({ mint, pos: bag(mint), markPriceUsd: price, gates: g, nowMs: 1_130_000 });

    it('the old gate sold the reclaim while still 7% down', () => {
      const d = at(old, 'b_old', 4.5244e-5);
      expect(d?.reason).toBe('never_arm_bounce');
      expect(d?.pnlPct).toBeLessThan(-5);
    });

    it('now it holds through that same reclaim', () => {
      expect(at(bounced, 'b_new', 4.5244e-5)?.shouldExit).toBe(false);
    });

    it('and sells once the bounce has repaid the dip', () => {
      const d = at(bounced, 'b_green', 4.9611e-5);
      expect(d?.reason).toBe('never_arm_bounce');
      expect(d?.pnlPct).toBeGreaterThan(0);
    });

    it('leaves the −25% stop in charge below that', () => {
      const d = at(bounced, 'b_stop', ENTRY * 0.7);
      expect(d?.reason).toBe('hard_stop');
    });
  });

  describe('a single-tick collapse must be confirmed (1.11.852)', () => {
    // Live: 5.6420e-04 -> 3.2402e-04 in one stream print, -42.57%, on a bag at
    // +21.75%. The -25% stop closed the whole position; the name kept climbing.
    const ENTRY = 4.6342e-4;
    const STEADY = 5.642e-4;
    const PHANTOM = 3.2402e-4;
    const g = { ...gates, markJumpConfirmPct: 25, hardStopPnlPct: 25 };
    const held = (): MildDipOpenPosition =>
      pos({
        mint: 'jump',
        entryPriceUsd: ENTRY,
        peakPriceUsd: 5.695e-4,
        trailArmed: true,
        openedAtMs: 1_000_000,
      });
    const mark = (p: MildDipOpenPosition, px: number) =>
      decideMarkExit({ mint: 'jump', pos: p, markPriceUsd: px, gates: g, nowMs: 1_400_000 });

    it('does not stop out on the phantom print', () => {
      const p = held();
      applyMarkDecisionToPosition(p, mark(p, STEADY)!);
      const d = mark(p, PHANTOM)!;
      expect(d.markQuarantined).toBe(true);
      expect(d.shouldExit).toBe(false);
    });

    it('keeps peak, arm and last mark untouched while quarantined', () => {
      const p = held();
      applyMarkDecisionToPosition(p, mark(p, STEADY)!);
      const peakBefore = p.peakPriceUsd;
      applyMarkDecisionToPosition(p, mark(p, PHANTOM)!);
      expect(p.peakPriceUsd).toBe(peakBefore);
      expect(p.trailArmed).toBe(true);
      expect(p.lastMarkPriceUsd).toBeCloseTo(STEADY, 12);
      expect(p.pendingMarkPriceUsd).toBeCloseTo(PHANTOM, 12);
    });

    it('carries on normally when the next print is back at the real level', () => {
      const p = held();
      applyMarkDecisionToPosition(p, mark(p, STEADY)!);
      applyMarkDecisionToPosition(p, mark(p, PHANTOM)!);
      const back = mark(p, 5.6545e-4)!;
      expect(back.markQuarantined).toBeFalsy();
      expect(back.shouldExit).toBe(false);
      expect(back.pnlPct).toBeGreaterThan(20);
    });

    it('still stops out when a second print confirms the collapse', () => {
      const p = held();
      applyMarkDecisionToPosition(p, mark(p, STEADY)!);
      applyMarkDecisionToPosition(p, mark(p, PHANTOM)!);
      const again = mark(p, PHANTOM * 1.01)!;
      expect(again.markQuarantined).toBeFalsy();
      expect(again.reason).toBe('hard_stop');
      expect(again.fraction).toBe(1);
    });

    it('leaves ordinary moves alone', () => {
      const p = held();
      applyMarkDecisionToPosition(p, mark(p, STEADY)!);
      const d = mark(p, STEADY * 1.09)!;
      expect(d.markQuarantined).toBeFalsy();
    });
  });

  describe('a bag that was green does not come back as a loss (1.11.855)', () => {
    // 2iKmjMW3: entry 1.1357e-04, peak 1.2890e-04 (+13.5%), trail fired 33%
    // below the peak and realised −25.53%.
    const ENTRY = 1.1357e-4;
    const PEAK = 1.289e-4;
    // Live shape: no ladder, no partial scale-out, single exit on a 30% trail.
    const be = {
      ...gates,
      breakevenArmPct: 8,
      breakevenFloorPct: 0,
      givebackPct: 30,
      partialGivebackPct: 0,
      mfeBank1Pct: 0,
      tpGridStepPct: 0,
      hardStopPnlPct: 25,
    };
    const bag = (peak: number, armed = true): MildDipOpenPosition =>
      pos({ mint: 'be', entryPriceUsd: ENTRY, peakPriceUsd: peak, trailArmed: armed, openedAtMs: 1_000_000 });
    const at = (p: MildDipOpenPosition, px: number, g = be) =>
      decideMarkExit({ mint: 'be', pos: p, markPriceUsd: px, gates: g, nowMs: 1_400_000 });

    it('closes at breakeven instead of riding the trail to −25%', () => {
      const d = at(bag(PEAK), ENTRY * 0.999);
      expect(d?.reason).toBe('breakeven_stop');
      expect(d?.fraction).toBe(1);
    });

    it('leaves a green bag alone', () => {
      expect(at(bag(PEAK), ENTRY * 1.05)?.shouldExit).toBe(false);
    });

    it('does not apply before the bag was meaningfully green', () => {
      // MFE only +4%: the floor is not armed, so the old behaviour stands.
      const d = at(bag(ENTRY * 1.04), ENTRY * 0.999);
      expect(d?.reason).not.toBe('breakeven_stop');
    });

    it('still lets a real runner run', () => {
      expect(at(bag(ENTRY * 4), ENTRY * 3.2)?.shouldExit).toBe(false);
    });

    it('the −25% stop still owns anything deeper', () => {
      expect(at(bag(ENTRY * 1.02, false), ENTRY * 0.7)?.reason).toBe('hard_stop');
    });

    it('off by default', () => {
      const d = at(bag(PEAK), ENTRY * 0.999, { ...be, breakevenArmPct: 0 });
      expect(d?.reason).not.toBe('breakeven_stop');
    });
  });

  it('updates peak and arms without exiting', () => {
    const p = pos({
      mint: 'm1',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs: 1_000_000,
    });
    const d = decideMarkExit({
      mint: 'm1',
      pos: p,
      markPriceUsd: 110,
      gates,
      nowMs: 1_060_000,
    });
    expect(d).not.toBeNull();
    expect(d!.armed).toBe(true);
    expect(d!.justArmed).toBe(true);
    expect(d!.shouldExit).toBe(false);
    applyMarkDecisionToPosition(p, d!);
    expect(p.trailArmed).toBe(true);
    expect(p.peakPriceUsd).toBe(110);
  });

  it('queues exit on giveback after arm — position fields still mergeable', () => {
    const p = pos({
      mint: 'm2',
      entryPriceUsd: 100,
      peakPriceUsd: 108,
      trailArmed: true,
      openedAtMs: 1_000_000,
    });
    const d = decideMarkExit({
      mint: 'm2',
      pos: p,
      markPriceUsd: 99.36, // −8% of 108
      gates,
      nowMs: 1_060_000,
    });
    // Half-first: scale-out not taken → partial even on full −8% gap.
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('peak_giveback_partial');
    expect(d?.fraction).toBe(0.5);
    applyMarkDecisionToPosition(p, d!);
    // Still "open" until sell confirms — we only mutate trail fields here.
    expect(p.peakPriceUsd).toBe(108);
    expect(p.trailArmed).toBe(true);
  });

  it('queues full peak_giveback only after scale-out already taken', () => {
    const p = pos({
      mint: 'm2c',
      entryPriceUsd: 100,
      peakPriceUsd: 108,
      trailArmed: true,
      scaleOutDone: true,
      openedAtMs: 1_000_000,
    });
    const d = decideMarkExit({
      mint: 'm2c',
      pos: p,
      markPriceUsd: 99.36,
      gates,
      nowMs: 1_060_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('peak_giveback');
    expect(d?.fraction).toBe(1);
  });

  it('queues peak_giveback_partial at −3% when scale-out not yet taken', () => {
    const p = pos({
      mint: 'm2b',
      entryPriceUsd: 100,
      peakPriceUsd: 105,
      trailArmed: true,
      scaleOutDone: false,
      openedAtMs: 1_000_000,
    });
    const d = decideMarkExit({
      mint: 'm2b',
      pos: p,
      markPriceUsd: 101.85, // −3% of 105
      gates,
      nowMs: 1_060_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('peak_giveback_partial');
    expect(d?.fraction).toBe(0.5);
  });

  it('queues never-arm stale after 10m flat + red (before dead)', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm4',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    // −10% — still above hard-stop −15%; stale wants ≤ −5%
    const early = decideMarkExit({
      mint: 'm4',
      pos: p,
      markPriceUsd: 90,
      gates,
      nowMs: openedAtMs + 300_000,
    });
    expect(early?.shouldExit).toBe(false);

    const d = decideMarkExit({
      mint: 'm4',
      pos: p,
      markPriceUsd: 90,
      gates,
      nowMs: openedAtMs + 600_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_stale');
  });

  it('queues never-arm dead after 30m when stale is off and MFE moved', () => {
    const openedAtMs = 1_000_000;
    const gatesNoStale = { ...gates, neverArmStaleMinMs: 0, neverArmStalePnlPct: 0 };
    const p = pos({
      mint: 'm4d',
      entryPriceUsd: 100,
      peakPriceUsd: 104, // MFE 4% — would skip stale even if on
      trailArmed: false,
      openedAtMs,
    });
    const early = decideMarkExit({
      mint: 'm4d',
      pos: p,
      markPriceUsd: 88, // −12%
      gates: gatesNoStale,
      nowMs: openedAtMs + 900_000,
    });
    expect(early?.shouldExit).toBeFalsy();
    const d = decideMarkExit({
      mint: 'm4d',
      pos: p,
      markPriceUsd: 88, // −12%
      gates: gatesNoStale,
      nowMs: openedAtMs + 1_800_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_dead');
  });

  it('returns null for non-positive mark (keep tracking)', () => {
    const p = pos({ mint: 'm3', entryPriceUsd: 100 });
    expect(decideMarkExit({ mint: 'm3', pos: p, markPriceUsd: 0, gates })).toBeNull();
  });

  it('holds a flat unarmed bag while 5m volume stays alive', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm5',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    const d = decideMarkExit({
      mint: 'm5',
      pos: p,
      markPriceUsd: 98,
      gates,
      nowMs: openedAtMs + 1_800_000,
      volume5mUsd: 3_000,
    });
    expect(d?.shouldExit).toBe(false);
  });

  it('does not sell on a one-shot volume dip (Gymbmn case)', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm6',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 8_672;
    // Alive windows, then a single weak dip — must NOT exit.
    for (const [held, vol] of [
      [300_000, 4_000],
      [600_000, 3_500],
      [900_000, 1_199], // one weak tick vs entry×0.25 / floor
    ] as const) {
      const d = decideMarkExit({
        mint: 'm6',
        pos: p,
        markPriceUsd: 98,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: vol,
      });
      expect(d?.shouldExit).toBe(false);
      applyMarkDecisionToPosition(p, d!);
    }
    expect(p.volFadeSamples?.length).toBe(3);
  });

  it('exits only after 3 consecutive weak 5m windows', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm7',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    const marks: Array<[number, number, boolean]> = [
      [300_000, 900, false], // before minMs
      [600_000, 900, false], // still < 3 windows + minMs
      [900_000, 900, true], // 3rd consecutive weak + ≥15m
    ];
    for (const [held, vol, expectExit] of marks) {
      const d = decideMarkExit({
        mint: 'm7',
        pos: p,
        markPriceUsd: 98,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: vol,
      });
      expect(d?.shouldExit).toBe(expectExit);
      if (expectExit) expect(d?.reason).toBe('never_arm_vol_fade');
      applyMarkDecisionToPosition(p, d!);
    }
  });

  it('resets the weak streak when a strong window appears', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm7b',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    for (const [held, vol] of [
      [300_000, 500],
      [600_000, 500],
      [900_000, 3_000], // strong — breaks streak
      [1_200_000, 500],
      [1_500_000, 500],
    ] as const) {
      const d = decideMarkExit({
        mint: 'm7b',
        pos: p,
        markPriceUsd: 98,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: vol,
      });
      expect(d?.shouldExit).toBe(false);
      applyMarkDecisionToPosition(p, d!);
    }
    // Need one more weak window to reach 3 consecutive after the break.
    const d = decideMarkExit({
      mint: 'm7b',
      pos: p,
      markPriceUsd: 98,
      gates,
      nowMs: openedAtMs + 1_800_000,
      volume5mUsd: 500,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_vol_fade');
  });

  it('exits on sustained absolute floor with no entry baseline', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm7c',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    for (const held of [300_000, 600_000, 900_000] as const) {
      const d = decideMarkExit({
        mint: 'm7c',
        pos: p,
        markPriceUsd: 99,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: 120,
      });
      applyMarkDecisionToPosition(p, d!);
      if (held < 900_000) expect(d?.shouldExit).toBe(false);
      else {
        expect(d?.shouldExit).toBe(true);
        expect(d?.reason).toBe('never_arm_vol_fade');
      }
    }
  });

  it('does not vol-fade an armed position', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm8',
      entryPriceUsd: 100,
      peakPriceUsd: 120,
      trailArmed: true,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    for (const held of [300_000, 600_000, 900_000, 1_200_000, 1_500_000, 1_800_000] as const) {
      const d = decideMarkExit({
        mint: 'm8',
        pos: p,
        markPriceUsd: 118,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: 50,
      });
      expect(d?.shouldExit).toBe(false);
      applyMarkDecisionToPosition(p, d!);
    }
  });
});

describe('mapPool', () => {
  it('respects concurrency and preserves order', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = await mapPool(items, 3, async (n) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(maxInflight).toBeGreaterThan(1);
  });

  it('handles empty input', async () => {
    expect(await mapPool([], 8, async (x) => x)).toEqual([]);
  });
});

/**
 * 1.11.832 — a $1–2 remnant cannot produce a meaningful outcome (±1.3% of $1.20
 * is ±$0.02) but 8 of them held 9–23h were pulling 43% of all Dex marks.
 */
describe('dust close', () => {
  const dustGates = { ...gatesForDust, dustCloseUsd: 2, dustCloseMinHoldMs: 1_800_000 };

  it('closes a bank/bounce remnant once past the min hold', () => {
    const d = decideMarkExit({
      mint: 'crumb',
      pos: pos({
        mint: 'crumb',
        entryPriceUsd: 100,
        sizeUsd: 1.2,
        openedAtMs: 1_000_000,
        scaleOutDone: true,
      }),
      markPriceUsd: 99,
      gates: dustGates,
      nowMs: 2_800_000,
    });
    expect(d!.shouldExit).toBe(true);
    expect(d!.reason).toBe('dust_close');
    expect(d!.fraction).toBe(1);
  });

  it('leaves a young remnant alone', () => {
    const d = decideMarkExit({
      mint: 'young',
      pos: pos({
        mint: 'young',
        entryPriceUsd: 100,
        sizeUsd: 1.2,
        openedAtMs: 1_000_000,
        scaleOutDone: true,
      }),
      markPriceUsd: 99,
      gates: dustGates,
      nowMs: 1_600_000,
    });
    expect(d!.shouldExit).toBe(false);
  });

  it('never dust-closes a position above the threshold', () => {
    const d = decideMarkExit({
      mint: 'real',
      pos: pos({ mint: 'real', entryPriceUsd: 100, sizeUsd: 5, openedAtMs: 1_000_000 }),
      markPriceUsd: 99,
      gates: dustGates,
      nowMs: 88_000_000,
    });
    expect(d!.reason).not.toBe('dust_close');
  });

  it('never overrides an exit the gates already chose', () => {
    const d = decideMarkExit({
      mint: 'stopped',
      pos: pos({
        mint: 'stopped',
        entryPriceUsd: 100,
        sizeUsd: 1.2,
        openedAtMs: 1_000_000,
        scaleOutDone: true,
      }),
      markPriceUsd: 60,
      gates: dustGates,
      nowMs: 2_800_000,
    });
    expect(d!.shouldExit).toBe(true);
    expect(d!.reason).toBe('hard_stop');
  });

  it('never dust-closes a whole position, only a remnant', () => {
    // Live clip is $2 against a $2 threshold; without this the rule became an
    // unintended 30-minute max-hold on every position.
    const d = decideMarkExit({
      mint: 'whole',
      pos: pos({ mint: 'whole', entryPriceUsd: 100, sizeUsd: 2, openedAtMs: 1_000_000 }),
      markPriceUsd: 99,
      gates: dustGates,
      nowMs: 2_800_000,
    });
    expect(d!.reason).not.toBe('dust_close');
  });

  it('is off by default (threshold 0)', () => {
    const d = decideMarkExit({
      mint: 'off',
      pos: pos({ mint: 'off', entryPriceUsd: 100, sizeUsd: 1.2, openedAtMs: 1_000_000 }),
      markPriceUsd: 99,
      gates: { ...gatesForDust, dustCloseUsd: 0 },
      nowMs: 88_000_000,
    });
    expect(d!.reason).not.toBe('dust_close');
  });
});

