import { describe, expect, it } from 'vitest';
import {
  bounceFromTroughPct,
  evaluateFlatMicroDip,
  evaluateMildDipEntry,
  evaluateMildDipPeakGiveback,
  evaluateMildDipPreBuy,
  isRecoveringFromTrough,
  knifeStabilizeMinMarketCapUsd,
  mildDipMicroSizeGatesForSource,
  resolveMildDipWantedSizeUsd,
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
    priceChange1hPct: -20,
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
  minPairAgeHours: 0.5,
  maxPairAgeHours: 72,
  allowedDexIds: ['pumpswap', 'pumpfun'],
};

const mfeBankOff = {
  mfeBankEnabled: false,
  mfeBank1Pct: 8,
  mfeBank1Fraction: 0.4,
  mfeBank2Pct: 15,
  mfeBank2Fraction: 0.4,
  mfeBankSleeveGivebackPct: 12,
} as const;

const exitGates: MildDipExitGates = {
  armPct: 5,
  partialGivebackPct: 3,
  scaleOutFraction: 0.5,
  givebackPct: 8,
  ...mfeBankOff,
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
};

/** Legacy early-knife gates — only for testing never_arm_giveback still works when enabled. */
const exitGatesPatienceOn: MildDipExitGates = {
  ...exitGates,
  armPct: 8, // keep unarmed at +4% MFE for this legacy case
  partialGivebackPct: 0,
  givebackPct: 6,
  neverArmPatienceMs: 300_000,
};

/** Full-only trail (no scale-out) — preserves older peak_giveback unit cases. */
const exitGatesFullOnly: MildDipExitGates = {
  ...exitGates,
  armPct: 8,
  partialGivebackPct: 0,
  givebackPct: 8,
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

  it('prod band (−25, −8]: rejects mild scrapes, accepts real dump', () => {
    const prod = { ...baseGates, minDipPct: -25, maxDipPct: -8 };
    const shallow = evaluateMildDipEntry(
      metrics({ priceChange5mPct: -5.0 }),
      prod,
    );
    expect(shallow.pass).toBe(false);
    const dump = evaluateMildDipEntry(
      metrics({ priceChange5mPct: -12.0 }),
      prod,
    );
    expect(dump.pass).toBe(true);
    const boundary = evaluateMildDipEntry(
      metrics({ priceChange5mPct: -8 }),
      prod,
    );
    expect(boundary.pass).toBe(true);
  });

  it('1.11.724 — rejects pairs younger than 30m, accepts at floor', () => {
    const young = evaluateMildDipEntry(metrics({ pairAgeHours: 0.4 }), baseGates);
    expect(young.pass).toBe(false);
    expect(young.reasons.some((r) => r.includes('age_h='))).toBe(true);
    const atFloor = evaluateMildDipEntry(metrics({ pairAgeHours: 0.5 }), baseGates);
    expect(atFloor.pass).toBe(true);
  });

  it('1.11.725 — rejects mcap below $50k, accepts at floor', () => {
    const gates = { ...baseGates, minMarketCapUsd: 50_000 };
    const thin = evaluateMildDipEntry(metrics({ marketCapUsd: 49_999 }), gates);
    expect(thin.pass).toBe(false);
    expect(thin.reasons.some((r) => r.includes('mcap='))).toBe(true);
    const atFloor = evaluateMildDipEntry(metrics({ marketCapUsd: 50_000 }), gates);
    expect(atFloor.pass).toBe(true);
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

  it('h1_red_shallow band (−10,−3]: accepts −4% that main mild (−25,−5] rejects', () => {
    const h1Band = { minDipPct: -10, maxDipPct: -3 };
    const shallow = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 0.99,
      freshPc5mPct: -4,
      entryGates: h1Band,
      maxChasePct: 4,
    });
    expect(shallow.pass).toBe(true);

    // Main mild requires pc5m ≤ −5; −4% is the h1-only pocket.
    const onMainBand = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 0.99,
      freshPc5mPct: -4,
      entryGates: { minDipPct: -25, maxDipPct: -8 },
      maxChasePct: 4,
    });
    expect(onMainBand.pass).toBe(false);
  });

  it('h1_red_shallow still rejects bounce to green', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.02,
      freshPc5mPct: 4,
      entryGates: { minDipPct: -10, maxDipPct: -3 },
      maxChasePct: 4,
    });
    expect(v.pass).toBe(false);
  });
});

