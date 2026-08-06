import { describe, expect, it } from 'vitest';
import {
  evaluateMildDipEntry,
  evaluateMildDipPeakGiveback,
  evaluateMildDipPreBuy,
  type MildDipCandidateMetrics,
  type MildDipEntryGates,
  type MildDipExitGates,
} from '../../src/milddip/gates.js';

function metrics(partial: Partial<MildDipCandidateMetrics>): MildDipCandidateMetrics {
  return {
    priceChange5mPct: -9.7,
    volume5mUsd: 12_000,
    liquidityUsd: 40_000,
    marketCapUsd: 400_000,
    pairAgeHours: 48,
    dexId: 'pumpswap',
    buys5m: 10,
    sells5m: 10,
    volume1hUsd: 80_000,
    ...partial,
  };
}

const baseGates: MildDipEntryGates = {
  minDipPct: -20,
  maxDipPct: 0,
  minVolume5mUsd: 8_000,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 300_000_000,
  minPairAgeHours: 0.25,
  maxPairAgeHours: 72,
  allowedDexIds: ['pumpswap', 'pumpfun'],
};

const exitGates: MildDipExitGates = {
  armPct: 8,
  givebackPct: 8,
  neverArmPatienceMs: 0,
  neverArmMaxHoldMs: 5_400_000,
  neverArmDeadMinMs: 900_000,
  neverArmDeadPnlPct: 15,
  neverArmVolFadeMinMs: 900_000,
  neverArmVolFadeRatio: 0.25,
  neverArmVolFadeFloorUsd: 300,
  neverArmVolFadeSampleMs: 300_000,
  neverArmVolFadeWeakWindows: 3,
  cliffDumpPnlPct: 50,
};

/** Legacy early-knife gates — only for testing never_arm_giveback still works when enabled. */
const exitGatesPatienceOn: MildDipExitGates = {
  ...exitGates,
  givebackPct: 6,
  neverArmPatienceMs: 300_000,
};

describe('evaluateMildDipEntry', () => {
  it('passes a typical mild-dip candidate', () => {
    const v = evaluateMildDipEntry(metrics({ pairAgeHours: 48 }), baseGates);
    expect(v.pass).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('rejects chase (pc5m > 0)', () => {
    const v = evaluateMildDipEntry(metrics({ priceChange5mPct: 3, pairAgeHours: 48 }), baseGates);
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('pc5m'))).toBe(true);
  });

  it('rejects deep knife (pc5m ≤ −20)', () => {
    const v = evaluateMildDipEntry(metrics({ priceChange5mPct: -20, pairAgeHours: 48 }), baseGates);
    expect(v.pass).toBe(false);
  });

  it('accepts boundary maxDipPct = 0 on normal tape', () => {
    const v = evaluateMildDipEntry(
      metrics({ priceChange5mPct: 0, dexId: 'pumpfun' }),
      baseGates,
    );
    expect(v.pass).toBe(true);
  });

  it('prod band (−20, −4]: rejects shallow flat-chop, accepts real dump', () => {
    const prod = { ...baseGates, maxDipPct: -4 };
    const shallow = evaluateMildDipEntry(
      metrics({ priceChange5mPct: -2.5 }),
      prod,
    );
    expect(shallow.pass).toBe(false);
    const dump = evaluateMildDipEntry(
      metrics({ priceChange5mPct: -9.0 }),
      prod,
    );
    expect(dump.pass).toBe(true);
    const boundary = evaluateMildDipEntry(
      metrics({ priceChange5mPct: -4 }),
      prod,
    );
    expect(boundary.pass).toBe(true);
  });
});

describe('evaluateMildDipPreBuy', () => {
  const band = {
    minDipPct: -20,
    maxDipPct: 0,
  };

  it('passes when still in dip and mark not chasing', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.02,
      freshPc5mPct: -8,
      entryGates: band,
      maxChasePct: 4,
    });
    expect(v.pass).toBe(true);
  });

  it('rejects green candle (pc5m > 0) after stale signal', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.01,
      freshPc5mPct: 2.5,
      entryGates: band,
      maxChasePct: 4,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_pc5m'))).toBe(true);
  });

  it('rejects bounce above maxChasePct even if pc5m still red', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.06,
      freshPc5mPct: -5,
      entryGates: band,
      maxChasePct: 4,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_chase'))).toBe(true);
  });

  it('allows chase check off when maxChasePct=0', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.2,
      freshPc5mPct: -3,
      entryGates: band,
      maxChasePct: 0,
    });
    expect(v.pass).toBe(true);
  });
});

