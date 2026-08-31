import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    entryMarkPriceUsd: partial.entryMarkPriceUsd,
    sizeUsd: partial.sizeUsd ?? 5,
    tokenRaw: partial.tokenRaw ?? '1',
    openedAtMs: partial.openedAtMs ?? 0,
    entryPc5mPct: partial.entryPc5mPct ?? -5,
    buySignature: partial.buySignature ?? null,
    peakPriceUsd: partial.peakPriceUsd,
    entryLiquidityUsd: partial.entryLiquidityUsd,
    liquidityDrainConfirmTicks: partial.liquidityDrainConfirmTicks,
    liquidityDrainSampleTsMs: partial.liquidityDrainSampleTsMs,
    lastMarkPriceUsd: partial.lastMarkPriceUsd,
    pendingMarkPriceUsd: partial.pendingMarkPriceUsd,
    pendingMarkSource: partial.pendingMarkSource,
    pendingMarkAtMs: partial.pendingMarkAtMs,
    markQuarantineSinceMs: partial.markQuarantineSinceMs,
    lane: partial.lane,
    trailArmed: partial.trailArmed,
    scaleOutDone: partial.scaleOutDone,
    mirrorLadderBasisPriceUsd: partial.mirrorLadderBasisPriceUsd,
    mirrorLadderRungsDone: partial.mirrorLadderRungsDone,
    mirrorAverageDone: partial.mirrorAverageDone,
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
  const mirrorGates = {
    takeProfitPct: 5,
    stopPct: 5,
    maxHoldMs: 1_000,
    noMoveCutMs: 500,
    noMoveMinMfePct: 2,
    trailEnabled: true,
    armPct: 5,
    trailPct: 5,
    mirrorFirstClipPending: false,
    mirrorEntrySettling: false,
  };

  it('manual adoption uses only its peak trail', () => {
    const manual = {
      ...mirrorGates,
      ownExitEnabled: true,
      leaderSellOnly: true,
      ladderEnabled: false,
      ladderMaxRungs: 0,
      ownExitTimeStopMs: 0,
      safetyMaxHoldMs: 0,
      maxHoldMs: 0,
      noMoveCutMs: 0,
      stopPct: 0,
      armPct: 3,
      trailPct: 8,
    };
    const base = {
      mint: 'manual-trail',
      pos: pos({
        mint: 'manual-trail',
        lane: 'leader_mirror',
        manualAdopted: true,
        entryPriceUsd: 100,
        peakPriceUsd: 100,
      }),
      gates: gatesForDust,
      mirrorGates: manual,
    };
    expect(decideMarkExit({ ...base, markPriceUsd: 102, nowMs: 1_000 })?.shouldExit).toBe(false);
    expect(decideMarkExit({ ...base, markPriceUsd: 110, nowMs: 2_000 })?.shouldExit).toBe(false);
    const exit = decideMarkExit({
      ...base,
      pos: { ...base.pos, peakPriceUsd: 110, trailArmed: true },
      markPriceUsd: 101,
      nowMs: 3_000,
    })!;
    expect(exit.reason).toBe('mirror_trail');
    expect(exit.shouldExit).toBe(true);
  });

  it.each([
    ['mirror_stop', { markPriceUsd: 90, nowMs: 100 }],
    ['mirror_trail', { markPriceUsd: 108, nowMs: 100, peakPriceUsd: 120 }],
    ['mirror_no_move', { markPriceUsd: 100, nowMs: 1_000 }],
    ['mirror_tp', { markPriceUsd: 110, nowMs: 100 }],
    ['mirror_max_hold', { markPriceUsd: 100, nowMs: 1_000 }],
  ] as const)('suppresses %s in leader-sell-only mode while retaining telemetry', (reason, sample) => {
    const d = decideMarkExit({
      mint: `mirror-only-${reason}`,
      pos: pos({
        mint: `mirror-only-${reason}`,
        lane: 'leader_mirror',
        openedAtMs: 0,
        peakPriceUsd: sample.peakPriceUsd,
      }),
      markPriceUsd: sample.markPriceUsd,
      nowMs: sample.nowMs,
      gates: gatesForDust,
      mirrorGates: { ...mirrorGates, leaderSellOnly: true },
    })!;
    expect(d.reason).toBeNull();
    expect(d.shouldExit).toBe(false);
    expect(d.fraction).toBe(0);
    expect(d.mfePct).toBeGreaterThanOrEqual(0);
  });

  it('preserves mirror green exits when leader-sell-only mode is disabled', () => {
    const d = decideMarkExit({
      mint: 'mirror-regression',
      pos: pos({ mint: 'mirror-regression', lane: 'leader_mirror' }),
      markPriceUsd: 110,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates,
    })!;
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('mirror_tp');
    expect(d.fraction).toBe(1);
  });

  it('uses the safety cut as the only scheduled mirror exit in leader-sell-only mode', () => {
    const d = decideMarkExit({
      mint: 'mirror-safety',
      pos: pos({ mint: 'mirror-safety', lane: 'leader_mirror' }),
      markPriceUsd: 100,
      nowMs: 1_000,
      gates: gatesForDust,
      mirrorGates: { ...mirrorGates, leaderSellOnly: true, safetyMaxHoldMs: 900 },
    })!;
    expect(d.shouldExit).toBe(true);
    expect(d.fraction).toBe(1);
    expect(d.reason).toBe('mirror_safety_cut');

    const off = decideMarkExit({
      mint: 'mirror-safety-off',
      pos: pos({ mint: 'mirror-safety-off', lane: 'leader_mirror' }),
      markPriceUsd: 110,
      nowMs: 10_000,
      gates: gatesForDust,
      mirrorGates: { ...mirrorGates, leaderSellOnly: true, safetyMaxHoldMs: 0 },
    })!;
    expect(off.shouldExit).toBe(false);
    expect(off.reason).toBeNull();
  });

  it('closes a sold-down mirror remnant but not an untouched position', () => {
    const mirrorDust = {
      ...mirrorGates,
      leaderSellOnly: true,
      mirrorDustCloseUsd: 10,
    };
    const untouched = decideMarkExit({
      mint: 'mirror-dust-untouched',
      pos: pos({
        mint: 'mirror-dust-untouched',
        lane: 'leader_mirror',
        sizeUsd: 50,
      }),
      markPriceUsd: 15,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: mirrorDust,
    })!;
    expect(untouched.shouldExit).toBe(false);
    expect(untouched.reason).toBeNull();

    const remnant = decideMarkExit({
      mint: 'mirror-dust-remnant',
      pos: pos({
        mint: 'mirror-dust-remnant',
        lane: 'leader_mirror',
        sizeUsd: 8,
        scaleOutDone: true,
      }),
      markPriceUsd: 100,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: mirrorDust,
    })!;
    expect(remnant.shouldExit).toBe(true);
    expect(remnant.fraction).toBe(1);
    expect(remnant.reason).toBe('mirror_dust_close');

    const smallDustThreshold = {
      ...mirrorGates,
      leaderSellOnly: true,
      mirrorDustCloseUsd: 3,
      ladderStepPct: 5,
      ladderStepAfterAveragePct: 10,
      ladderSellFraction: 0.2,
    };
    const partial = decideMarkExit({
      mint: 'mirror-dust-below-clip',
      pos: pos({
        mint: 'mirror-dust-below-clip',
        lane: 'leader_mirror',
        sizeUsd: 8,
        scaleOutDone: true,
      }),
      markPriceUsd: 105,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: smallDustThreshold,
    })!;
    expect(partial.shouldExit).toBe(true);
    expect(partial.fraction).toBeCloseTo(0.2);
    expect(partial.reason).toBe('mirror_tp_ladder');

    const dustBlocked = decideMarkExit({
      mint: 'mirror-dust-unsettled',
      pos: pos({
        mint: 'mirror-dust-unsettled',
        lane: 'leader_mirror',
        sizeUsd: 8,
        scaleOutDone: true,
      }),
      markPriceUsd: 100,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: {
        ...mirrorDust,
        mirrorEntrySettling: true,
        mirrorEntrySettlementAgeMs: 10_000,
      },
    })!;
    expect(dustBlocked.shouldExit).toBe(false);
    expect(dustBlocked.reason).toBeNull();
    expect(dustBlocked.mirrorExitSuppressedReason).toBe('entry_settling');
  });

  it('holds the mirror ladder until the first clip and entry settle', () => {
    const ladder = {
      ...mirrorGates,
      leaderSellOnly: true,
      ladderStepPct: 5,
      ladderSellFraction: 0.2,
    };
    const firstClipPending = decideMarkExit({
      mint: 'mirror-ladder-first-clip-pending',
      pos: pos({
        mint: 'mirror-ladder-first-clip-pending',
        lane: 'leader_mirror',
        mirrorFirstClipLegsFilled: 1,
      }),
      markPriceUsd: 110,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: { ...ladder, mirrorFirstClipPending: true },
    })!;
    expect(firstClipPending.shouldExit).toBe(false);
    expect(firstClipPending.reason).toBeNull();
    expect(firstClipPending.mirrorExitSuppressedReason).toBe('first_clip_pending');

    const settling = decideMarkExit({
      mint: 'mirror-ladder-entry-settling',
      pos: pos({
        mint: 'mirror-ladder-entry-settling',
        lane: 'leader_mirror',
      }),
      markPriceUsd: 110,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: {
        ...ladder,
        mirrorEntrySettling: true,
        mirrorEntrySettlementAgeMs: 30_000,
      },
    })!;
    expect(settling.shouldExit).toBe(false);
    expect(settling.reason).toBeNull();
    expect(settling.mirrorExitSuppressedReason).toBe('entry_settling');

    const settled = decideMarkExit({
      mint: 'mirror-ladder-entry-settled',
      pos: pos({
        mint: 'mirror-ladder-entry-settled',
        lane: 'leader_mirror',
        mirrorLadderRungsDone: 0,
      }),
      markPriceUsd: 110,
      nowMs: 45_001,
      gates: gatesForDust,
      mirrorGates: {
        ...ladder,
        mirrorEntrySettling: false,
        mirrorEntrySettlementAgeMs: 45_001,
      },
    })!;
    expect(settled.shouldExit).toBe(true);
    expect(settled.reason).toBe('mirror_tp_ladder');

    const safety = decideMarkExit({
      mint: 'mirror-ladder-safety',
      pos: pos({
        mint: 'mirror-ladder-safety',
        lane: 'leader_mirror',
        openedAtMs: 0,
      }),
      markPriceUsd: 100,
      nowMs: 1_000,
      gates: gatesForDust,
      mirrorGates: {
        ...ladder,
        mirrorFirstClipPending: true,
        mirrorEntrySettling: true,
        mirrorEntrySettlementAgeMs: 100,
        safetyMaxHoldMs: 900,
      },
    })!;
    expect(safety.shouldExit).toBe(true);
    expect(safety.reason).toBe('mirror_safety_cut');
  });

  it('allows the opt-in mirror trail through leader-sell-only mode', () => {
    const ownExit = {
      ...mirrorGates,
      leaderSellOnly: true,
      ownExitEnabled: true,
      ownExitTimeStopMs: 3_600_000,
      armPct: 5,
      trailPct: 3,
    };
    const p = pos({
      mint: 'mirror-own-trail',
      lane: 'leader_mirror',
      openedAtMs: 0,
      entryMarkPriceUsd: 110,
      lastMarkPriceUsd: 110,
      peakPriceUsd: 110,
    });
    const armed = decideMarkExit({
      mint: p.mint,
      pos: p,
      markPriceUsd: 115.5,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: ownExit,
    })!;
    expect(armed.armed).toBe(true);
    expect(armed.shouldExit).toBe(false);
    applyMarkDecisionToPosition(p, armed);
    const trail = decideMarkExit({
      mint: p.mint,
      pos: p,
      markPriceUsd: 115.5 * 0.97,
      nowMs: 200,
      gates: gatesForDust,
      mirrorGates: ownExit,
    })!;
    expect(trail.shouldExit).toBe(true);
    expect(trail.fraction).toBe(1);
    expect(trail.reason).toBe('mirror_trail');
  });

  it('arms the mirror trail from fill cost, not a stale entry mark', () => {
    const ownExit = {
      ...mirrorGates,
      leaderSellOnly: true,
      ownExitEnabled: true,
      ownExitTimeStopMs: 3_600_000,
      armPct: 5,
      trailPct: 3,
    };
    const p = pos({
      mint: 'mirror-trail-fill-basis',
      lane: 'leader_mirror',
      openedAtMs: 0,
      entryPriceUsd: 100,
      entryMarkPriceUsd: 87,
      peakPriceUsd: 100,
    });
    const nearFill = decideMarkExit({
      mint: p.mint,
      pos: p,
      markPriceUsd: 100.2,
      nowMs: 100,
      gates: gatesForDust,
      mirrorGates: ownExit,
    })!;
    expect(nearFill.armed).toBe(false);
    expect(nearFill.shouldExit).toBe(false);

    const high = decideMarkExit({
      mint: p.mint,
      pos: p,
      markPriceUsd: 106,
      nowMs: 200,
      gates: gatesForDust,
      mirrorGates: ownExit,
    })!;
    expect(high.armed).toBe(true);
    expect(high.shouldExit).toBe(false);
    applyMarkDecisionToPosition(p, high);

    const pullback = decideMarkExit({
      mint: p.mint,
      pos: p,
      markPriceUsd: 106 * 0.97,
      nowMs: 300,
      gates: gatesForDust,
      mirrorGates: ownExit,
    })!;
    expect(pullback.shouldExit).toBe(true);
    expect(pullback.reason).toBe('mirror_trail');
    expect(pullback.pnlPct).toBeGreaterThan(0);
  });

  it('does not carry a legacy armed flag across the new arm threshold', () => {
    const d = decideMarkExit({
      mint: 'mirror-legacy-arm',
      pos: pos({
        mint: 'mirror-legacy-arm',
        lane: 'leader_mirror',
        trailArmed: true,
        peakPriceUsd: 102,
        lastMarkPriceUsd: 102,
      }),
      markPriceUsd: 102 * 0.97,
      nowMs: 1_000,
      gates: gatesForDust,
      mirrorGates: {
        ...mirrorGates,
        leaderSellOnly: true,
        ownExitEnabled: true,
        ownExitTimeStopMs: 3_600_000,
        armPct: 5,
        trailPct: 3,
      },
    })!;
    expect(d.armed).toBe(false);
    expect(d.shouldExit).toBe(false);
    expect(d.reason).toBeNull();
  });

  it('prioritizes a full own trail over a same-tick ladder sale', () => {
    const d = decideMarkExit({
      mint: 'mirror-own-trail-ladder',
      pos: pos({
        mint: 'mirror-own-trail-ladder',
        lane: 'leader_mirror',
        trailArmed: true,
        peakPriceUsd: 120,
        lastMarkPriceUsd: 120,
      }),
      markPriceUsd: 120 * 0.97,
      nowMs: 200,
      gates: gatesForDust,
      mirrorGates: {
        ...mirrorGates,
        leaderSellOnly: true,
        ownExitEnabled: true,
        ownExitTimeStopMs: 3_600_000,
        armPct: 5,
        trailPct: 3,
      },
    })!;
    expect(d.shouldExit).toBe(true);
    expect(d.fraction).toBe(1);
    expect(d.reason).toBe('mirror_trail');
    expect(d.tpRungIndex).toBeNull();
  });

  it('uses the opt-in mirror time stop only before the trail arms', () => {
    const ownExit = {
      ...mirrorGates,
      leaderSellOnly: true,
      ownExitEnabled: true,
      ownExitTimeStopMs: 3_600_000,
      armPct: 5,
      trailPct: 3,
    };
    const unarmed = decideMarkExit({
      mint: 'mirror-time-stop',
      pos: pos({ mint: 'mirror-time-stop', lane: 'leader_mirror', openedAtMs: 0 }),
      markPriceUsd: 103,
      nowMs: 3_600_000,
      gates: gatesForDust,
      mirrorGates: ownExit,
    })!;
    expect(unarmed.shouldExit).toBe(true);
    expect(unarmed.fraction).toBe(1);
    expect(unarmed.reason).toBe('mirror_time_stop');

    const armed = decideMarkExit({
      mint: 'mirror-time-stop-armed',
      pos: pos({
        mint: 'mirror-time-stop-armed',
        lane: 'leader_mirror',
        openedAtMs: 0,
        peakPriceUsd: 105,
        trailArmed: true,
      }),
      markPriceUsd: 102,
      nowMs: 3_600_000,
      gates: gatesForDust,
      mirrorGates: ownExit,
    })!;
    expect(armed.shouldExit).toBe(false);
    expect(armed.reason).toBeNull();
  });

  it('makes a trail-disabled own exit time stop unconditional but not immediate', () => {
    const ownExit = {
      ...mirrorGates,
      leaderSellOnly: true,
      ownExitEnabled: true,
      ownExitTimeStopMs: 3_600_000,
      armPct: 5,
      trailPct: 0,
    };
    for (const [mint, markPriceUsd] of [
      ['mirror-time-stop-no-trail-up', 120],
      ['mirror-time-stop-no-trail-down', 80],
    ] as const) {
      const p = pos({
        mint,
        lane: 'leader_mirror',
        openedAtMs: 0,
        lastMarkPriceUsd: 100,
      });
      const beforeDeadline = decideMarkExit({
        mint,
        pos: p,
        markPriceUsd,
        nowMs: 100,
        gates: gatesForDust,
        mirrorGates: ownExit,
      })!;
      expect(beforeDeadline.armed).toBe(false);
      expect(beforeDeadline.shouldExit).toBe(false);
      const atDeadline = decideMarkExit({
        mint,
        pos: p,
        markPriceUsd,
        nowMs: 3_600_000,
        gates: gatesForDust,
        mirrorGates: ownExit,
      })!;
      expect(atDeadline.shouldExit).toBe(true);
      expect(atDeadline.fraction).toBe(1);
      expect(atDeadline.reason).toBe('mirror_time_stop');
    }
  });

  it('does not arm or exit on a single unconfirmed mark jump', () => {
    const ownExit = {
      ...mirrorGates,
      leaderSellOnly: true,
      ownExitEnabled: true,
      ownExitTimeStopMs: 3_600_000,
      armPct: 5,
      trailPct: 3,
    };
    const d = decideMarkExit({
      mint: 'mirror-phantom-up',
      pos: pos({
        mint: 'mirror-phantom-up',
        lane: 'leader_mirror',
        lastMarkPriceUsd: 100,
      }),
      markPriceUsd: 120,
      markSource: 'dex',
      gates: { ...gatesForDust, markJumpConfirmPct: 10 },
      mirrorGates: ownExit,
      nowMs: 100,
    })!;
    expect(d.armed).toBe(false);
    expect(d.shouldExit).toBe(false);
    expect(d.markQuarantined).toBe(true);

    const down = decideMarkExit({
      mint: 'mirror-phantom-down',
      pos: pos({
        mint: 'mirror-phantom-down',
        lane: 'leader_mirror',
        trailArmed: true,
        peakPriceUsd: 120,
        lastMarkPriceUsd: 120,
      }),
      markPriceUsd: 80,
      markSource: 'dex',
      gates: { ...gatesForDust, markJumpConfirmPct: 10 },
      mirrorGates: ownExit,
      nowMs: 100,
    })!;
    expect(down.armed).toBe(true);
    expect(down.shouldExit).toBe(false);
    expect(down.markQuarantined).toBe(true);
  });

  it('does not let breakeven_stop veto a leader-style exit decision', () => {
    const d = decideMarkExit({
      mint: 'lstyle-be',
      pos: pos({
        mint: 'lstyle-be',
        lane: 'leader_style',
        entryPriceUsd: 100,
        peakPriceUsd: 102,
        trailArmed: true,
        openedAtMs: 1_000_000,
      }),
      markPriceUsd: 100,
      gates: {
        ...gatesForDust,
        armPct: 1,
        givebackPct: 1,
        hardStopPnlPct: 50,
      },
      nowMs: 1_060_000,
      leaderStyleGates: {
        profitReboundPct: 25,
        pnlTpPct: 20,
        volFadeRatio: 0.35,
        depthDrainMax: 1.06,
        maxHoldMs: 14_400_000,
      },
    });
    expect(d?.reason).not.toBe('breakeven_stop');
  });

  it('keeps operational dust-close active for leader-style positions', () => {
    const d = decideMarkExit({
      mint: 'lstyle-dust',
      pos: pos({
        mint: 'lstyle-dust',
        lane: 'leader_style',
        sizeUsd: 1,
        scaleOutDone: true,
        openedAtMs: 1_000_000,
      }),
      markPriceUsd: 100,
      gates: { ...gatesForDust, dustCloseUsd: 2 },
      nowMs: 3_000_000,
      leaderStyleGates: {
        profitReboundPct: 25,
        pnlTpPct: 20,
        volFadeRatio: 0.35,
        depthDrainMax: 1.06,
        maxHoldMs: 14_400_000,
      },
    });
    expect(d?.reason).toBe('dust_close');
    expect(d?.fraction).toBe(1);
  });

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
      // Nothing to bank: the gain basis is the mark, so a motionless price is 0%.
      expect(d?.gainPct).toBeCloseTo(0, 6);
      // The loss basis is the fill here, which reads the gap as a paper gain -
      // harmless, because no floor fires on a positive number (1.11.878).
      expect(d?.pnlPct).toBeCloseTo(10.52, 1);
      expect(d?.pnlPctVsFill).toBeCloseTo(10.52, 1);
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
      expect(first.entryMarketPriceUsd).toBeCloseTo(STALE_MARK, 12);

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

    it('does not read an entry overpay as a loss on a motionless price', () => {
      // We paid 3% over the mark. The price then does not move at all; the loss
      // floors used to see −3% and could fire on it (never_arm_time_red), and
      // breakeven_stop only needed a 2% tick to call it a peak worth banking.
      const MARK = FILL * 0.97;
      const p = fresh('eub3', FILL, MARK);
      const d = decideMarkExit({
        mint: 'eub3',
        pos: p,
        markPriceUsd: MARK,
        gates: bankGates,
        nowMs: 1_040_000,
      })!;
      applyMarkDecisionToPosition(p, d);
      expect(d.entryMarketPriceUsd).toBeCloseTo(MARK, 12);
      expect(d.mfePct).toBeCloseTo(0, 6);
      expect(d.pnlPct).toBeCloseTo(0, 6);
      expect(d.pnlPctVsFill).toBeCloseTo(-3, 1);
      expect(d.shouldExit).toBe(false);
    });

    it('does not bank a 2% tick after an overpay as breakeven profit', () => {
      const MARK = FILL * 0.97;
      const beGates = { ...bankGates, breakevenArmPct: 2, breakevenFloorPct: 0 };
      const p = fresh('eub3b', FILL, MARK);
      const d = decideMarkExit({
        mint: 'eub3b',
        pos: p,
        markPriceUsd: MARK * 1.02,
        gates: beGates,
        nowMs: 1_040_000,
      })!;
      // On the money basis a 2% tick after a 3% overpay is not a gain at all,
      // so there is no peak to arm the breakeven against.
      expect(d.mfePct).toBeCloseTo(0, 6);
      expect(d.gainPct).toBeCloseTo(-1.06, 1);
      // And on the loss basis the price genuinely rose 2%, so nothing cuts.
      expect(d.pnlPct).toBeCloseTo(2, 1);
      expect(d.shouldExit).toBe(false);
    });

    it('ignores an entry mark that is nowhere near the fill', () => {
      // 7rMnp9 carried 9.87e-06 against a 1.646e-03 fill: MFE read 17821%,
      // which walks every ladder rung in one tick and empties the bag.
      const p = fresh('7rmnp9', 1.645989403945407e-3, 9.87e-6);
      const d = decideMarkExit({
        mint: '7rmnp9',
        pos: p,
        markPriceUsd: 1.7481963175183285e-3,
        gates: { ...bankGates, tpGridStepPct: 8, tpGridSellFraction: 0.5 },
        nowMs: 1_040_000,
      })!;
      expect(d.entryMarketPriceUsd).toBeNull();
      expect(d.mfePct).toBeLessThan(20);
      expect(d.pnlPct).toBeCloseTo(6.21, 1);
    });

    it('does not bank a gain the fill never had (5nZMRL, 1.11.878)', () => {
      // wait_dip: the ring recorded the trough the seat waited for (2.1971e-04)
      // and Jupiter filled us 8.2% above it (2.3773e-04). On the mark basis MFE
      // opened at +8.2%, the +8% rung fired at once and sold at -1.59%.
      const FILL_WD = 2.3773371159100862e-4;
      const RING_TROUGH = 2.1971e-4;
      const p = fresh('5nzmrl', FILL_WD, RING_TROUGH);
      const d = decideMarkExit({
        mint: '5nzmrl',
        pos: p,
        markPriceUsd: 2.419e-4,
        gates: { ...bankGates, tpGridStepPct: 8, tpGridSellFraction: 0.5, armPct: 5 },
        nowMs: 1_040_000,
      })!;
      // Peak over fill is +1.75%, and that is all the money there is.
      expect(d.gainPct).toBeCloseTo(1.75, 1);
      expect(d.mfePct).toBeCloseTo(1.75, 1);
      expect(d.shouldExit).toBe(false);
    });

    it('the chase gap is still not a loss (1.11.878)', () => {
      // Same bag, price back at the ring trough: our money is -8.2% but the mark
      // series has not fallen at all, so no floor may fire on it.
      const FILL_WD = 2.3773371159100862e-4;
      const RING_TROUGH = 2.1971e-4;
      const p = fresh('5nzmrl2', FILL_WD, RING_TROUGH);
      const d = decideMarkExit({
        mint: '5nzmrl2',
        pos: p,
        markPriceUsd: RING_TROUGH,
        gates: { ...bankGates, hardStopPnlPct: 8 },
        nowMs: 1_040_000,
      })!;
      expect(d.pnlPct).toBeCloseTo(0, 6);
      expect(d.pnlPctVsFill).toBeCloseTo(-7.58, 1);
      expect(d.shouldExit).toBe(false);
    });

    it('the bounce floor will not sell below our fill (7ZgRjHSn, 1.11.881)', () => {
      // Filled 7.0630e-05 with the mark at 6.9050e-05. A min-pnl floor of 0 on
      // the loss basis cleared at 6.9050e-05 - which is -2.24% of our money -
      // and the half went out at -2.38%.
      const FILL_B = 7.062982e-5;
      const MARK_B = 6.905e-5;
      const bounceGates = {
        ...gates,
        neverArmBounceMinDumpPct: 8,
        neverArmBouncePct: 8,
        neverArmBouncePartialFraction: 0.5,
        neverArmBounceMinPnlPct: 0,
        neverArmBounceRequireRedPct: 0,
        neverArmBounceMinTroughAgeMs: 0,
      };
      const p = fresh('7zgrjh', FILL_B, MARK_B);
      // Dumped well below, then reclaimed to just above the entry mark.
      p.postEntryTroughUsd = MARK_B * 0.85;
      p.postEntryTroughAtMs = 1_000_000;
      const d = decideMarkExit({
        mint: '7zgrjh',
        pos: p,
        markPriceUsd: MARK_B,
        gates: bounceGates,
        nowMs: 1_700_000,
      })!;
      expect(d.gainPct).toBeCloseTo(-2.24, 1);
      expect(d.shouldExit).toBe(false);

      // At our fill it may take the half.
      const ok = decideMarkExit({
        mint: '7zgrjh',
        pos: p,
        markPriceUsd: FILL_B,
        gates: bounceGates,
        nowMs: 1_700_000,
      })!;
      expect(ok.gainPct).toBeCloseTo(0, 6);
      expect(ok.shouldExit).toBe(true);
      expect(ok.reason).toBe('never_arm_bounce');
    });

    it('a money threshold clears on a price we can actually get (1.11.882)', () => {
      // The fill lands a median 0.99% below the deciding mark over 2009 sells,
      // so the gain takes that haircut: an 8% rung needs 9% on the mark.
      const hair = { ...bankGates, tpGridStepPct: 8, tpGridSellFraction: 0.5, markSellHaircutPct: 1 };
      const p = fresh('haircut', 100, 100);
      const justUnder = decideMarkExit({
        mint: 'haircut',
        pos: p,
        markPriceUsd: 108,
        gates: hair,
        nowMs: 1_040_000,
      })!;
      expect(justUnder.gainPct).toBeCloseTo(6.92, 1);
      expect(justUnder.shouldExit).toBe(false);

      const over = decideMarkExit({
        mint: 'haircut',
        pos: p,
        markPriceUsd: 109.1,
        gates: hair,
        nowMs: 1_040_000,
      })!;
      expect(over.gainPct).toBeGreaterThanOrEqual(8);
      expect(over.shouldExit).toBe(true);
      expect(over.reason).toBe('tp_grid');
    });

    it('the haircut never reaches the loss floors (1.11.882)', () => {
      // Taking a percent off the stop would invent it.
      const hair = { ...bankGates, hardStopPnlPct: 25, markSellHaircutPct: 1 };
      const p = fresh('haircut2', 100, 100);
      const d = decideMarkExit({
        mint: 'haircut2',
        pos: p,
        markPriceUsd: 75.5,
        gates: hair,
        nowMs: 1_040_000,
      })!;
      expect(d.pnlPct).toBeCloseTo(-24.5, 1);
      expect(d.shouldExit).toBe(false);
    });

    it('an identical re-read does not confirm a jump (DKxHTQCv, 1.11.889)', () => {
      // Sat at 3.8570e-04 for minutes, then two stream prints of 5.3768721e-04
      // two seconds apart, identical to the last digit. The second confirmed the
      // first, MFE latched at +35.83% and breakeven closed the bag at +2.28%
      // while the name ran. Real prices tick; a repeat is one cached datum twice.
      const STEADY = 3.857e-4;
      const SPIKE = 5.3768721e-4;
      const g = { ...gates, markJumpConfirmPct: 10, markJumpConfirmStreamPct: 8 };
      const p = fresh('dkxh', STEADY, STEADY);
      const steady = decideMarkExit({
        mint: 'dkxh', pos: p, markPriceUsd: STEADY, gates: g, nowMs: 1_010_000, markSource: 'dex',
      })!;
      applyMarkDecisionToPosition(p, steady);

      const first = decideMarkExit({
        mint: 'dkxh', pos: p, markPriceUsd: SPIKE, gates: g, nowMs: 1_012_000, markSource: 'stream',
      })!;
      expect(first.markQuarantined).toBe(true);
      applyMarkDecisionToPosition(p, first);

      const reread = decideMarkExit({
        mint: 'dkxh', pos: p, markPriceUsd: SPIKE, gates: g, nowMs: 1_014_000, markSource: 'stream',
      })!;
      expect(reread.markQuarantined).toBe(true);
      applyMarkDecisionToPosition(p, reread);
      // The peak never moved, so nothing armed and nothing latched.
      expect(p.peakPriceUsd).toBeCloseTo(STEADY, 12);
      expect(p.trailArmed).not.toBe(true);
    });

    it('a genuine move still confirms, from either feed', () => {
      const g = { ...gates, markJumpConfirmPct: 10, markJumpConfirmStreamPct: 8, armPct: 5 };
      const p = fresh('realmove', 100, 100);
      applyMarkDecisionToPosition(
        p,
        decideMarkExit({ mint: 'realmove', pos: p, markPriceUsd: 100, gates: g, nowMs: 1_010_000, markSource: 'dex' })!,
      );
      const jump = decideMarkExit({
        mint: 'realmove', pos: p, markPriceUsd: 130, gates: g, nowMs: 1_012_000, markSource: 'stream',
      })!;
      expect(jump.markQuarantined).toBe(true);
      applyMarkDecisionToPosition(p, jump);
      // A different feed at a nearby price is an independent observation.
      const confirm = decideMarkExit({
        mint: 'realmove', pos: p, markPriceUsd: 129, gates: g, nowMs: 1_014_000, markSource: 'dex',
      })!;
      expect(confirm.markQuarantined).not.toBe(true);
      expect(confirm.gainPct).toBeCloseTo(29, 0);
    });

    it('still stops out on a real 25% fall measured from the entry mark', () => {
      const MARK = FILL * 0.97;
      const p = fresh('eub3c', FILL, MARK);
      const d = decideMarkExit({
        mint: 'eub3c',
        pos: p,
        markPriceUsd: MARK * 0.74,
        gates: { ...bankGates, hardStopPnlPct: 25 },
        nowMs: 1_040_000,
      })!;
      expect(d.shouldExit).toBe(true);
      expect(d.reason).toBe('hard_stop');
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

    it('stands down on the rung that would leave under 20% (1.11.914)', () => {
      // Half-remainder steps: 1.00 -> 0.50 -> 0.25, and the next would be
      // 0.125, under the 0.20 floor. The ladder stops there and the trail
      // carries the last quarter, so a runner is not capped at the third rung.
      const g = { ...grid, tpGridMinRemainderFraction: 0.2 };
      const r1 = decideMarkExit({ mint: 'f1', pos: bag('f1', 0), markPriceUsd: 108, gates: g, nowMs: 1_060_000 });
      expect(r1?.fraction).toBe(0.5);
      const r2 = decideMarkExit({ mint: 'f2', pos: bag('f2', 1), markPriceUsd: 116, gates: g, nowMs: 1_060_000 });
      expect(r2?.fraction).toBe(0.5);
      const r3 = decideMarkExit({ mint: 'f3', pos: bag('f3', 2), markPriceUsd: 124, gates: g, nowMs: 1_060_000 });
      expect(r3?.reason).not.toBe('tp_grid');
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
      expect(sixth?.reason).not.toBe('tp_grid');
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

    it('settles two owed rungs in one sell when price gaps to +16%', () => {
      const d = at(bag('g_gap'), 116);
      expect(d?.reason).toBe('tp_grid');
      expect(d?.fraction).toBeCloseTo(1 - 0.5 ** 2, 6);
      expect(d?.tpRungIndex).toBe(2);
    });

    it('clamps a multi-rung catch-up to the floor', () => {
      const g = { ...grid, tpGridSellFraction: 0.34, tpGridMinRemainderFraction: 0.3 };
      const d = decideMarkExit({
        mint: 'g_floor_gap',
        pos: bag('g_floor_gap', 0),
        markPriceUsd: 132,
        gates: g,
        nowMs: 1_060_000,
      });
      expect(d?.reason).toBe('tp_grid');
      expect(d?.fraction).toBeCloseTo(1 - 0.66 ** 2, 6);
      expect(d?.tpRungIndex).toBe(2);
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
      expect(d?.bounceOffTroughPct).toBeCloseTo(18.42, 1);
      expect(d?.troughAgeMs).toBe(130_000);
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

  describe('a green bag refuses an unbacked stream print (own2 8np28cju)', () => {
    // Entry 0.00021854, peak 0.00022356, then a single stream tick at
    // 0.00017138 (-20.33%) fired green_trail while the fill came back at
    // 0.00021903 (+0.22%): the price never existed.
    const gGreen = { ...gates, markJumpConfirmPct: 10, markJumpConfirmStreamPct: 8 };
    const greenGates = {
      takeProfitPct: 30,
      stopPct: 6,
      maxHoldMs: 600_000,
      trailEnabled: true,
      armPct: 2,
      trailPct: 10,
    };
    const bag = (): MildDipOpenPosition =>
      pos({
        mint: 'green-phantom',
        lane: 'green',
        entryPriceUsd: 0.00021854,
        peakPriceUsd: 0.00022356,
        lastMarkPriceUsd: 0.00022356,
        trailArmed: true,
        openedAtMs: 1_000_000,
      });
    const at = (p: MildDipOpenPosition, px: number, nowMs: number) =>
      decideMarkExit({
        mint: p.mint,
        pos: p,
        markPriceUsd: px,
        gates: gGreen,
        greenGates,
        nowMs,
        markSource: 'stream',
        dexCrossCheckPx: null,
      })!;

    it('parks the phantom print instead of trailing out on it', () => {
      const p = bag();
      const phantom = at(p, 0.00017138, 1_010_000);
      expect(phantom.shouldExit).not.toBe(true);
      expect(phantom.markQuarantined).toBe(true);
      expect(phantom.peakPriceUsd).toBe(0.00022356);
      applyMarkDecisionToPosition(p, phantom);

      const real = at(p, 0.00021903, 1_011_000);
      expect(real.markQuarantined).not.toBe(true);
      expect(real.markDiscardStreamOutlier).not.toBe(true);
      expect(real.shouldExit).not.toBe(true);
    });
  });

  describe('bounded green quarantine blindness (1.11.959)', () => {
    const g = {
      ...gates,
      markJumpConfirmPct: 10,
      markJumpConfirmStreamPct: 8,
      markQuarantineGreenMaxMs: 10_000,
      mfeBankEnabled: false,
      partialGivebackPct: 0,
      givebackPct: 25,
      hardStopPnlPct: 0,
    };

    function armedGreen(): MildDipOpenPosition {
      return pos({
        mint: 'quarantine-green',
        entryPriceUsd: 100,
        peakPriceUsd: 130,
        trailArmed: true,
        lastMarkPriceUsd: 130,
        openedAtMs: 1_000_000,
      });
    }

    function quarantine(
      p: MildDipOpenPosition,
      nowMs: number,
      price = 118,
      gatesOverride = g,
      dexCrossCheckPx: number | null = null,
    ) {
      return decideMarkExit({
        mint: p.mint,
        pos: p,
        markPriceUsd: price,
        gates: gatesOverride,
        markQuarantineGreenMaxMs: gatesOverride.markQuarantineGreenMaxMs,
        nowMs,
        markSource: 'stream',
        dexCrossCheckPx,
      })!;
    }

    it('accepts an armed green mark after the configured blind window', () => {
      const p = armedGreen();
      const first = quarantine(p, 1_010_000);
      expect(first.markQuarantined).toBe(true);
      applyMarkDecisionToPosition(p, first);
      expect(p.markQuarantineSinceMs).toBe(1_010_000);

      const released = quarantine(p, 1_021_000);
      expect(released.markQuarantined).not.toBe(true);
      expect(released.markQuarantineForceReleased).toBe(true);
      expect(released.markQuarantineBlindMs).toBe(11_000);
      expect(released.pnlPct).toBeCloseTo(18, 6);
    });

    it('vetoes force-release when the live Dex contradicts the stream', () => {
      const p = armedGreen();
      const first = quarantine(p, 1_010_000, 118, g, 100);
      expect(first.markQuarantined).toBe(true);
      applyMarkDecisionToPosition(p, first);

      const vetoed = quarantine(p, 1_021_000, 118, g, 100);
      expect(vetoed.markQuarantineForceReleased).not.toBe(true);
      expect(vetoed.markQuarantineForceReleaseVetoedByDex).toBe(true);
      expect(vetoed.markQuarantined).toBe(true);
      expect(vetoed.peakPriceUsd).toBe(130);

      const silentDex = armedGreen();
      const silentFirst = quarantine(silentDex, 1_010_000, 118);
      applyMarkDecisionToPosition(silentDex, silentFirst);
      const released = quarantine(silentDex, 1_021_000, 118);
      expect(released.markQuarantineForceReleased).toBe(true);
    });

    it('keeps the blind clock running across changing quarantined prices', () => {
      const p = armedGreen();
      for (const [nowMs, price] of [
        [1_010_000, 118],
        [1_013_000, 110],
        [1_016_000, 104],
      ] as const) {
        const d = quarantine(p, nowMs, price);
        expect(d.markQuarantined).toBe(true);
        applyMarkDecisionToPosition(p, d);
      }

      const released = quarantine(p, 1_021_000, 101);
      expect(released.markQuarantineForceReleased).toBe(true);
      expect(released.markQuarantineBlindMs).toBe(11_000);
      expect(released.markQuarantined).not.toBe(true);
    });

    it('gives a new quarantined value its own confirmation window', () => {
      const p = armedGreen();
      const first = quarantine(p, 1_000_000, 118);
      applyMarkDecisionToPosition(p, first);
      p.markQuarantineSinceMs = 1_000_000;
      p.pendingMarkAtMs = 1_000_000;

      const off = { ...g, markQuarantineGreenMaxMs: 0 };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_020_000);
      try {
        const newValue = quarantine(p, 1_020_000, 110, off);
        expect(newValue.markQuarantined).toBe(true);
        applyMarkDecisionToPosition(p, newValue);
        expect(p.pendingMarkAtMs).toBe(1_020_000);

        const reread = quarantine(p, 1_021_000, 110, off);
        expect(reread.markQuarantined).toBe(true);
        expect(reread.markDiscardStreamOutlier).not.toBe(true);
      } finally {
        clock.mockRestore();
      }
    });

    it('still refuses red and never-armed marks', () => {
      const red = armedGreen();
      const firstRed = quarantine(red, 1_010_000, 90);
      applyMarkDecisionToPosition(red, firstRed);
      const redLater = quarantine(red, 1_021_000, 90);
      expect(redLater.markQuarantined === true || redLater.markDiscardStreamOutlier === true).toBe(
        true,
      );
      expect(redLater.markQuarantineForceReleased).not.toBe(true);

      const unarmed = pos({
        mint: 'quarantine-unarmed',
        entryPriceUsd: 100,
        peakPriceUsd: 130,
        trailArmed: false,
        lastMarkPriceUsd: 130,
        openedAtMs: 1_000_000,
      });
      const firstUnarmed = quarantine(unarmed, 1_010_000, 118);
      applyMarkDecisionToPosition(unarmed, firstUnarmed);
      const unarmedLater = quarantine(unarmed, 1_021_000, 118);
      expect(
        unarmedLater.markQuarantined === true ||
          unarmedLater.markDiscardStreamOutlier === true,
      ).toBe(true);
      expect(unarmedLater.markQuarantineForceReleased).not.toBe(true);
    });

    it('keeps the current refusal behavior when the threshold is zero', () => {
      const p = armedGreen();
      const off = { ...g, markQuarantineGreenMaxMs: 0 };
      const first = quarantine(p, 1_010_000, 118, off);
      applyMarkDecisionToPosition(p, first);
      const later = quarantine(p, 1_021_000, 118, off);
      expect(later.markQuarantined === true || later.markDiscardStreamOutlier === true).toBe(
        true,
      );
      expect(later.markQuarantineForceReleased).not.toBe(true);
    });

    it('resets the quarantine counter after an accepted mark', () => {
      const p = armedGreen();
      const first = quarantine(p, 1_010_000);
      applyMarkDecisionToPosition(p, first);
      const confirmed = decideMarkExit({
        mint: p.mint,
        pos: p,
        markPriceUsd: 117,
        gates: g,
        nowMs: 1_012_000,
        markSource: 'dex',
      })!;
      expect(confirmed.markQuarantined).not.toBe(true);
      applyMarkDecisionToPosition(p, confirmed);
      expect(p.markQuarantineSinceMs).toBeUndefined();

      const next = quarantine(p, 1_020_000, 105);
      expect(next.markQuarantined).toBe(true);
      applyMarkDecisionToPosition(p, next);
      expect(p.markQuarantineSinceMs).toBe(1_020_000);
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

    it('holds a stream print to a tighter guard than a Dex one (1.11.868)', () => {
      // CX2v7JSH: a single stream print +23.56% above the previous mark cleared
      // the 25% guard, armed the trail and fired a ladder rung on a coin that
      // had not moved. Of stream prints jumping 5-10% in one tick, 46.1%
      // reverted on the next mark.
      const g = { ...gates, markJumpConfirmPct: 25, markJumpConfirmStreamPct: 8 };
      const p = pos({
        mint: 'src',
        entryPriceUsd: 100,
        peakPriceUsd: 100,
        openedAtMs: 1_000_000,
      });
      const seed = decideMarkExit({
        mint: 'src',
        pos: p,
        markPriceUsd: 100,
        gates: g,
        nowMs: 1_010_000,
        markSource: 'dex',
      })!;
      applyMarkDecisionToPosition(p, seed);

      const viaStream = decideMarkExit({
        mint: 'src',
        pos: p,
        markPriceUsd: 123.56,
        gates: g,
        nowMs: 1_020_000,
        markSource: 'stream',
      })!;
      expect(viaStream.markQuarantined).toBe(true);
      expect(viaStream.mfePct).toBe(0);

      // The very same number off the Dex feed is inside its 25% guard.
      const viaDex = decideMarkExit({
        mint: 'src',
        pos: p,
        markPriceUsd: 123.56,
        gates: g,
        nowMs: 1_020_000,
        markSource: 'dex',
      })!;
      expect(viaDex.markQuarantined).toBeFalsy();
    });

    it('a modest stream move still passes', () => {
      const g = { ...gates, markJumpConfirmPct: 25, markJumpConfirmStreamPct: 8 };
      const p = pos({ mint: 'src2', entryPriceUsd: 100, peakPriceUsd: 100, openedAtMs: 1_000_000 });
      applyMarkDecisionToPosition(
        p,
        decideMarkExit({ mint: 'src2', pos: p, markPriceUsd: 100, gates: g, nowMs: 1_010_000, markSource: 'dex' })!,
      );
      const d = decideMarkExit({
        mint: 'src2',
        pos: p,
        markPriceUsd: 106,
        gates: g,
        nowMs: 1_020_000,
        markSource: 'stream',
      })!;
      expect(d.markQuarantined).toBeFalsy();
    });

    it('armed trail uses Dex when stream jumps down below Dex (Dmkj4d)', () => {
      const PEAK = 0.000429;
      const DEX = 0.000388;
      const STREAM = 0.000357;
      const g = {
        ...gates,
        markJumpConfirmStreamPct: 8,
        mfeBank1Pct: 0,
        tpGridStepPct: 0,
        mfeBankSleeveGivebackPct: 8,
        partialGivebackPct: 0,
        givebackPct: 8,
        armPct: 5,
      };
      const p = {
        ...pos({
          mint: 'dmkj',
          entryPriceUsd: 0.000148,
          peakPriceUsd: PEAK,
          trailArmed: true,
          openedAtMs: 1_000_000,
        }),
        lastMarkPriceUsd: PEAK,
      };
      const d = decideMarkExit({
        mint: 'dmkj',
        pos: p,
        markPriceUsd: STREAM,
        gates: g,
        nowMs: 1_800_000,
        markSource: 'stream',
        dexCrossCheckPx: DEX,
      })!;
      expect(d.markQuarantined).toBeFalsy();
      expect(d.shouldExit).toBe(true);
      expect(d.markPriceUsd).toBeCloseTo(DEX, 10);
      expect(['mfe_bank_sleeve', 'peak_giveback']).toContain(d.reason);
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

  describe('MFE is never negative (1.11.869)', () => {
    // A wait_dip seat parks on a signal and fills ~15% below it. Feeding that
    // signal in as the movement basis opened bags at MFE −11%, so they could
    // neither arm nor reach a rung until price climbed all the way back —
    // AENK1YJ9 and Ggec8Zysy both sat for minutes doing nothing.
    const g = { ...gates, mfeBank1Pct: 0, tpGridStepPct: 8, partialGivebackPct: 0, armPct: 5 };
    const bag = (): MildDipOpenPosition => ({
      ...pos({
        mint: 'wd',
        entryPriceUsd: 6.4317e-5,
        peakPriceUsd: 6.4317e-5,
        openedAtMs: 1_000_000,
      }),
      // Twenty-minute-old signal, 11.6% above the fill.
      entryMarkPriceUsd: 7.18e-5,
    });

    it('reads zero, not −11%, when the basis sits above the peak', () => {
      const d = decideMarkExit({
        mint: 'wd',
        pos: bag(),
        markPriceUsd: 6.229e-5,
        gates: g,
        nowMs: 1_060_000,
      });
      expect(d?.mfePct).toBe(0);
    });

    it('a real gain still counts from the higher basis', () => {
      const d = decideMarkExit({
        mint: 'wd',
        pos: bag(),
        markPriceUsd: 7.18e-5 * 1.09,
        gates: g,
        nowMs: 1_060_000,
      });
      expect(d?.mfePct).toBeCloseTo(9, 1);
      expect(d?.reason).toBe('tp_grid');
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


describe('1.11.910 dead-set exit: three factors, then a bounce', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const src = readFileSync(resolve('src/milddip/gates.ts'), 'utf8');

  it('needs volume, turnover and price all gone before it condemns a bag', () => {
    expect(src).toContain('const volGone = v != null && v0 != null && v0 > 0 && v <= v0 * dsVol');
    expect(src).toContain('const turnGone = t != null && t0 != null && t0 > 0 && t <= t0 * dsTurn');
    expect(src).toContain('const priceGone = gainPct <= -gates.deadSetMinDropPct');
    expect(src).toContain('volGone && turnGone && priceGone');
  });

  it('sells only after the price lifts off its own low', () => {
    // Not on the red candle: a whale emptying a position takes the price through
    // any fixed level and it comes back without us.
    expect(src).toContain('bounceOffTroughPct >= dsBounce - 1e-9');
    // 1.11.995 — the measured dead-set branch is disabled; the gate code
    // remains covered independently above.
    expect(eco).toContain("MILD_DIP_EXIT_DEAD_SET_BOUNCE_PCT: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_DEAD_SET_MIN_DROP_PCT: '15'");
  });

  it('live env configures a green sleeve partial runner', () => {
    expect(eco).toContain(
      "MILD_DIP_EXIT_MFE_BANK_SLEEVE_GREEN_PARTIAL_FRACTION: '0.5'",
    );
  });

  it('live env runs it at a quarter of entry volume and turnover', () => {
    expect(eco).toContain("MILD_DIP_EXIT_DEAD_SET_VOL_FADE_FRAC: '0.25'");
    expect(eco).toContain("MILD_DIP_EXIT_DEAD_SET_TURN_FADE_FRAC: '0.25'");
    expect(eco).toContain("MILD_DIP_EXIT_DEAD_SET_MIN_HOLD_MS: '900000'");
  });

  it('states the floor where the bounce gate actually fills it (1.11.936)', () => {
    // 1.11.956 — hard_stop is disabled in production; the reclaim-gated
    // dead-set / soft-loss rules remain the configured backstops.
    expect(eco).toContain("MILD_DIP_EXIT_HARD_STOP_PNL_PCT: '0'");
  });
});

describe('1.11.969 liquidity-drain exit', () => {
  const drainGates = {
    ...gatesForDust,
    liqDrainRatio: 0.7,
    liqDrainMinAgeMs: 600_000,
    liqDrainConfirmTicks: 2,
    liqDrainSkipArmedRunner: true,
    liqAbsFloorUsd: 0,
    hardStopPnlPct: 0,
    cliffDumpPnlPct: 0,
    neverArmStaleMinMs: 0,
  };

  function drainPos(extra: Partial<MildDipOpenPosition> = {}) {
    return pos({
      mint: 'drain',
      entryPriceUsd: 100,
      openedAtMs: 1_000_000,
      peakPriceUsd: 100,
      entryLiquidityUsd: 100_000,
      ...extra,
    });
  }

  it('requires two distinct liquidity samples and exits the full position', () => {
    const first = decideMarkExit({
      mint: 'drain',
      pos: drainPos(),
      markPriceUsd: 80,
      gates: drainGates,
      nowMs: 1_700_000,
      liquidityUsd: 50_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_600_000,
    });
    expect(first?.shouldExit).toBe(false);
    expect(first?.liquidityDrainConfirmTicks).toBe(1);

    const p = drainPos({
      liquidityDrainConfirmTicks: first?.liquidityDrainConfirmTicks,
      liquidityDrainSampleTsMs: first?.liquidityDrainSampleTsMs,
    });
    const second = decideMarkExit({
      mint: 'drain',
      pos: p,
      markPriceUsd: 80,
      gates: drainGates,
      nowMs: 1_710_000,
      liquidityUsd: 50_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_610_000,
    });
    expect(second?.reason).toBe('liq_drain');
    expect(second?.fraction).toBe(1);
  });

  it('does not count the same liquidity sample twice', () => {
    const first = decideMarkExit({
      mint: 'same-sample',
      pos: drainPos({ mint: 'same-sample' }),
      markPriceUsd: 80,
      gates: drainGates,
      nowMs: 1_700_000,
      liquidityUsd: 50_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_600_000,
    });
    const repeated = decideMarkExit({
      mint: 'same-sample',
      pos: drainPos({
        mint: 'same-sample',
        liquidityDrainConfirmTicks: first?.liquidityDrainConfirmTicks,
        liquidityDrainSampleTsMs: first?.liquidityDrainSampleTsMs,
      }),
      markPriceUsd: 80,
      gates: drainGates,
      nowMs: 1_710_000,
      liquidityUsd: 50_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_600_000,
    });
    expect(repeated?.reason).not.toBe('liq_drain');
    expect(repeated?.liquidityDrainConfirmTicks).toBe(1);
  });

  it('resets confirmation when the ratio recovers, blocks young/stale/missing data, and skips armed profit', () => {
    const base = drainPos({ liquidityDrainConfirmTicks: 1, liquidityDrainSampleTsMs: 1_600_000 });
    const recovered = decideMarkExit({
      mint: 'drain',
      pos: base,
      markPriceUsd: 80,
      gates: drainGates,
      nowMs: 1_700_000,
      liquidityUsd: 90_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_610_000,
    });
    expect(recovered?.liquidityDrainConfirmTicks).toBe(0);
    const afterReset = decideMarkExit({
      mint: 'drain',
      pos: drainPos({
        liquidityDrainConfirmTicks: recovered?.liquidityDrainConfirmTicks,
        liquidityDrainSampleTsMs: recovered?.liquidityDrainSampleTsMs,
      }),
      markPriceUsd: 80,
      gates: drainGates,
      nowMs: 1_710_000,
      liquidityUsd: 50_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_620_000,
    });
    expect(afterReset?.shouldExit).toBe(false);
    expect(afterReset?.liquidityDrainConfirmTicks).toBe(1);

    for (const args of [
      {
        nowMs: 1_500_000,
        liquidityUsd: 50_000,
        liquidityMetricsFresh: true,
        liquidityMetricsTsMs: 1_610_000,
      },
      {
        nowMs: 1_700_000,
        liquidityUsd: 50_000,
        liquidityMetricsFresh: false,
        liquidityMetricsTsMs: 1_610_000,
      },
      { nowMs: 1_700_000, liquidityUsd: null, liquidityMetricsFresh: false, liquidityMetricsTsMs: null },
      {
        nowMs: 1_700_000,
        liquidityUsd: 50_000,
        liquidityMetricsFresh: true,
        liquidityMetricsTsMs: null,
        entryLiquidityUsd: 0,
      },
    ]) {
      const d = decideMarkExit({
        mint: 'drain',
        pos: drainPos({ trailArmed: true, entryLiquidityUsd: args.entryLiquidityUsd ?? 100_000 }),
        markPriceUsd: 80,
        gates: drainGates,
        ...args,
      });
      expect(d?.reason).not.toBe('liq_drain');
    }

    const runner = decideMarkExit({
      mint: 'drain',
      pos: drainPos({ trailArmed: true }),
      markPriceUsd: 110,
      gates: drainGates,
      nowMs: 1_700_000,
      liquidityUsd: 50_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_610_000,
    });
    expect(runner?.reason).not.toBe('liq_drain');
  });

  it('supports the optional absolute liquidity floor and keeps it disabled at zero', () => {
    const floorGates = { ...drainGates, liqDrainRatio: 0, liqAbsFloorUsd: 40_000 };
    const first = decideMarkExit({
      mint: 'floor',
      pos: drainPos({ mint: 'floor' }),
      markPriceUsd: 95,
      gates: floorGates,
      nowMs: 1_700_000,
      liquidityUsd: 30_000,
      liquidityMetricsFresh: true,
    });
    const second = decideMarkExit({
      mint: 'floor',
      pos: drainPos({
        mint: 'floor',
        liquidityDrainConfirmTicks: 1,
        liquidityDrainSampleTsMs: 1_600_000,
      }),
      markPriceUsd: 95,
      gates: floorGates,
      nowMs: 1_710_000,
      liquidityUsd: 30_000,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_610_000,
    });
    expect(first?.reason).not.toBe('liq_drain');
    expect(second?.reason).toBe('liq_drain');
    expect(second?.fraction).toBe(1);

    const disabled = decideMarkExit({
      mint: 'floor-off',
      pos: drainPos({ mint: 'floor-off' }),
      markPriceUsd: 80,
      gates: { ...drainGates, liqDrainRatio: 0, liqAbsFloorUsd: 0 },
      nowMs: 1_700_000,
      liquidityUsd: 1,
      liquidityMetricsFresh: true,
      liquidityMetricsTsMs: 1_600_000,
    });
    expect(disabled?.reason).not.toBe('liq_drain');
  });
});