describe('evaluateFlatMicroDip', () => {
  const flat = {
    minDipPct: -5,
    maxDipPct: -1.5,
    h1MinPct: -35,
    h1MaxPct: 10,
  };

  it('accepts fartdog-style −2.21% scrape in chop hour', () => {
    const v = evaluateFlatMicroDip({
      priceChange5mPct: -2.21,
      priceChange1hPct: -18,
      ...flat,
    });
    expect(v.pass).toBe(true);
  });

  it('rejects main-mild depth (−6) — leave to mild/knife branches', () => {
    const v = evaluateFlatMicroDip({
      priceChange5mPct: -6,
      priceChange1hPct: -10,
      ...flat,
    });
    expect(v.pass).toBe(false);
  });

  it('rejects fresh 1h nuke below h1Min', () => {
    const v = evaluateFlatMicroDip({
      priceChange5mPct: -2.5,
      priceChange1hPct: -40,
      ...flat,
    });
    expect(v.pass).toBe(false);
  });

  it('rejects strong green 1h', () => {
    const v = evaluateFlatMicroDip({
      priceChange5mPct: -2.5,
      priceChange1hPct: 15,
      ...flat,
    });
    expect(v.pass).toBe(false);
  });
});

describe('evaluateMildDipPeakGiveback (W9.1)', () => {
  it('arm then giveback win: entry 100 → peak 115 → mark 105.8 (−8%)', () => {
    const armed = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 115,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGatesFullOnly,
    });
    expect(armed.justArmed).toBe(true);
    expect(armed.armed).toBe(true);
    expect(armed.shouldExit).toBe(false);

    const hold = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108.1, // −6% of 115 — not enough at giveback=8
      peakPriceUsd: 115,
      armed: true,
      gates: exitGatesFullOnly,
    });
    expect(hold.shouldExit).toBe(false);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.8, // −8% of 115
      peakPriceUsd: 115,
      armed: true,
      gates: exitGatesFullOnly,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('peak_giveback');
    expect(v.fraction).toBe(1);
    expect(v.pnlPct).toBeGreaterThan(0);
    expect(v.givebackPct).toBeLessThanOrEqual(-8 + 1e-6);
  });

  it('arm at +5%: NV2RYH-style +5.5% MFE arms the trail', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.5,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
    });
    expect(v.armed).toBe(true);
    expect(v.justArmed).toBe(true);
    expect(v.shouldExit).toBe(false);
  });

  it('scale-out: −3% from peak sells half; −8% sells all', () => {
    // 105 * 0.97 = 101.85 → −3%
    const at3 = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 101.85,
      peakPriceUsd: 105,
      armed: true,
      scaleOutDone: false,
      gates: exitGates,
    });
    expect(at3.shouldExit).toBe(true);
    expect(at3.reason).toBe('peak_giveback_partial');
    expect(at3.fraction).toBe(0.5);

    const afterPartial = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 101.85,
      peakPriceUsd: 105,
      armed: true,
      scaleOutDone: true,
      gates: exitGates,
    });
    expect(afterPartial.shouldExit).toBe(false);

    const full = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 96.6, // 105 * 0.92
      peakPriceUsd: 105,
      armed: true,
      scaleOutDone: true,
      gates: exitGates,
    });
    expect(full.shouldExit).toBe(true);
    expect(full.reason).toBe('peak_giveback');
    expect(full.fraction).toBe(1);
  });

  it('full giveback gap still sells half first when scale-out not taken', () => {
    // Mark gaps past −8% in one tick — must not full-dump the bag (1.11.741).
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 96.6,
      peakPriceUsd: 105,
      armed: true,
      scaleOutDone: false,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('peak_giveback_partial');
    expect(v.fraction).toBe(0.5);
  });

  it('arm at +8% / giveback −8%: floor ≈ −0.64% from entry at exact trigger', () => {
    const arm = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGatesFullOnly,
    });
    expect(arm.armed).toBe(true);
    expect(arm.justArmed).toBe(true);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 99.36, // −8% of 108
      peakPriceUsd: 108,
      armed: true,
      gates: exitGatesFullOnly,
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
      gates: exitGatesFullOnly,
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

  it('never-arm stale: unarmed + flat MFE + pnl ≤ −5% after 10m', () => {
    const early = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 94, // −6%
      peakPriceUsd: 101, // MFE 1%
      armed: false,
      gates: exitGates,
      heldMs: 300_000,
    });
    expect(early.shouldExit).toBe(false);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 94,
      peakPriceUsd: 101,
      armed: false,
      gates: exitGates,
      heldMs: 600_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_stale');
  });

  it('never-arm stale does not fire when MFE already moved', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 94,
      peakPriceUsd: 104, // MFE 4% > 2%
      armed: false,
      gates: exitGates,
      heldMs: 600_000,
    });
    expect(v.reason).not.toBe('never_arm_stale');
  });

  it('never-arm dead cut: unarmed + pnl ≤ −10% after 30m (stale off)', () => {
    const gatesNoStale = { ...exitGates, neverArmStaleMinMs: 0, neverArmStalePnlPct: 0 };
    const hold = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 88, // −12%
      peakPriceUsd: 103, // MFE 3% — above stale max if stale were on
      armed: false,
      gates: gatesNoStale,
      heldMs: 900_000, // 15m — under 30m floor
    });
    expect(hold.shouldExit).toBe(false);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 88,
      peakPriceUsd: 103,
      armed: false,
      gates: gatesNoStale,
      heldMs: 1_800_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_dead');
    expect(v.pnlPct).toBeLessThanOrEqual(-10);
  });

  it('never-arm dead does not fire on mild red before min hold', () => {
    const gatesNoStale = { ...exitGates, neverArmStaleMinMs: 0, neverArmStalePnlPct: 0 };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 92, // −8% > −10% dead threshold
      peakPriceUsd: 100,
      armed: false,
      gates: gatesNoStale,
      heldMs: 1_800_000,
    });
    expect(v.shouldExit).toBe(false);
  });

  it('hard_stop exits immediately at ≤ −15% (before soft exits)', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 85,
      peakPriceUsd: 102,
      armed: false,
      gates: exitGates,
      heldMs: 5_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('hard_stop');
    expect(v.fraction).toBe(1);
    expect(v.pnlPct).toBeLessThanOrEqual(-15);
  });

  it('hard_stop off when hardStopPnlPct=0', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 85,
      peakPriceUsd: 100,
      armed: false,
      gates: {
        ...exitGates,
        hardStopPnlPct: 0,
        neverArmFreefallPnlPct: 0,
        neverArmBouncePct: 0,
        neverArmTimeRedMinMs: 0,
      },
      heldMs: 5_000,
    });
    expect(v.shouldExit).toBe(false);
  });

  it('hard_stop wins over cliff when both thresholds are breached', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 40,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
      heldMs: 5_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('hard_stop');
  });

  it('1.11.794 — staged hard stop: half at −25%, runner full-exits if still ≤ −25%', () => {
    const staged = {
      ...exitGates,
      hardStopPnlPct: 25,
      hardStopPartialFraction: 0.5,
      cliffDumpPnlPct: 50,
      neverArmFreefallPnlPct: 0,
      neverArmBouncePct: 0,
      neverArmTimeRedMinMs: 0,
      neverArmMaxHoldMs: 0,
    };
    const half = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 75,
      peakPriceUsd: 100,
      armed: false,
      gates: staged,
      heldMs: 5_000,
    });
    expect(half.shouldExit).toBe(true);
    expect(half.reason).toBe('hard_stop');
    expect(half.fraction).toBe(0.5);

    // 1.11.794 — no limbo: runner still ≤ −hardStop → full hard_stop (not wait −50).
    const killRunner = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 70,
      peakPriceUsd: 100,
      armed: false,
      scaleOutDone: true,
      gates: staged,
      heldMs: 5_000,
    });
    expect(killRunner.shouldExit).toBe(true);
    expect(killRunner.reason).toBe('hard_stop');
    expect(killRunner.fraction).toBe(1);

    const rest = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 50,
      peakPriceUsd: 100,
      armed: false,
      scaleOutDone: true,
      gates: staged,
      heldMs: 5_000,
    });
    expect(rest.shouldExit).toBe(true);
    expect(rest.reason).toBe('cliff_dump');
    expect(rest.fraction).toBe(1);
  });

  it('1.11.791 — staged: gap to −50% full cliff_dump (no orphan half)', () => {
    const staged = {
      ...exitGates,
      hardStopPnlPct: 25,
      hardStopPartialFraction: 0.5,
      cliffDumpPnlPct: 50,
      neverArmFreefallPnlPct: 0,
      neverArmBouncePct: 0,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 40,
      peakPriceUsd: 100,
      armed: false,
      gates: staged,
      heldMs: 5_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('cliff_dump');
    expect(v.fraction).toBe(1);
  });

  it('cliff_dump exits immediately at ≤ −50% without waiting dead min-hold', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 40,
      peakPriceUsd: 103.71,
      armed: false,
      gates: { ...exitGates, hardStopPnlPct: 0 },
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
      gates: {
        ...exitGates,
        hardStopPnlPct: 0,
        cliffDumpPnlPct: 0,
        neverArmFreefallPnlPct: 0,
        neverArmBouncePct: 0,
      },
      heldMs: 30_000,
    });
    expect(v.shouldExit).toBe(false);
  });

  it('never_arm_bounce: dump to trough then reclaim ≥8% off trough → half exit', () => {
    // trough 80 (−20%); mark 86.5 = +8.125% off trough; still −13.5% vs entry
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 86.5,
      peakPriceUsd: 102,
      armed: false,
      gates: exitGates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_bounce');
    expect(v.fraction).toBe(0.5);
  });

  it('never_arm_bounce: second cut at ≥16% bounce after scaleOutDone', () => {
    // trough 80; mark 93 = +16.25% off trough; still −7% vs entry
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 93,
      peakPriceUsd: 102,
      armed: false,
      scaleOutDone: true,
      gates: exitGates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_bounce');
    expect(v.fraction).toBe(1);
  });

  it('never_arm_bounce: after half, 8% bounce alone does not dump runner', () => {
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 86.5, // +8.125% off trough — first threshold only
      peakPriceUsd: 102,
      armed: false,
      scaleOutDone: true,
      gates: exitGates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.reason).not.toBe('never_arm_bounce');
  });

  it('never_arm_bounce: needs trough dump ≤ −8% first', () => {
    // shallow trough 94 (−6%); bounce +10% off trough — dump gate fails
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 103.4,
      peakPriceUsd: 103.4,
      armed: false,
      gates: exitGates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 94,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.reason).not.toBe('never_arm_bounce');
  });

  it('never_arm_bounce: blocks near-flat reclaim (F1XdRe/AENK1Y churn)', () => {
    // trough −11%, bounce +9.5% → mark only −2.4% vs entry (require red 3%)
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 0.0001191,
      markPriceUsd: 0.0001162,
      peakPriceUsd: 0.0001191,
      armed: false,
      gates: exitGates,
      heldMs: 225_000,
      nowMs: now,
      postEntryTroughPriceUsd: 0.0001061,
      postEntryTroughAtMs: now - 84_000,
    });
    expect(v.reason).not.toBe('never_arm_bounce');
  });

  it('never_arm_bounce: blocks fresh stream-wick trough (age < 60s)', () => {
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 86.5,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 14_000, // AENK1Y-style
    });
    expect(v.reason).not.toBe('never_arm_bounce');
  });

  it('never_arm_freefall: unarmed pnl ≤ −25% after min hold (no bounce needed)', () => {
    // hard stop off — exercise freefall path below −15%
    const gates = { ...exitGates, hardStopPnlPct: 0 };
    const early = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 74,
      peakPriceUsd: 101,
      armed: false,
      gates,
      heldMs: 30_000, // under 60s floor
      postEntryTroughPriceUsd: 74,
    });
    expect(early.shouldExit).toBe(false);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 74,
      peakPriceUsd: 101,
      armed: false,
      gates,
      heldMs: 60_000,
      postEntryTroughPriceUsd: 74,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_freefall');
  });

  it('never_arm_bounce beats freefall when reclaiming off deep trough', () => {
    // At −24% mark would freefall (−25), but +8.6% off trough 70 → bounce first
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 76, // +8.57% off 70; still −24% vs entry
      peakPriceUsd: 101,
      armed: false,
      gates: { ...exitGates, hardStopPnlPct: 0 },
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 70,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.reason).toBe('never_arm_bounce');
    expect(v.fraction).toBe(0.5);
  });

  it('never-arm timeout at max hold if still unarmed', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 103,
      peakPriceUsd: 104, // MFE +4% < arm 5 — stay unarmed
      armed: false,
      gates: exitGates,
      heldMs: 5_400_000,
    });
    expect(v.armed).toBe(false);
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_timeout');
  });

  it('1.11.781 — never-arm hard ceiling at 15m (live MAX_HOLD)', () => {
    const gates15 = { ...exitGates, neverArmMaxHoldMs: 900_000 };
    const under = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 99,
      peakPriceUsd: 100,
      armed: false,
      gates: gates15,
      heldMs: 899_000,
    });
    expect(under.shouldExit).toBe(false);
    const over = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 99,
      peakPriceUsd: 100,
      armed: false,
      gates: gates15,
      heldMs: 900_000,
    });
    expect(over.shouldExit).toBe(true);
    expect(over.reason).toBe('never_arm_timeout');
  });

  it('1.11.782 — green armed trail may outlive 15m max-hold', () => {
    const gates15 = { ...exitGates, neverArmMaxHoldMs: 900_000 };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 110, // still green; giveback from 112 < partial 3%
      peakPriceUsd: 112, // armed via MFE
      armed: true,
      gates: gates15,
      heldMs: 3_600_000, // 1h — trail may keep holding while green
    });
    expect(v.armed).toBe(true);
    expect(v.pnlPct).toBeGreaterThan(0);
    expect(v.reason).not.toBe('never_arm_timeout');
    expect(v.reason).not.toBe('max_hold_underwater');
    expect(v.shouldExit).toBe(false);
  });

  it('1.11.782 — armed but underwater at 15m → max_hold_underwater', () => {
    const gates15 = { ...exitGates, neverArmMaxHoldMs: 900_000 };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 97, // red now
      peakPriceUsd: 112, // was armed
      armed: true,
      gates: gates15,
      heldMs: 900_000,
    });
    expect(v.armed).toBe(true);
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('max_hold_underwater');
    expect(v.fraction).toBe(1);
  });

  it('1.11.782 — armed flat (pnl=0) at 15m also flattens', () => {
    const gates15 = { ...exitGates, neverArmMaxHoldMs: 900_000 };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 100,
      peakPriceUsd: 112,
      armed: true,
      gates: gates15,
      heldMs: 900_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('max_hold_underwater');
  });

  it('never-arm still holds at 20m when max-hold is 40m', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 103,
      peakPriceUsd: 104,
      armed: false,
      gates: exitGates,
      heldMs: 1_200_000,
    });
    expect(v.armed).toBe(false);
    expect(v.shouldExit).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('peak updates: giveback measured from 120 not 110', () => {
    const mid = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 110,
      peakPriceUsd: 100,
      armed: false,
      gates: exitGatesFullOnly,
    });
    expect(mid.peakPriceUsd).toBe(110);
    expect(mid.armed).toBe(true);

    const high = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 120,
      peakPriceUsd: mid.peakPriceUsd,
      armed: mid.armed,
      gates: exitGatesFullOnly,
    });
    expect(high.peakPriceUsd).toBe(120);

    // −6% from peak 120 → still holds (full-only trigger is −8%)
    const hold = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 112.8,
      peakPriceUsd: 120,
      armed: true,
      gates: exitGatesFullOnly,
    });
    expect(hold.shouldExit).toBe(false);

    // −8% from 120 = 110.4
    const exit = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 110.4,
      peakPriceUsd: 120,
      armed: true,
      gates: exitGatesFullOnly,
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

  it('soft path holds at −14% when hard stop off (no patience knife)', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 86,
      peakPriceUsd: 102,
      armed: false,
      gates: {
        ...exitGates,
        hardStopPnlPct: 0,
        neverArmBouncePct: 0,
        neverArmFreefallPnlPct: 0,
        neverArmTimeRedMinMs: 0,
      },
      heldMs: 60_000,
    });
    expect(v.armed).toBe(false);
    expect(v.shouldExit).toBe(false);
  });

  it('hard_stop cuts −15% even when soft patience path would hold', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 85,
      peakPriceUsd: 102,
      armed: false,
      gates: exitGates,
      heldMs: 60_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('hard_stop');
  });

  it('never-arm exits disabled when patience/maxHold/dead/stale are 0 (unsafe — for unit only)', () => {
    const gates: MildDipExitGates = {
      armPct: 8,
      partialGivebackPct: 0,
      scaleOutFraction: 0.5,
      givebackPct: 8,
      ...mfeBankOff,
      neverArmPatienceMs: 0,
      neverArmMaxHoldMs: 0,
      neverArmDeadMinMs: 0,
      neverArmDeadPnlPct: 0,
      neverArmStaleMinMs: 0,
      neverArmStaleMaxMfePct: 0,
      neverArmStalePnlPct: 0,
      neverArmVolFadeMinMs: 0,
      neverArmVolFadeRatio: 0,
      cliffDumpPnlPct: 0,
      hardStopPnlPct: 0,
      hardStopPartialFraction: 0,
      neverArmVolFadeFloorUsd: 0,
      neverArmVolFadeSampleMs: 0,
      neverArmVolFadeWeakWindows: 0,
      neverArmBounceMinDumpPct: 0,
      neverArmBouncePct: 0,
      neverArmBounceMinTroughAgeMs: 0,
      neverArmBounceRequireRedPct: 0,
      neverArmBouncePartialFraction: 0,
      neverArmBounce2Pct: 0,
      mfeBankSleeveLossPartialFraction: 0,
      neverArmFreefallPnlPct: 0,
      neverArmFreefallMinMs: 0,
      neverArmTimeRedMinMs: 0,
      neverArmTimeRedPnlPct: 0,
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

  it('never_arm_time_red: 15m unarmed + pnl ≤ −5% → full exit (option-2)', () => {
    const early = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 94,
      peakPriceUsd: 101,
      armed: false,
      gates: {
        ...exitGates,
        neverArmFreefallPnlPct: 0,
        neverArmStaleMinMs: 0,
        neverArmDeadMinMs: 0,
        neverArmVolFadeMinMs: 0,
        neverArmMaxHoldMs: 0,
        neverArmTimeRedMinMs: 900_000,
        neverArmTimeRedPnlPct: 5,
      },
      heldMs: 800_000,
      postEntryTroughPriceUsd: 94,
    });
    expect(early.shouldExit).toBe(false);

    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 94,
      peakPriceUsd: 101,
      armed: false,
      gates: {
        ...exitGates,
        neverArmFreefallPnlPct: 0,
        neverArmStaleMinMs: 0,
        neverArmDeadMinMs: 0,
        neverArmVolFadeMinMs: 0,
        neverArmMaxHoldMs: 0,
        neverArmTimeRedMinMs: 900_000,
        neverArmTimeRedPnlPct: 5,
      },
      heldMs: 900_000,
      postEntryTroughPriceUsd: 94,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_time_red');
    expect(v.fraction).toBe(1);
  });

  it('never_arm_time_red: does not fire when pnl > −threshold', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 97,
      peakPriceUsd: 101,
      armed: false,
      gates: {
        ...exitGates,
        neverArmFreefallPnlPct: 0,
        neverArmStaleMinMs: 0,
        neverArmDeadMinMs: 0,
        neverArmVolFadeMinMs: 0,
        neverArmMaxHoldMs: 0,
        neverArmTimeRedMinMs: 900_000,
        neverArmTimeRedPnlPct: 5,
      },
      heldMs: 1_200_000,
      postEntryTroughPriceUsd: 97,
    });
    expect(v.reason).not.toBe('never_arm_time_red');
  });

  it('never_arm_time_red HELD+PC+SL: 5m + pnl≤−15 + pc5m≤−5 (7BNax DOWN)', () => {
    const gatesHeldPcSl = {
      ...exitGates,
      hardStopPnlPct: 0,
      cliffDumpPnlPct: 0,
      neverArmFreefallPnlPct: 0,
      neverArmStaleMinMs: 0,
      neverArmDeadMinMs: 0,
      neverArmVolFadeMinMs: 0,
      neverArmMaxHoldMs: 0,
      neverArmBouncePct: 0,
      neverArmTimeRedMinMs: 300_000,
      neverArmTimeRedPnlPct: 15,
      neverArmTimeRedMaxPc5mPct: 5,
    };

    const early = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 102,
      armed: false,
      gates: gatesHeldPcSl,
      heldMs: 200_000,
      pc5mPct: -8,
      postEntryTroughPriceUsd: 80,
    });
    expect(early.shouldExit).toBe(false);

    // 1.11.794 — missing pc5m fail-open (held+pnl still cut).
    const noPc = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 102,
      armed: false,
      gates: gatesHeldPcSl,
      heldMs: 300_000,
      pc5mPct: null,
      postEntryTroughPriceUsd: 80,
    });
    expect(noPc.shouldExit).toBe(true);
    expect(noPc.reason).toBe('never_arm_time_red');

    // Present-but-mild pc5m still blocks (formula needs ≤ −5 when known).
    const mildPc = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 102,
      armed: false,
      gates: gatesHeldPcSl,
      heldMs: 300_000,
      pc5mPct: -3,
      postEntryTroughPriceUsd: 80,
    });
    expect(mildPc.reason).not.toBe('never_arm_time_red');

    const hit = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 102,
      armed: false,
      gates: gatesHeldPcSl,
      heldMs: 300_000,
      pc5mPct: -5,
      postEntryTroughPriceUsd: 80,
    });
    expect(hit.shouldExit).toBe(true);
    expect(hit.reason).toBe('never_arm_time_red');
    expect(hit.fraction).toBe(1);

    // Armed trail must ignore this never-arm knife.
    const armed = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 110,
      armed: true,
      gates: gatesHeldPcSl,
      heldMs: 300_000,
      pc5mPct: -20,
      postEntryTroughPriceUsd: 80,
    });
    expect(armed.reason).not.toBe('never_arm_time_red');
  });
});