describe('evaluateMildDipPeakGiveback (W9.1)', () => {
  it('arm then giveback win: entry 100 → peak 115 → mark 105.8 (−8%)', () => {
    const armed = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 115,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
    });
    expect(armed.justArmed).toBe(true);
    expect(armed.armed).toBe(true);
    expect(armed.shouldExit).toBe(false);

    const hold = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108.1, // −6% of 115 — not enough at giveback=8
      peakPriceUsd: 115,
      armed: true,
      gates: exitGates,
    });
    expect(hold.shouldExit).toBe(false);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.8, // −8% of 115
      peakPriceUsd: 115,
      armed: true,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('peak_giveback');
    expect(v.pnlPct).toBeGreaterThan(0);
    expect(v.givebackPct).toBeLessThanOrEqual(-8 + 1e-6);
  });

  it('arm at +8% / giveback −8%: floor ≈ −0.64% from entry at exact trigger', () => {
    const arm = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
    });
    expect(arm.armed).toBe(true);
    expect(arm.justArmed).toBe(true);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 99.36, // −8% of 108
      peakPriceUsd: 108,
      armed: true,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('peak_giveback');
    expect(v.pnlPct).toBeCloseTo(-0.64, 2);
  });

  it('mark overshoot past giveback can still realize a loss', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 97,
      peakPriceUsd: 108,
      armed: true,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('peak_giveback');
    expect(v.pnlPct).toBeLessThan(0);
  });

  it('patience=0: deep dump at 5m does NOT early-cut (no never_arm_giveback)', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 90,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
      heldMs: 300_000,
    });
    expect(v.armed).toBe(false);
    expect(v.shouldExit).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('never-arm giveback still works when patience explicitly enabled', () => {
    // peak 104 (+4% < arm 8), mark 97.76 (−6% of 104), held 5m
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 97.76,
      peakPriceUsd: 104,
      armed: false,
      gates: exitGatesPatienceOn,
      heldMs: 300_000,
    });
    expect(v.armed).toBe(false);
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_giveback');
  });

  it('never-arm dead cut: unarmed + pnl ≤ −15% after 15m', () => {
    const hold = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
      heldMs: 600_000, // 10m — before dead min
    });
    expect(hold.shouldExit).toBe(false);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
      heldMs: 900_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_dead');
    expect(v.pnlPct).toBeLessThanOrEqual(-15);
  });

  it('never-arm dead does not fire on mild red before min hold', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 90, // −10% < 15% threshold
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
      heldMs: 900_000,
    });
    expect(v.shouldExit).toBe(false);
  });

  it('cliff_dump exits immediately at ≤ −50% without waiting dead min-hold', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 40,
      peakPriceUsd: 103.71,
      armed: false,
      gates: exitGates,
      heldMs: 30_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('cliff_dump');
    expect(v.pnlPct).toBeLessThanOrEqual(-50);
  });

  it('cliff_dump off when cliffDumpPnlPct=0', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 40,
      peakPriceUsd: 100,
      armed: false,
      gates: { ...exitGates, cliffDumpPnlPct: 0 },
      heldMs: 30_000,
    });
    expect(v.shouldExit).toBe(false);
  });

  it('never-arm timeout at max hold if still unarmed', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 103,
      peakPriceUsd: 105,
      armed: false,
      gates: exitGates,
      heldMs: 5_400_000,
    });
    expect(v.armed).toBe(false);
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_timeout');
  });

  it('never-arm still holds at 20m when max-hold is 40m', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 103,
      peakPriceUsd: 105,
      armed: false,
      gates: exitGates,
      heldMs: 1_200_000,
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('peak updates: giveback measured from 120 not 110', () => {
    const mid = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 110,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
    });
    expect(mid.peakPriceUsd).toBe(110);
    expect(mid.armed).toBe(true);

    const high = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 120,
      peakPriceUsd: mid.peakPriceUsd,
      armed: mid.armed,
      gates: exitGates,
    });
    expect(high.peakPriceUsd).toBe(120);

    // −6% from peak 120 → still holds (trigger is −8%)
    const hold = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 112.8,
      peakPriceUsd: 120,
      armed: true,
      gates: exitGates,
    });
    expect(hold.shouldExit).toBe(false);

    // −8% from 120 = 110.4
    const exit = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 110.4,
      peakPriceUsd: 120,
      armed: true,
      gates: exitGates,
    });
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('peak_giveback');
  });

  it('no time exit: long hold without giveback stays open', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 112,
      peakPriceUsd: 115,
      armed: true,
      gates: exitGates,
    });
    // giveback from 115 to 112 ≈ −2.6% — not enough
    expect(v.shouldExit).toBe(false);
  });

  it('no SL-from-entry before patience: mark 85 with tiny peak 102 holds', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 85,
      peakPriceUsd: 102,
      armed: false,
      gates: exitGates,
      heldMs: 60_000,
    });
    // MFE only +2% < arm 8 → not armed; early dump is not an entry-SL
    expect(v.armed).toBe(false);
    expect(v.shouldExit).toBe(false);
  });

  it('never-arm exits disabled when patience/maxHold/dead are 0 (unsafe — for unit only)', () => {
    const gates: MildDipExitGates = {
      armPct: 8,
      givebackPct: 8,
      neverArmPatienceMs: 0,
      neverArmMaxHoldMs: 0,
      neverArmDeadMinMs: 0,
      neverArmDeadPnlPct: 0,
      neverArmVolFadeMinMs: 0,
      neverArmVolFadeRatio: 0,
      cliffDumpPnlPct: 0,
      neverArmVolFadeFloorUsd: 0,
      neverArmVolFadeSampleMs: 0,
      neverArmVolFadeWeakWindows: 0,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 85,
      peakPriceUsd: 102,
      armed: false,
      gates,
      heldMs: 3_600_000,
    });
    expect(v.shouldExit).toBe(false);
  });
});
