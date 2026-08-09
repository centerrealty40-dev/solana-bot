import { describe, expect, it } from 'vitest';
import {
  applyMarkDecisionToPosition,
  decideMarkExit,
  orderMintsForMark,
} from '../../src/milddip/exit-engine.js';
import type { MildDipExitGates } from '../../src/milddip/gates.js';
import type { MildDipOpenPosition } from '../../src/milddip/state.js';

const gates: MildDipExitGates = {
  armPct: 5,
  partialGivebackPct: 3,
  scaleOutFraction: 0.5,
  givebackPct: 8,
  mfeBankEnabled: true,
  mfeBank1Pct: 8,
  mfeBank1Fraction: 0.4,
  mfeBank2Pct: 15,
  mfeBank2Fraction: 0.4,
  mfeBankSleeveGivebackPct: 12,
  neverArmPatienceMs: 0,
  neverArmMaxHoldMs: 0,
  hardMaxHoldMs: 0,
  neverArmDeadMinMs: 0,
  neverArmDeadPnlPct: 10,
  neverArmStaleMinMs: 0,
  neverArmStaleMaxMfePct: 2,
  neverArmStalePnlPct: 5,
  neverArmVolFadeMinMs: 0,
  neverArmVolFadeRatio: 0.25,
  neverArmVolFadeFloorUsd: 300,
  neverArmVolFadeSampleMs: 300_000,
  neverArmVolFadeWeakWindows: 3,
  cliffDumpPnlPct: 50,
  neverArmBounceMinDumpPct: 8,
  neverArmBouncePct: 8,
  neverArmBounceMinTroughAgeMs: 60_000,
  neverArmBounceRequireRedPct: 3,
  neverArmFreefallPnlPct: 0,
  neverArmFreefallMinMs: 0,
  neverArmTimeRedMinMs: 900_000,
  neverArmTimeRedPnlPct: 5,
};

function pos(partial: Partial<MildDipOpenPosition> & { mint: string }): MildDipOpenPosition {
  return {
    mint: partial.mint,
    symbol: partial.symbol ?? partial.mint.slice(0, 6),
    entryPriceUsd: partial.entryPriceUsd ?? 100,
    sizeUsd: partial.sizeUsd ?? 5,
    tokenRaw: partial.tokenRaw ?? null,
    openedAtMs: partial.openedAtMs ?? 1_000_000,
    entryPc5mPct: partial.entryPc5mPct ?? null,
    buySignature: partial.buySignature ?? null,
    peakPriceUsd: partial.peakPriceUsd,
    trailArmed: partial.trailArmed,
    exitPendingReason: partial.exitPendingReason,
    mfeBankStage: partial.mfeBankStage,
    scaleOutDone: partial.scaleOutDone,
  };
}

describe('orderMintsForMark', () => {
  it('prioritizes sticky then armed', () => {
    const open = {
      a: pos({ mint: 'a', openedAtMs: 100, trailArmed: false }),
      b: pos({ mint: 'b', openedAtMs: 300, trailArmed: true }),
      e: pos({
        mint: 'e',
        openedAtMs: 400,
        trailArmed: false,
        exitPendingReason: 'mfe_bank_sleeve',
      }),
    };
    expect(orderMintsForMark(open)).toEqual(['e', 'b', 'a']);
  });
});

describe('decideMarkExit mfeBank', () => {
  it('fires mfe_bank_1 at +8% MFE', () => {
    const p = pos({
      mint: 'm1',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs: Date.now() - 60_000,
    });
    const d = decideMarkExit({
      mint: 'm1',
      pos: p,
      markPriceUsd: 108,
      gates,
      nowMs: Date.now(),
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('mfe_bank_1');
    expect(d?.fraction).toBeCloseTo(0.4, 5);
    applyMarkDecisionToPosition(p, d!);
    expect(p.trailArmed).toBe(true);
  });

  it('sticky exit re-queues pending reason', () => {
    const p = pos({
      mint: 'm2',
      entryPriceUsd: 100,
      peakPriceUsd: 110,
      trailArmed: true,
      exitPendingReason: 'mfe_bank_sleeve',
      openedAtMs: Date.now() - 120_000,
    });
    const d = decideMarkExit({
      mint: 'm2',
      pos: p,
      markPriceUsd: 100,
      gates,
      nowMs: Date.now(),
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('mfe_bank_sleeve');
    expect(d?.fraction).toBe(1);
  });
});