describe('evaluateMildDipPeakGiveback MFE bank + sleeve (1.11.750)', () => {
  const bankGates: MildDipExitGates = {
    ...exitGates,
    mfeBankEnabled: true,
    mfeBank1Pct: 8,
    mfeBank1Fraction: 0.4,
    mfeBank2Pct: 15,
    mfeBank2Fraction: 0.4,
    mfeBankSleeveGivebackPct: 12,
    // classic path must stay inert while bank owns armed exits
    partialGivebackPct: 3,
    scaleOutFraction: 0.5,
    givebackPct: 8,
  };

  it('banks 40% at +8% MFE (into strength, no giveback wait)', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 108,
      armed: false,
      mfeBankStage: 0,
      gates: bankGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_1');
    expect(v.fraction).toBeCloseTo(0.4, 6);
    expect(v.armed).toBe(true);
  });

  it('banks second 40% of original at +15% (≈66.7% of remaining)', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 115,
      peakPriceUsd: 115,
      armed: true,
      mfeBankStage: 1,
      gates: bankGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_2');
    expect(v.fraction).toBeCloseTo(0.4 / 0.6, 6);
  });

  it('one level per tick: +20% gap still only fires bank1 when stage=0', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 120,
      peakPriceUsd: 120,
      armed: false,
      mfeBankStage: 0,
      gates: bankGates,
    });
    expect(v.reason).toBe('mfe_bank_1');
    expect(v.fraction).toBeCloseTo(0.4, 6);
  });

  it('sleeve trails remaining 20% at −12% giveback after both banks', () => {
    // peak 130, mark 114.4 → giveback = 114.4/130 - 1 = −12%
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 114.4,
      peakPriceUsd: 130,
      armed: true,
      mfeBankStage: 2,
      gates: bankGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(1);
  });

  it('sleeve can protect remainder after bank1 before +15 (underwater → half)', () => {
    // peak 112, mark 98.56 → −12% giveback, stage=1, pnl −1.44%
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 98.56,
      peakPriceUsd: 112,
      armed: true,
      mfeBankStage: 1,
      gates: bankGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(0.5);
  });

  it('underwater sleeve after half does not dump runner on same giveback', () => {
    // EjD5Y9 / 4aWQZP… pattern: armed, sleeve hit, already scaled once
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 89,
      peakPriceUsd: 107.7,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 0,
      gates: bankGates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 88,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.reason).not.toBe('mfe_bank_sleeve');
  });

  it('armed runner after sleeve-loss half exits on bounce reclaim', () => {
    // trough 80 (−20%); mark 86.5 = +8.125% bounce; still red; armed+scaled
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 86.5,
      peakPriceUsd: 107.7,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 0,
      gates: bankGates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_bounce');
    expect(v.fraction).toBe(1);
  });

  it('does not fire classic −3% partial while MFE-bank is on', () => {
    // Armed, peak 110, mark 106.7 → giveback ≈ −3%, MFE 10% (between banks)
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 106.7,
      peakPriceUsd: 110,
      armed: true,
      mfeBankStage: 1,
      gates: bankGates,
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('oneshot grace defers sleeve but not bank1', () => {
    const bank = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 108,
      armed: false,
      mfeBankStage: 0,
      gates: bankGates,
      oneshotDumpGraceActive: true,
    });
    expect(bank.reason).toBe('mfe_bank_1');

    const sleeve = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 114.4,
      peakPriceUsd: 130,
      armed: true,
      mfeBankStage: 2,
      gates: bankGates,
      oneshotDumpGraceActive: true,
    });
    expect(sleeve.shouldExit).toBe(false);
  });
});

