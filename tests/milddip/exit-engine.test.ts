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
    const bankGates = {
      ...gates,
      mfeBankEnabled: true,
      mfeBank1Pct: 6,
      mfeBank1Fraction: 0.4,
      mfeBank2Pct: 8,
      mfeBank2Fraction: 0.6,
    };

    it('does not arm or bank when the price has not moved', () => {
      const p = pos({ mint: 'eub', entryPriceUsd: FILL, openedAtMs: 1_000_000 });
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
      const p = pos({ mint: 'eub2', entryPriceUsd: FILL, openedAtMs: 1_000_000 });
      const first = decideMarkExit({
        mint: 'eub2',
        pos: p,
        markPriceUsd: STALE_MARK,
        gates: bankGates,
        nowMs: 1_040_000,
      })!;
      applyMarkDecisionToPosition(p, first);
      expect(p.mfeBasisPriceUsd).toBeCloseTo(STALE_MARK, 12);

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
      const p = pos({ mint: 'eub3', entryPriceUsd: FILL, openedAtMs: 1_000_000 });
      const d = decideMarkExit({
        mint: 'eub3',
        pos: p,
        markPriceUsd: FILL * 0.97,
        gates: bankGates,
        nowMs: 1_040_000,
      })!;
      applyMarkDecisionToPosition(p, d);
      expect(p.mfeBasisPriceUsd).toBeUndefined();
      expect(d.mfePct).toBeCloseTo(0, 6);
      expect(d.pnlPct).toBeCloseTo(-3, 1);
    });

    it('does not let a later spike raise the basis and erase a real gain', () => {
      const p = pos({ mint: 'eub4', entryPriceUsd: 100, openedAtMs: 1_000_000 });
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

