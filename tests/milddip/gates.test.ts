import { describe, expect, it } from 'vitest';
import {
  bounceFromTroughPct,
  decideSoftLossExit,
  evaluateFlatMicroDip,
  evaluateMildDipEntry,
  evaluateMildDipEntryRisk,
  evaluateMildDipPeakGiveback,
  evaluateMildDipPreBuy,
  isRecoveringFromTrough,
  knifeStabilizeMinMarketCapUsd,
  mildDipLiquidityPowerLawSizeUsd,
  mildDipMicroSizeGatesForSource,
  mayFireSoftLossExit,
  resolveMildDipWantedSizeUsd,
  tpRungsCoveredByGainPct,
  type MildDipCandidateMetrics,
  type MildDipEntryGates,
  type MildDipExitGates,
} from '../../src/milddip/gates.js';
import { retrySlippageBpsForAttempt } from '../../src/milddip/exit-retry.js';

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

describe('mild-dip entry age and churn gates', () => {
  it('retry slippage increments by step and never exceeds cap', () => {
    expect(
      retrySlippageBpsForAttempt({
        eligible: true,
        baseSlippageBps: 200,
        priorRetryCount: 0,
        stepBps: 100,
        maxBps: 800,
      }),
    ).toBeUndefined();
    expect(
      retrySlippageBpsForAttempt({
        eligible: true,
        baseSlippageBps: 100,
        priorRetryCount: 2,
        stepBps: 100,
        maxBps: 250,
      }),
    ).toBe(250);
    expect(
      retrySlippageBpsForAttempt({
        eligible: true,
        baseSlippageBps: 100,
        priorRetryCount: 1,
        stepBps: 100,
        maxBps: 800,
      }),
    ).toBe(200);
  });
  const gate = {
    minPairAgeHours: 1,
    maxVol5mToLiq: 2,
  };

  it('rejects young pairs and accepts old pairs', () => {
    expect(
      evaluateMildDipEntryRisk({
        ...metrics({ pairAgeHours: 0.99 }),
        ...gate,
      }).reasons,
    ).toContainEqual(expect.stringContaining('pair_too_young'));
    expect(
      evaluateMildDipEntryRisk({
        ...metrics({ pairAgeHours: 1 }),
        ...gate,
      }).pass,
    ).toBe(true);
  });

  it('rejects churn at and above the configured ratio', () => {
    expect(
      evaluateMildDipEntryRisk({
        ...metrics({ volume5mUsd: 80_000, liquidityUsd: 40_000 }),
        ...gate,
      }).reasons,
    ).toContainEqual(expect.stringContaining('vol_liq_churn_too_high'));
    expect(
      evaluateMildDipEntryRisk({
        ...metrics({ volume5mUsd: 80_001, liquidityUsd: 40_000 }),
        ...gate,
      }).pass,
    ).toBe(false);
    expect(
      evaluateMildDipEntryRisk({
        ...metrics({ volume5mUsd: 79_999, liquidityUsd: 40_000 }),
        ...gate,
      }).pass,
    ).toBe(true);
  });

  it('fails open for missing metrics and non-positive liquidity', () => {
    for (const partial of [
      { pairAgeHours: null },
      { volume5mUsd: null },
      { liquidityUsd: null },
      { liquidityUsd: 0 },
    ]) {
      expect(
        evaluateMildDipEntryRisk({
          ...metrics(partial),
          ...gate,
        }).pass,
      ).toBe(true);
    }
  });

  it('disables each check independently at zero or below', () => {
    for (const minPairAgeHours of [0, -1]) {
      expect(
        evaluateMildDipEntryRisk({
          ...metrics({ pairAgeHours: 0.1 }),
          minPairAgeHours,
          maxVol5mToLiq: 0,
        }).pass,
      ).toBe(true);
    }
    for (const maxVol5mToLiq of [0, -1]) {
      expect(
        evaluateMildDipEntryRisk({
          ...metrics({ volume5mUsd: 80_000, liquidityUsd: 40_000 }),
          minPairAgeHours: 0,
          maxVol5mToLiq,
        }).pass,
      ).toBe(true);
    }
  });
});

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
  lossExitMinBouncePct: 0,
  lossExitMaxDrawdownPct: 0,
  lossExitMaxTroughAgeMs: 0,
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

  it('hard_stop exits immediately at ≤ −15% when loss bounce off (before soft exits)', () => {
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

  it('1.11.932 — hard_stop waits for bounce off trough (prod 12% / 60s)', () => {
    const prodLossGates: MildDipExitGates = {
      ...exitGates,
      lossExitMinBouncePct: 12,
      neverArmBounceMinTroughAgeMs: 60_000,
      neverArmBouncePct: 0,
      neverArmFreefallPnlPct: 0,
      neverArmTimeRedMinMs: 0,
      neverArmMaxHoldMs: 0,
    };
    const now = 1_000_000;
    const trough = 75;
    const atTrough = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 75,
      peakPriceUsd: 102,
      armed: false,
      gates: prodLossGates,
      heldMs: 120_000,
      nowMs: now,
      postEntryTroughPriceUsd: trough,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(atTrough.shouldExit).toBe(false);

    const smallBounce = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 102,
      armed: false,
      gates: prodLossGates,
      heldMs: 120_000,
      nowMs: now,
      postEntryTroughPriceUsd: trough,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(smallBounce.shouldExit).toBe(false);

    const bounced = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 84,
      peakPriceUsd: 102,
      armed: false,
      gates: prodLossGates,
      heldMs: 120_000,
      nowMs: now,
      postEntryTroughPriceUsd: trough,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(bounced.shouldExit).toBe(true);
    expect(bounced.reason).toBe('hard_stop');

    const freshTrough = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 84,
      peakPriceUsd: 102,
      armed: false,
      gates: prodLossGates,
      heldMs: 30_000,
      nowMs: now,
      postEntryTroughPriceUsd: trough,
      postEntryTroughAtMs: now - 30_000,
    });
    expect(freshTrough.shouldExit).toBe(false);
  });

  it('loss bounce caps default off preserves the trough wait', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      lossExitMinBouncePct: 12,
      lossExitMaxDrawdownPct: 0,
      lossExitMaxTroughAgeMs: 0,
      neverArmBounceMinTroughAgeMs: 60_000,
      neverArmFreefallPnlPct: 0,
      neverArmTimeRedMinMs: 0,
      neverArmMaxHoldMs: 0,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 102,
      armed: false,
      gates,
      heldMs: 120_000,
      nowMs: 1_000_000,
      postEntryTroughPriceUsd: 75,
      postEntryTroughAtMs: 910_000,
    });
    expect(v.shouldExit).toBe(false);
    expect(v.lossExitBounceCap).toBeUndefined();
  });

  it('loss drawdown cap releases the bounce wait only at or below its threshold', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      lossExitMinBouncePct: 12,
      lossExitMaxDrawdownPct: 20,
      lossExitMaxTroughAgeMs: 0,
      neverArmBounceMinTroughAgeMs: 60_000,
      neverArmBounceMinDumpPct: 0,
      neverArmBouncePct: 0,
      neverArmFreefallPnlPct: 0,
      neverArmTimeRedMinMs: 0,
      neverArmMaxHoldMs: 0,
    };
    const args = {
      entryPriceUsd: 100,
      peakPriceUsd: 102,
      armed: false,
      gates,
      heldMs: 120_000,
      nowMs: 1_000_000,
      postEntryTroughPriceUsd: 75,
      postEntryTroughAtMs: 910_000,
    };
    const above = evaluateMildDipPeakGiveback({ ...args, markPriceUsd: 81 });
    expect(above.shouldExit).toBe(false);

    const below = evaluateMildDipPeakGiveback({ ...args, markPriceUsd: 79 });
    expect(below.shouldExit).toBe(true);
    expect(below.reason).toBe('hard_stop');
    expect(below.lossExitBounceCap).toBe('drawdown');
    expect(
      mayFireSoftLossExit({
        gates,
        gainPct: -20,
        bounceOffTroughPct: 0,
        troughAgeMs: 60_000,
      }),
    ).toBe(true);
    expect(
      mayFireSoftLossExit({
        gates,
        gainPct: -19.999,
        bounceOffTroughPct: 0,
        troughAgeMs: 60_000,
      }),
    ).toBe(false);
  });

  it('loss trough-age cap releases the bounce wait at the age boundary', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      lossExitMinBouncePct: 12,
      lossExitMaxDrawdownPct: 0,
      lossExitMaxTroughAgeMs: 120_000,
      neverArmBounceMinTroughAgeMs: 60_000,
      neverArmBounceMinDumpPct: 0,
      neverArmBouncePct: 0,
      neverArmFreefallPnlPct: 0,
      neverArmTimeRedMinMs: 0,
      neverArmMaxHoldMs: 0,
    };
    const args = {
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 102,
      armed: false,
      gates,
      heldMs: 120_000,
      nowMs: 1_000_000,
      postEntryTroughPriceUsd: 75,
      postEntryTroughAtMs: 880_000,
    };
    const before = evaluateMildDipPeakGiveback({
      ...args,
      nowMs: 999_999,
    });
    expect(before.shouldExit).toBe(false);

    const atBoundary = evaluateMildDipPeakGiveback(args);
    expect(atBoundary.shouldExit).toBe(true);
    expect(atBoundary.reason).toBe('hard_stop');
    expect(atBoundary.lossExitBounceCap).toBe('trough_age');
  });

  it('a new lower trough resets trough age before the time cap can release', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      lossExitMinBouncePct: 12,
      lossExitMaxDrawdownPct: 0,
      lossExitMaxTroughAgeMs: 120_000,
      neverArmBounceMinTroughAgeMs: 60_000,
      neverArmFreefallPnlPct: 0,
      neverArmTimeRedMinMs: 0,
      neverArmMaxHoldMs: 0,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 74,
      peakPriceUsd: 102,
      armed: false,
      gates,
      heldMs: 300_000,
      nowMs: 1_000_000,
      postEntryTroughPriceUsd: 75,
      postEntryTroughAtMs: 700_000,
    });
    expect(v.postEntryTroughPriceUsd).toBe(74);
    expect(v.postEntryTroughAtMs).toBe(1_000_000);
    expect(v.shouldExit).toBe(false);
  });

  it('bounce caps do not alter the already-allowed gain path', () => {
    expect(
      mayFireSoftLossExit({
        gates: {
          ...exitGates,
          lossExitMinBouncePct: 12,
          lossExitMaxDrawdownPct: 20,
          lossExitMaxTroughAgeMs: 120_000,
        },
        gainPct: 1,
        bounceOffTroughPct: 0,
        troughAgeMs: 0,
      }),
    ).toBe(true);
  });

  it('soft-loss decision is the source of truth behind the boolean wrapper', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      lossExitMinBouncePct: 12,
      lossExitMaxDrawdownPct: 20,
      lossExitMaxTroughAgeMs: 120_000,
      neverArmBounceMinTroughAgeMs: 60_000,
    };
    const args = {
      gates,
      gainPct: -21,
      bounceOffTroughPct: 0,
      troughAgeMs: 10_000,
    };
    const decision = decideSoftLossExit(args);
    expect(decision).toEqual({ allowed: true, reason: 'drawdown' });
    expect(mayFireSoftLossExit(args)).toBe(decision.allowed);

    const blocked = decideSoftLossExit({
      ...args,
      gainPct: -10,
      troughAgeMs: 10_000,
    });
    expect(blocked).toEqual({ allowed: false, reason: null });
    expect(mayFireSoftLossExit({ ...args, gainPct: -10 })).toBe(blocked.allowed);
  });

  it('does not mark a cap when the legacy bounce already allows the exit', () => {
    const decision = decideSoftLossExit({
      gates: {
        ...exitGates,
        lossExitMinBouncePct: 12,
        lossExitMaxDrawdownPct: 20,
        lossExitMaxTroughAgeMs: 120_000,
        neverArmBounceMinTroughAgeMs: 60_000,
      },
      gainPct: -21,
      bounceOffTroughPct: 12,
      troughAgeMs: 60_000,
    });
    expect(decision).toEqual({ allowed: true, reason: null });
  });

  it('1.11.933 — cliff_dump waits for the bounce off the trough', () => {
    const prodLossGates: MildDipExitGates = {
      ...exitGates,
      hardStopPnlPct: 0,
      lossExitMinBouncePct: 12,
      neverArmBounceMinTroughAgeMs: 60_000,
      neverArmBouncePct: 0,
      neverArmFreefallPnlPct: 0,
      neverArmTimeRedMinMs: 0,
      neverArmMaxHoldMs: 0,
    };
    const now = Date.now();
    const atTrough = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 45,
      peakPriceUsd: 100,
      armed: false,
      gates: prodLossGates,
      heldMs: 5_000,
      nowMs: now,
      postEntryTroughPriceUsd: 45,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(atTrough.shouldExit).toBe(false);

    const bounced = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 45,
      peakPriceUsd: 100,
      armed: false,
      gates: prodLossGates,
      heldMs: 5_000,
      nowMs: now,
      postEntryTroughPriceUsd: 40,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(bounced.shouldExit).toBe(true);
    expect(bounced.reason).toBe('cliff_dump');
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

  it.each([40, 60])(
    'hard_stop off leaves an otherwise unqualified armed bag open at −%s%%',
    (drawdown) => {
      const v = evaluateMildDipPeakGiveback({
        entryPriceUsd: 100,
        markPriceUsd: 100 - drawdown,
        peakPriceUsd: 100,
        armed: true,
        gates: {
          ...exitGates,
          hardStopPnlPct: 0,
          cliffDumpPnlPct: 0,
          partialGivebackPct: 0,
          givebackPct: 0,
          neverArmBouncePct: 0,
          neverArmFreefallPnlPct: 0,
          neverArmTimeRedMinMs: 0,
        },
        heldMs: 5_000,
      });
      expect(v.shouldExit).toBe(false);
      expect(v.reason).not.toBe('hard_stop');
    },
  );

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
    expect(v.bounceOffTroughPct).toBeCloseTo(8.125, 3);
    expect(v.troughAgeMs).toBe(90_000);
  });

  it('armed runner bounce is configurable without changing the default', () => {
    const now = 1_000_000;
    const args = {
      entryPriceUsd: 100,
      markPriceUsd: 86.5,
      peakPriceUsd: 102,
      armed: true,
      scaleOutDone: true,
      gates: {
        ...exitGates,
        partialGivebackPct: 0,
        givebackPct: 0,
        hardStopPnlPct: 0,
        cliffDumpPnlPct: 0,
      },
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    } as const;
    const enabled = evaluateMildDipPeakGiveback(args);
    expect(enabled.reason).toBe('never_arm_bounce');
    expect(enabled.fraction).toBe(1);

    const disabled = evaluateMildDipPeakGiveback({
      ...args,
      gates: { ...args.gates, neverArmBounceArmedRunner: false },
    });
    expect(disabled.shouldExit).toBe(false);
    expect(disabled.reason).not.toBe('never_arm_bounce');
  });

  it('never-arm bounce remains active when armed-runner bounce is disabled', () => {
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 86.5,
      peakPriceUsd: 102,
      armed: false,
      gates: { ...exitGates, neverArmBounceArmedRunner: false },
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.reason).toBe('never_arm_bounce');
  });

  it('never_arm_bounce: clears both bounce rungs in one full exit', () => {
    // trough 80; mark 93 = +16.25% off trough, so both 8% and 16% rungs
    // are already earned on the same tick.
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 93,
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
    expect(v.fraction).toBe(1);
  });

  it('never_arm_bounce: red-only config blocks green reclaim but allows red reclaim', () => {
    const now = 1_000_000;
    const gates = {
      ...exitGates,
      neverArmBounceRequireRedPct: 3,
      neverArmBounceMinPnlPct: -1000,
    };
    const green = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105,
      peakPriceUsd: 110,
      armed: false,
      gates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(green.reason).not.toBe('never_arm_bounce');

    const red = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 93,
      peakPriceUsd: 102,
      armed: false,
      gates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(red.reason).toBe('never_arm_bounce');
  });

  it('never_arm_bounce: money-green bags are blocked even when gain is red', () => {
    const now = 1_000_000;
    const gates = {
      ...exitGates,
      markSellHaircutPct: 1,
      neverArmBounceRequireRedPct: 3,
      neverArmBounceMinPnlPct: -1000,
    };
    const moneyGreen = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      entryMarketPriceUsd: 105.43,
      markPriceUsd: 101.51,
      peakPriceUsd: 105.43,
      armed: false,
      gates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(moneyGreen.gainPct).toBeCloseTo(-4.68, 1);
    expect(moneyGreen.pnlPct).toBeCloseTo(1.51, 2);
    expect(moneyGreen.reason).not.toBe('never_arm_bounce');

    const moneyRed = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      entryMarketPriceUsd: 105.43,
      markPriceUsd: 97,
      peakPriceUsd: 105.43,
      armed: false,
      gates,
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(moneyRed.pnlPct).toBeCloseTo(-3, 2);
    expect(moneyRed.reason).toBe('never_arm_bounce');
  });

  it('never_arm_bounce: zero partial fraction remains a full first exit', () => {
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 86.5,
      peakPriceUsd: 102,
      armed: false,
      gates: { ...exitGates, neverArmBouncePartialFraction: 0 },
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.reason).toBe('never_arm_bounce');
    expect(v.fraction).toBe(1);
  });

  it('never_arm_bounce: 15% reclaim is below an 18% configured threshold', () => {
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 92,
      peakPriceUsd: 102,
      armed: false,
      gates: { ...exitGates, neverArmBouncePct: 18 },
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.bounceOffTroughPct).toBeCloseTo(15, 8);
    expect(v.reason).not.toBe('never_arm_bounce');
  });

  it('never_arm_bounce: 18% reclaim fires the configured first cut', () => {
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 94.4,
      peakPriceUsd: 102,
      armed: false,
      gates: { ...exitGates, neverArmBouncePct: 18 },
      heldMs: 180_000,
      nowMs: now,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 90_000,
    });
    expect(v.bounceOffTroughPct).toBeCloseTo(18, 8);
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

  it('1.11.948 — dead-set waits for a deeper loss and a 10% reclaim', () => {
    const deadSetGates: MildDipExitGates = {
      ...exitGates,
      deadSetVolFadeFrac: 0.25,
      deadSetTurnFadeFrac: 0.25,
      deadSetMinDropPct: 15,
      deadSetBouncePct: 10,
      deadSetMinHoldMs: 900_000,
      hardStopPnlPct: 30,
      lossExitMinBouncePct: 0,
    };
    const markAtMinus12 = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 88,
      peakPriceUsd: 100,
      armed: true,
      gates: deadSetGates,
      heldMs: 1_000_000,
      volume5mUsd: 2_000,
      entryVolume5mUsd: 10_000,
      turnover5mLiq: 0.2,
      entryTurnover5mLiq: 1,
      postEntryTroughPriceUsd: 83.0188679245,
      postEntryTroughAtMs: 1,
      nowMs: 1_000_001,
    });
    expect(markAtMinus12.reason).not.toBe('dead_set_bounce');

    const markAtMinus16 = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 84,
      peakPriceUsd: 100,
      armed: true,
      gates: deadSetGates,
      heldMs: 1_000_000,
      volume5mUsd: 2_000,
      entryVolume5mUsd: 10_000,
      turnover5mLiq: 0.2,
      entryTurnover5mLiq: 1,
      postEntryTroughPriceUsd: 76.3636363636,
      postEntryTroughAtMs: 1,
      nowMs: 1_000_001,
    });
    expect(markAtMinus16.reason).toBe('dead_set_bounce');
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

  it('tp_grid closes the first rung fully when the floor exceeds the remainder', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      tpGridStepPct: 8,
      tpGridSellFraction: 0.5,
      tpGridMinRemainderFraction: 0.6,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 108,
      armed: true,
      gates,
      tpRungsDone: 0,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('tp_grid');
    expect(v.fraction).toBe(1);
    expect(v.tpRungIndex).toBe(1);
  });

  it('tp_grid gives later floor-breaching rungs to the trail', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      tpGridStepPct: 8,
      tpGridSellFraction: 0.5,
      tpGridMinRemainderFraction: 0.6,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 116,
      peakPriceUsd: 116,
      armed: true,
      gates,
      tpRungsDone: 1,
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).not.toBe('tp_grid');
  });

  it('tp_grid keeps its partial first rung when the remainder clears the floor', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      tpGridStepPct: 8,
      tpGridSellFraction: 0.5,
      tpGridMinRemainderFraction: 0.2,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 108,
      armed: true,
      gates,
      tpRungsDone: 0,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('tp_grid');
    expect(v.fraction).toBe(0.5);
    expect(v.tpRungIndex).toBe(1);
  });

  it('tp_grid first rung can wait until +20%', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      tpGridStepPct: 8,
      tpGridFirstRungPct: 20,
      tpGridSellFraction: 0.5,
      tpGridMinRemainderFraction: 0,
    };
    const below = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 112,
      peakPriceUsd: 112,
      armed: true,
      gates,
      tpRungsDone: 0,
    });
    expect(below.shouldExit).toBe(false);

    const first = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 120,
      peakPriceUsd: 120,
      armed: true,
      gates,
      tpRungsDone: 0,
    });
    expect(first.reason).toBe('tp_grid');
    expect(first.tpRungIndex).toBe(1);
    expect(first.fraction).toBe(0.5);
  });

  it('tp_grid first rung catches up to rungs 1–3 in one sale', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      tpGridStepPct: 8,
      tpGridFirstRungPct: 20,
      tpGridSellFraction: 0.34,
      tpGridMinRemainderFraction: 0,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 137,
      peakPriceUsd: 137,
      armed: true,
      gates,
      tpRungsDone: 0,
    });
    expect(v.reason).toBe('tp_grid');
    expect(v.tpRungIndex).toBe(3);
    expect(v.fraction).toBeCloseTo(1 - 0.66 ** 3, 10);
  });

  it('fill coverage helper makes +58.8% cover rung 5, leaving +60% next', () => {
    const gates = { tpGridStepPct: 8, tpGridFirstRungPct: 20 };
    expect(tpRungsCoveredByGainPct(gates, 58.8)).toBe(5);
    expect(tpRungsCoveredByGainPct(gates, 59.99)).toBe(5);
    expect(tpRungsCoveredByGainPct(gates, 60)).toBe(6);
  });

  it('disabled TP-grid gap preserves the next rung decision', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 120,
      peakPriceUsd: 120,
      armed: true,
      gates: { ...exitGates, tpGridStepPct: 8, tpGridMinGapMs: 0 },
      tpRungsDone: 0,
      nowMs: 20_000,
      lastTpGridFillAtMs: 19_999,
    });
    expect(v.reason).toBe('tp_grid');
  });

  it('exhausted TP-grid runner uses the tighter giveback', () => {
    const base = {
      entryPriceUsd: 100,
      markPriceUsd: 170,
      peakPriceUsd: 200,
      armed: true,
      scaleOutDone: true,
      tpRungsDone: 5,
      gates: {
        ...exitGates,
        tpGridStepPct: 8,
        tpGridSellFraction: 0.34,
        tpGridMinRemainderFraction: 0.1,
        mfeBankSleeveGivebackPct: 0,
        mfeBankSleeveGreenPartialFraction: 0.2,
        mfeBankSleeveRunnerGivebackPct: 25,
        mfeBankSleeveRunnerGivebackExhaustedPct: 10,
      },
    };
    const tight = evaluateMildDipPeakGiveback(base);
    expect(tight.reason).toBe('peak_giveback');
    const ordinary = evaluateMildDipPeakGiveback({
      ...base,
      gates: { ...base.gates, mfeBankSleeveRunnerGivebackExhaustedPct: 0 },
    });
    expect(ordinary.shouldExit).toBe(false);
  });

  it('keeps exhausted runner tight when no new rung is owed', () => {
    const base = {
      entryPriceUsd: 100,
      markPriceUsd: 150,
      peakPriceUsd: 180,
      armed: true,
      scaleOutDone: true,
      tpRungsDone: 5,
      gates: {
        ...exitGates,
        tpGridStepPct: 8,
        tpGridSellFraction: 0.34,
        tpGridMinRemainderFraction: 0.1,
        mfeBankSleeveGivebackPct: 0,
        mfeBankSleeveGreenPartialFraction: 0.2,
        mfeBankSleeveRunnerGivebackPct: 25,
        mfeBankSleeveRunnerGivebackExhaustedPct: 10,
      },
    };
    expect(evaluateMildDipPeakGiveback(base).reason).toBe('peak_giveback');
    expect(
      evaluateMildDipPeakGiveback({
        ...base,
        gates: { ...base.gates, mfeBankSleeveRunnerGivebackExhaustedPct: 0 },
      }).shouldExit,
    ).toBe(false);
  });

  it('tp_grid first rung 0 preserves the step-sized first rung', () => {
    const gates: MildDipExitGates = {
      ...exitGates,
      tpGridStepPct: 8,
      tpGridFirstRungPct: 0,
      tpGridSellFraction: 0.5,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 108,
      armed: true,
      gates,
      tpRungsDone: 0,
    });
    expect(v.reason).toBe('tp_grid');
    expect(v.tpRungIndex).toBe(1);
  });

  it('green sleeve uses live peak retracement when loss bounce is enabled', () => {
    const gates: MildDipExitGates = {
      ...bankGates,
      lossExitMinBouncePct: 12,
      mfeBankSleeveGivebackPct: 12,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 110,
      peakPriceUsd: 120,
      armed: true,
      mfeBankStage: 2,
      gates,
      postEntryTroughPriceUsd: 100,
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).not.toBe('mfe_bank_sleeve');
  });

  it('green sleeve exits fully once live peak retracement reaches its width', () => {
    const gates: MildDipExitGates = {
      ...bankGates,
      lossExitMinBouncePct: 12,
      mfeBankSleeveGivebackPct: 12,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.6,
      peakPriceUsd: 120,
      armed: true,
      mfeBankStage: 2,
      gates,
      postEntryTroughPriceUsd: 100,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(1);
  });

  it('1.11.949 — green sleeve can leave a runner before any scale-out', () => {
    const gates: MildDipExitGates = {
      ...bankGates,
      mfeBankSleeveGreenPartialFraction: 0.5,
      lossExitMinBouncePct: 12,
      mfeBankSleeveGivebackPct: 12,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.6,
      peakPriceUsd: 120,
      armed: true,
      scaleOutDone: false,
      mfeBankStage: 2,
      gates,
      postEntryTroughPriceUsd: 100,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(0.5);
  });

  it('green sleeve does not fire again after a scale-out', () => {
    const gates: MildDipExitGates = {
      ...bankGates,
      mfeBankSleeveGreenPartialFraction: 0.5,
      lossExitMinBouncePct: 12,
      mfeBankSleeveGivebackPct: 12,
    };
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.6,
      peakPriceUsd: 120,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 2,
      gates,
      postEntryTroughPriceUsd: 100,
    });
    expect(v.reason).not.toBe('mfe_bank_sleeve');
  });

  it('1.11.953 — green sleeve runner holds at −10% and exits at −26%', () => {
    const gates: MildDipExitGates = {
      ...bankGates,
      mfeBankSleeveGreenPartialFraction: 0.5,
      mfeBankSleeveRunnerGivebackPct: 25,
      mfeBankSleeveGivebackPct: 8,
    };
    const held = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 135,
      peakPriceUsd: 150,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 2,
      gates,
    });
    expect(held.givebackPct).toBeCloseTo(-10, 6);
    expect(held.shouldExit).toBe(false);

    const trailed = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 111,
      peakPriceUsd: 150,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 2,
      gates,
    });
    expect(trailed.givebackPct).toBeCloseTo(-26, 6);
    expect(trailed.reason).toBe('peak_giveback');
    expect(trailed.fraction).toBe(1);
  });

  it('1.11.953 — runner width 0 keeps the green remainder unsold', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 111,
      peakPriceUsd: 150,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 2,
      gates: {
        ...bankGates,
        mfeBankSleeveGreenPartialFraction: 0.5,
        mfeBankSleeveRunnerGivebackPct: 0,
        mfeBankSleeveGivebackPct: 8,
      },
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).not.toBe('peak_giveback');
  });

  it('1.11.953 — runner cannot tighten the existing sleeve width', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 141,
      peakPriceUsd: 150,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 2,
      gates: {
        ...bankGates,
        mfeBankSleeveGreenPartialFraction: 0.5,
        mfeBankSleeveRunnerGivebackPct: 4,
        mfeBankSleeveGivebackPct: 8,
      },
    });
    expect(v.givebackPct).toBeCloseTo(-6, 6);
    expect(v.shouldExit).toBe(false);
  });

  it('1.11.953 — runner trail does not change red sleeve behavior', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 90,
      peakPriceUsd: 150,
      armed: true,
      scaleOutDone: false,
      mfeBankStage: 2,
      gates: {
        ...bankGates,
        mfeBankSleeveRunnerGivebackPct: 25,
        mfeBankSleeveGivebackPct: 8,
      },
    });
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(0.5);
  });

  it('default green sleeve fraction 0 keeps the full-bag exit', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.6,
      peakPriceUsd: 120,
      armed: true,
      scaleOutDone: false,
      mfeBankStage: 2,
      gates: { ...bankGates, lossExitMinBouncePct: 12, mfeBankSleeveGivebackPct: 12 },
      postEntryTroughPriceUsd: 100,
    });
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(1);
  });

  it('default green sleeve fraction 0 keeps full exit after scale-out', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.6,
      peakPriceUsd: 120,
      armed: true,
      scaleOutDone: true,
      mfeBankStage: 2,
      gates: { ...bankGates, lossExitMinBouncePct: 12, mfeBankSleeveGivebackPct: 12 },
      postEntryTroughPriceUsd: 100,
    });
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

  it('underwater sleeve with loss partial 0 exits the full bag once after reclaim', () => {
    const now = 1_000_000;
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 89.6,
      peakPriceUsd: 112,
      armed: true,
      mfeBankStage: 1,
      gates: {
        ...bankGates,
        lossExitMinBouncePct: 12,
        mfeBankSleeveGivebackPct: 12,
        mfeBankSleeveLossPartialFraction: 0,
      },
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 120_000,
      nowMs: now,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(1);
  });

  it('underwater sleeve keeps trough hit and bounce gating with loss bounce enabled', () => {
    const now = 1_000_000;
    const gates: MildDipExitGates = {
      ...bankGates,
      lossExitMinBouncePct: 12,
      mfeBankSleeveGivebackPct: 12,
    };
    const atTrough = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 112,
      armed: true,
      mfeBankStage: 1,
      gates,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 120_000,
      nowMs: now,
    });
    expect(atTrough.shouldExit).toBe(false);

    const bounced = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 89.6,
      peakPriceUsd: 112,
      armed: true,
      mfeBankStage: 1,
      gates,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: now - 120_000,
      nowMs: now,
    });
    expect(bounced.shouldExit).toBe(true);
    expect(bounced.reason).toBe('mfe_bank_sleeve');
    expect(bounced.fraction).toBe(0.5);
  });

  it('lossExitMinBouncePct blocks underwater sleeve at the trough', () => {
    const now = 1_000_000;
    const bounceGates: MildDipExitGates = { ...bankGates, lossExitMinBouncePct: 3 };
    const atTrough = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 95,
      peakPriceUsd: 112,
      armed: true,
      mfeBankStage: 1,
      gates: bounceGates,
      postEntryTroughPriceUsd: 95,
      postEntryTroughAtMs: now - 120_000,
      nowMs: now,
    });
    expect(atTrough.shouldExit).toBe(false);

    const bounced = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 97.85,
      peakPriceUsd: 112,
      armed: true,
      mfeBankStage: 1,
      gates: bounceGates,
      postEntryTroughPriceUsd: 95,
      postEntryTroughAtMs: now - 120_000,
      nowMs: now,
    });
    expect(bounced.shouldExit).toBe(true);
    expect(bounced.reason).toBe('mfe_bank_sleeve');
    expect(bounced.fraction).toBe(0.5);
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

  it('AzXuLS: underwater mfe_bank_sleeve waits for bounce off trough (1.11.920)', () => {
    const bounceGates: MildDipExitGates = { ...bankGates, lossExitMinBouncePct: 3 };
    const now = 1_000_000;
    const entry = 0.00007848858906012518;
    const peak = 0.00008352;
    const trough = 0.0000666031139908646;
    const atKnife = evaluateMildDipPeakGiveback({
      entryPriceUsd: entry,
      markPriceUsd: trough,
      peakPriceUsd: peak,
      armed: true,
      mfeBankStage: 1,
      gates: bounceGates,
      heldMs: 1_154_000,
      nowMs: now,
      postEntryTroughPriceUsd: trough,
      postEntryTroughAtMs: now - 5_000,
    });
    expect(atKnife.reason).not.toBe('mfe_bank_sleeve');

    const bounced = evaluateMildDipPeakGiveback({
      entryPriceUsd: entry,
      markPriceUsd: trough * 1.04,
      peakPriceUsd: peak,
      armed: true,
      mfeBankStage: 1,
      gates: bounceGates,
      heldMs: 1_160_000,
      nowMs: now + 6_000,
      postEntryTroughPriceUsd: trough,
      postEntryTroughAtMs: now - 120_000,
    });
    expect(bounced.shouldExit).toBe(true);
    expect(bounced.reason).toBe('mfe_bank_sleeve');
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

describe('mildDipLiquidityPowerLawSizeUsd', () => {
  const law = { coef: 0.0004168, exp: 0.866, minUsd: 1, maxUsd: 30 };
  const productionLaw = { ...law, minUsd: 3 };

  it('anchors ~$1 at $8k liq (entry floor)', () => {
    expect(mildDipLiquidityPowerLawSizeUsd(8_000, law)).toBeCloseTo(1, 2);
  });

  it('scales up with liquidity and caps at $30', () => {
    expect(mildDipLiquidityPowerLawSizeUsd(50_000, law)).toBeCloseTo(4.89, 1);
    expect(mildDipLiquidityPowerLawSizeUsd(100_000, law)).toBeCloseTo(8.91, 1);
    expect(mildDipLiquidityPowerLawSizeUsd(500_000, law)).toBe(30);
    expect(mildDipLiquidityPowerLawSizeUsd(1_000_000, law)).toBe(30);
  });

  it('clamps sub-$1 raw values to minUsd', () => {
    expect(mildDipLiquidityPowerLawSizeUsd(1_000, law)).toBe(1);
  });

  it('clamps the production law to $3 without changing its formula', () => {
    expect(mildDipLiquidityPowerLawSizeUsd(14_000, productionLaw)).toBe(3);
    expect(mildDipLiquidityPowerLawSizeUsd(1_000, productionLaw)).toBe(3);
  });
});

describe('resolveMildDipWantedSizeUsd (liquidity power law)', () => {
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
  const liqPowerLaw = { coef: 0.0004168, exp: 0.866, minUsd: 1, maxUsd: 30 };

  it('uses power law size but keeps thick tier label', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 3,
      liqPowerLaw,
      thick,
      micro,
      metrics: { liquidityUsd: 100_000, marketCapUsd: 200_000, pairAgeHours: 12 },
    });
    expect(v.tier).toBe('thick');
    expect(v.sizeUsd).toBeCloseTo(8.91, 1);
  });

  it('uses power law for micro tier band', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 3,
      liqPowerLaw,
      thick,
      micro,
      metrics: { liquidityUsd: 12_000, marketCapUsd: 30_000, pairAgeHours: 1 },
    });
    expect(v.tier).toBe('micro');
    expect(v.sizeUsd).toBeCloseTo(1.42, 1);
  });

  it('falls back to flat tiers when power law coef is 0', () => {
    const v = resolveMildDipWantedSizeUsd({
      basePositionUsd: 10,
      liqPowerLaw: { ...liqPowerLaw, coef: 0 },
      thick,
      micro,
      metrics: { liquidityUsd: 50_000, marketCapUsd: 100_000, pairAgeHours: 6 },
    });
    expect(v).toEqual({ sizeUsd: 20, tier: 'thick' });
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