describe('resolveMildDipWantedSizeUsd', () => {
  const thick = {
    positionUsd: 20,
    minMarketCapUsd: 100_000,
    minLiquidityUsd: 50_000,
    minPairAgeHours: 6,
  };
  const micro = {
    positionUsd: 5,
    minMarketCapUsd: 15_000,
    maxMarketCapUsd: 50_000,
  };

  it('sizes thick at $20 when mcap/liq/age clear', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      thick,
      micro,
      metrics: { liquidityUsd: 50_000, marketCapUsd: 100_000, pairAgeHours: 6 },
    });
    expect(v).toEqual({ sizeUsd: 20, tier: 'thick' });
  });

  it('sizes micro at $5 for mcap $15k–$50k', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      thick,
      micro,
      metrics: { liquidityUsd: 12_000, marketCapUsd: 30_000, pairAgeHours: 1 },
    });
    expect(v).toEqual({ sizeUsd: 5, tier: 'micro' });
  });

  it('micro includes band edges $15k and $50k', () => {
    expect(
      resolveMildDipWantedSizeUsd({
        basePositionUsd: 10,
        thick,
        micro,
        metrics: { liquidityUsd: 12_000, marketCapUsd: 15_000, pairAgeHours: 1 },
      }),
    ).toEqual({ sizeUsd: 5, tier: 'micro' });
    expect(
      resolveMildDipWantedSizeUsd({
        basePositionUsd: 10,
        thick,
        micro,
        metrics: { liquidityUsd: 12_000, marketCapUsd: 50_000, pairAgeHours: 1 },
      }),
    ).toEqual({ sizeUsd: 5, tier: 'micro' });
  });

  it('base $10 above micro max when not thick', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      thick,
      micro,
      metrics: { liquidityUsd: 12_000, marketCapUsd: 50_001, pairAgeHours: 1 },
    });
    expect(v).toEqual({ sizeUsd: 10, tier: 'base' });
  });

  it('stays base when liq is thin (not thick; above micro band)', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      thick,
      micro,
      metrics: { liquidityUsd: 49_999, marketCapUsd: 500_000, pairAgeHours: 12 },
    });
    expect(v).toEqual({ sizeUsd: 10, tier: 'base' });
  });

  it('stays base when mcap below $100k but above micro', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      thick,
      micro,
      metrics: { liquidityUsd: 80_000, marketCapUsd: 99_999, pairAgeHours: 12 },
    });
    expect(v).toEqual({ sizeUsd: 10, tier: 'base' });
  });

  it('stays base when younger than 6h (not thick)', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      thick,
      micro,
      metrics: { liquidityUsd: 80_000, marketCapUsd: 200_000, pairAgeHours: 5.9 },
    });
    expect(v).toEqual({ sizeUsd: 10, tier: 'base' });
  });

  it('fail-closed on missing mcap (no micro / no thick)', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      thick,
      micro,
      metrics: { liquidityUsd: 80_000, marketCapUsd: null, pairAgeHours: 12 },
    });
    expect(v).toEqual({ sizeUsd: 10, tier: 'base' });
  });

  it('keeps thick tier when thick == base (flat $30 book)', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 30,
      thick: { ...thick, positionUsd: 30 },
      micro: { ...micro, positionUsd: 30 },
      metrics: { liquidityUsd: 80_000, marketCapUsd: 200_000, pairAgeHours: 12 },
    });
    expect(v).toEqual({ sizeUsd: 30, tier: 'thick' });
  });

  it('keeps micro tier when micro == base in micro mcap band', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 30,
      thick: { ...thick, positionUsd: 30 },
      micro: { ...micro, positionUsd: 30 },
      metrics: { liquidityUsd: 20_000, marketCapUsd: 30_000, pairAgeHours: 1 },
    });
    expect(v).toEqual({ sizeUsd: 30, tier: 'micro' });
  });
});

describe('mildDipMicroSizeGatesForSource (knife-only)', () => {
  const micro = {
    positionUsd: 5,
    minMarketCapUsd: 15_000,
    maxMarketCapUsd: 50_000,
  };

  it('passes micro gates only for knife_stabilize', () => {
    expect(mildDipMicroSizeGatesForSource(micro, 'knife_stabilize')).toEqual(micro);
  });

  it('null for all other dipSources', () => {
    for (const src of [
      'dex',
      'stream',
      'dex+stream',
      'h1_red_shallow',
      'flat_micro_dip',
      'mild_stabilize',
    ]) {
      expect(mildDipMicroSizeGatesForSource(micro, src)).toBeNull();
    }
  });

  it('null when micro clip is 0', () => {
    expect(
      mildDipMicroSizeGatesForSource({ ...micro, positionUsd: 0 }, 'knife_stabilize'),
    ).toBeNull();
  });
});

describe('knifeStabilizeMinMarketCapUsd', () => {
  it('drops to microMin when micro tier is on', () => {
    expect(
      knifeStabilizeMinMarketCapUsd({
        entryMinMarketCapUsd: 50_000,
        microPositionUsd: 5,
        microMinMarketCapUsd: 15_000,
      }),
    ).toBe(15_000);
  });

  it('keeps global floor when micro is off', () => {
    expect(
      knifeStabilizeMinMarketCapUsd({
        entryMinMarketCapUsd: 50_000,
        microPositionUsd: 0,
        microMinMarketCapUsd: 15_000,
      }),
    ).toBe(50_000);
  });
});

describe('isRecoveringFromTrough', () => {
  it('detects 5vkZWa-style reclaim off trough (≥3%)', () => {
    // trough 6.06e-5 → mark 6.333e-5 ≈ +4.5%
    expect(
      isRecoveringFromTrough({
        markPriceUsd: 6.333e-5,
        troughPriceUsd: 6.06e-5,
        minBouncePct: 3,
      }),
    ).toBe(true);
    expect(bounceFromTroughPct(6.333e-5, 6.06e-5)).toBeGreaterThan(4);
  });

  it('false when still near trough', () => {
    expect(
      isRecoveringFromTrough({
        markPriceUsd: 6.1e-5,
        troughPriceUsd: 6.06e-5,
        minBouncePct: 3,
      }),
    ).toBe(false);
  });

  it('off when minBouncePct=0', () => {
    expect(
      isRecoveringFromTrough({
        markPriceUsd: 10,
        troughPriceUsd: 5,
        minBouncePct: 0,
      }),
    ).toBe(false);
  });
});

describe('1.11.821 bank settle guard', () => {
  const base = {
    entryPriceUsd: 100,
    markPriceUsd: 110,
    peakPriceUsd: 110,
    armed: true,
    scaleOutDone: false,
    mfeBankStage: 0,
  };
  const g = { ...exitGates, mfeBankEnabled: true, mfeBank1Pct: 6, mfeBank1Fraction: 0.4, mfeBank2Pct: 8, mfeBank2Fraction: 0.6, mfeBankMinHoldMs: 20_000 };

  it('does not bank before the SPL balance can settle', () => {
    const v = evaluateMildDipPeakGiveback({ ...base, gates: g, heldMs: 2_000 });
    expect(v.reason).not.toBe('mfe_bank_1');
  });

  it('banks once the guard has passed', () => {
    const v = evaluateMildDipPeakGiveback({ ...base, gates: g, heldMs: 25_000 });
    expect(v.reason).toBe('mfe_bank_1');
  });

  it('guard off keeps the old immediate behaviour', () => {
    const v = evaluateMildDipPeakGiveback({
      ...base,
      gates: { ...g, mfeBankMinHoldMs: 0 },
      heldMs: 2_000,
    });
    expect(v.reason).toBe('mfe_bank_1');
  });
});
