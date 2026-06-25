import { describe, expect, it } from 'vitest';
import {
  entrySplitBandOk,
  entrySplitCorridorBlocked,
  entrySplitLeg2Eligible,
  liveStagedEntryAddWindowOpen,
  liveStagedEntryHasPendingLegs,
  liveStagedEntryTtlPreservesPlan,
  liveStagedEntrySignalTimeWindowOpen,
  liveStagedEntrySignalTtlExpired,
  planLiveStagedEntrySignalResolution,
  reconcileEntrySplitV2FromLegs,
  stagedAvgFirstEligible,
  stagedAvgSecondEligible,
} from '../src/papertrader/executor/live-staged-entry-gates.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { LiveStagedEntryState, OpenTrade, PartialSell } from '../src/papertrader/types.js';

function baseSt(): LiveStagedEntryState {
  return {
    signalTs: 1_000_000,
    signalPriceUsd: 1,
    firstDropPct: 0,
    firstLegUsd: 500,
    secondDropPct: 7,
    secondLegUsd: 150,
    thirdDropPct: 14,
    thirdLegUsd: 150,
    killDropPct: 23,
    entrySplitV2: true,
    entrySplitLeg1Ts: 1_000_000,
    avgSecondDropPct: 7,
    avgThirdDropPct: 14,
    avgFirstCooldownMs: 180_000,
    avgSecondCooldownMs: 300_000,
  };
}

const ttlCfg = (ttlMs: number) =>
  ({ liveStagedEntrySignalTtlMs: ttlMs }) as Pick<PaperTraderConfig, 'liveStagedEntrySignalTtlMs'>;

describe('liveStagedEntrySignalTtl', () => {
  it('ttl 0 never expires and window stays open', () => {
    const cfg = ttlCfg(0);
    const signalTs = 1_000_000;
    const far = signalTs + 365 * 24 * 3600_000;
    expect(liveStagedEntrySignalTtlExpired(cfg, signalTs, far)).toBe(false);
    expect(liveStagedEntrySignalTimeWindowOpen(cfg, signalTs, far)).toBe(true);
  });

  it('positive ttl closes window after deadline', () => {
    const cfg = ttlCfg(60_000);
    const signalTs = 1_000_000;
    expect(liveStagedEntrySignalTimeWindowOpen(cfg, signalTs, signalTs + 59_000)).toBe(true);
    expect(liveStagedEntrySignalTtlExpired(cfg, signalTs, signalTs + 61_000)).toBe(true);
  });
});

describe('planLiveStagedEntrySignalResolution', () => {
  const ttlCfg1h = ttlCfg(3_600_000);
  const anchor = {
    signalTs: 1_000_000,
    signalPriceUsd: 1,
    signalMarketCapUsd: 50_000,
    holderCount: 100,
    expiresAt: 1_000_000 + 3_600_000,
  };

  it('clears expired anchor instead of re-anchoring at current price', () => {
    const now = anchor.expiresAt + 1;
    const plan = planLiveStagedEntrySignalResolution({
      existing: anchor,
      now,
      currentPriceUsd: 1.05,
      marketCapUsd: 55_000,
      holderCount: 110,
      reanchorBlocked: false,
      cfg: ttlCfg1h,
    });
    expect(plan.action).toBe('ttl_expired_clear');
    if (plan.action === 'ttl_expired_clear') {
      expect(plan.expired.signalPriceUsd).toBe(1);
    }
  });

  it('preserves expired anchor when re-anchor blocked (buy in-flight)', () => {
    const now = anchor.expiresAt + 1;
    const plan = planLiveStagedEntrySignalResolution({
      existing: anchor,
      now,
      currentPriceUsd: 1.05,
      marketCapUsd: 55_000,
      holderCount: 110,
      reanchorBlocked: true,
      cfg: ttlCfg1h,
    });
    expect(plan.action).toBe('use_existing');
    if (plan.action === 'use_existing') {
      expect(plan.signal.signalPriceUsd).toBe(1);
    }
  });

  it('creates fresh anchor only when no prior signal exists', () => {
    const now = 2_000_000;
    const plan = planLiveStagedEntrySignalResolution({
      existing: undefined,
      now,
      currentPriceUsd: 0.9,
      marketCapUsd: 40_000,
      holderCount: 80,
      reanchorBlocked: false,
      cfg: ttlCfg1h,
    });
    expect(plan.action).toBe('create_new');
    if (plan.action === 'create_new') {
      expect(plan.signal.signalPriceUsd).toBe(0.9);
      expect(plan.signal.expiresAt).toBe(now + 3_600_000);
    }
  });

  it('after TTL clear, next discovery pass may create new anchor (not same-tick re-anchor)', () => {
    const now = anchor.expiresAt + 1;
    const expired = planLiveStagedEntrySignalResolution({
      existing: anchor,
      now,
      currentPriceUsd: 1.05,
      marketCapUsd: 55_000,
      holderCount: 110,
      reanchorBlocked: false,
      cfg: ttlCfg1h,
    });
    expect(expired.action).toBe('ttl_expired_clear');

    const later = now + 60_000;
    const fresh = planLiveStagedEntrySignalResolution({
      existing: undefined,
      now: later,
      currentPriceUsd: 1.05,
      marketCapUsd: 55_000,
      holderCount: 110,
      reanchorBlocked: false,
      cfg: ttlCfg1h,
    });
    expect(fresh.action).toBe('create_new');
    if (fresh.action === 'create_new') {
      expect(fresh.signal.signalPriceUsd).toBe(1.05);
      expect(fresh.signal.signalTs).toBe(later);
    }
  });

  it('keeps valid anchor while waiting for first-leg dip', () => {
    const plan = planLiveStagedEntrySignalResolution({
      existing: anchor,
      now: anchor.signalTs + 30 * 60_000,
      currentPriceUsd: 0.95,
      marketCapUsd: 48_000,
      holderCount: 95,
      reanchorBlocked: false,
      cfg: ttlCfg1h,
    });
    expect(plan.action).toBe('use_existing');
  });
});

describe('entrySplitLeg2Eligible', () => {
  it('dip mode: fills at −5% from signal without delay', () => {
    const st = { ...baseSt(), entrySplitTargetDropPct: 5 };
    expect(
      entrySplitLeg2Eligible({
        st,
        signalDropPct: -4.9,
        nowMs: st.entrySplitLeg1Ts! + 1000,
        entrySplitPx: 0.95,
        anchorUsd: 1,
      }).ok,
    ).toBe(false);
    const hit = entrySplitLeg2Eligible({
      st,
      signalDropPct: -5.1,
      nowMs: st.entrySplitLeg1Ts! + 1000,
      entrySplitPx: 0.949,
      anchorUsd: 1,
    });
    expect(hit.ok).toBe(true);
    expect(hit.triggerPct).toBeCloseTo(-0.051, 4);
  });

  it('legacy corridor: requires delay and band', () => {
    const st = { ...baseSt(), entrySplitTargetDropPct: 0 };
    expect(
      entrySplitLeg2Eligible({
        st,
        signalDropPct: -5,
        nowMs: st.entrySplitLeg1Ts! + 5000,
        entrySplitPx: 0.98,
        anchorUsd: 1,
      }).ok,
    ).toBe(false);
    expect(
      entrySplitLeg2Eligible({
        st,
        signalDropPct: 0,
        nowMs: st.entrySplitLeg1Ts! + 200_000,
        entrySplitPx: 1.02,
        anchorUsd: 1,
      }).ok,
    ).toBe(true);
  });
});

describe('entrySplitBandOk', () => {
  it('allows +3% and -10%', () => {
    expect(entrySplitBandOk(3, 3, 10)).toBe(true);
    expect(entrySplitBandOk(-10, 3, 10)).toBe(true);
    expect(entrySplitBandOk(3.1, 3, 10)).toBe(false);
    expect(entrySplitBandOk(-10.1, 3, 10)).toBe(false);
  });
});

describe('entrySplitCorridorBlocked', () => {
  function otWithPartials(reasons: Array<PartialSell['reason']>): OpenTrade {
    return {
      partialSells: reasons.map((reason) => ({ reason })),
      liveStagedEntry: baseSt(),
      legs: [],
    } as unknown as OpenTrade;
  }

  it('blocks only on TP_LADDER partials, not breakeven/trail/derisk', () => {
    expect(entrySplitCorridorBlocked(otWithPartials(['TP_LADDER']))).toBe(true);
    expect(entrySplitCorridorBlocked(otWithPartials(['BREAKEVEN_TRIM']))).toBe(false);
    expect(entrySplitCorridorBlocked(otWithPartials(['TRAIL_STEP']))).toBe(false);
    expect(entrySplitCorridorBlocked(otWithPartials(['WAVE_B_POST_TP1_DERISK']))).toBe(false);
    expect(entrySplitCorridorBlocked(otWithPartials(['WAVE_B_BREAKEVEN_INSURANCE']))).toBe(false);
    expect(entrySplitCorridorBlocked({ partialSells: [], liveStagedEntry: baseSt(), legs: [] } as unknown as OpenTrade)).toBe(false);
  });

  it('blocks after first staged avg leg', () => {
    const st = baseSt();
    const ot = {
      partialSells: [],
      liveStagedEntry: { ...st, avgFirstLegDone: true },
      legs: [{ reason: 'staged_avg' }],
    } as unknown as OpenTrade;
    expect(entrySplitCorridorBlocked(ot)).toBe(true);
  });
});

describe('entrySplitCorridorRetry', () => {
  it('allows leg2 after delay when price re-enters corridor (not one-shot)', () => {
    const st = { ...baseSt(), entrySplitTargetDropPct: 0, entrySplitMaxUpPct: 3, entrySplitMaxDownPct: 5 };
    const leg1Ts = st.entrySplitLeg1Ts!;
    const anchor = 1;
    const outside = entrySplitLeg2Eligible({
      st,
      signalDropPct: 0,
      nowMs: leg1Ts + 15_000,
      entrySplitPx: 1.04,
      anchorUsd: anchor,
    });
    expect(outside.ok).toBe(false);
    const inside = entrySplitLeg2Eligible({
      st,
      signalDropPct: 0,
      nowMs: leg1Ts + 180_000,
      entrySplitPx: 1.02,
      anchorUsd: anchor,
    });
    expect(inside.ok).toBe(true);
  });
});

describe('stagedAvgFirstEligible', () => {
  it('requires cooldown and drop between -7% and -14%', () => {
    const st = baseSt();
    expect(stagedAvgFirstEligible({ st, signalDropPct: -8, nowMs: st.entrySplitLeg1Ts! + 179_000 })).toBe(false);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -8, nowMs: st.entrySplitLeg1Ts! + 180_000 })).toBe(true);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -15, nowMs: st.entrySplitLeg1Ts! + 200_000 })).toBe(false);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -5, nowMs: st.entrySplitLeg1Ts! + 200_000 })).toBe(false);
  });
});

describe('stagedAvgSecondEligible', () => {
  it('requires 5m after first avg and drop <= -14%', () => {
    const st = { ...baseSt(), avgFirstLegDone: true, avgFirstLegTs: 2_000_000 };
    expect(stagedAvgSecondEligible({ st, signalDropPct: -15, nowMs: 2_299_000 })).toBe(false);
    expect(stagedAvgSecondEligible({ st, signalDropPct: -15, nowMs: 2_300_000 })).toBe(true);
    expect(stagedAvgSecondEligible({ st, signalDropPct: -10, nowMs: 2_400_000 })).toBe(false);
  });
});

describe('stagedEntryThreeLegProgression', () => {
  it('leg2 at −5%, leg3 at −10% with zero cooldown', () => {
    const st = {
      ...baseSt(),
      firstDropPct: 0,
      firstLegUsd: 200,
      entrySplitLegUsd: 200,
      entrySplitLeg2Usd: 200,
      entrySplitTargetDropPct: 5,
      entrySplitLeg2Done: false,
      avgSecondDropPct: 10,
      avgSecondLegUsd: 300,
      secondDropPct: 10,
      secondLegUsd: 300,
      thirdDropPct: 0,
      thirdLegUsd: 0,
      avgFirstCooldownMs: 0,
      avgFirstLegDone: false,
    };

    expect(
      entrySplitLeg2Eligible({
        st,
        signalDropPct: -4.9,
        nowMs: st.entrySplitLeg1Ts! + 1000,
        entrySplitPx: 0.951,
        anchorUsd: 1,
      }).ok,
    ).toBe(false);
    expect(
      entrySplitLeg2Eligible({
        st,
        signalDropPct: -5.1,
        nowMs: st.entrySplitLeg1Ts! + 1000,
        entrySplitPx: 0.949,
        anchorUsd: 1,
      }).ok,
    ).toBe(true);

    expect(stagedAvgFirstEligible({ st, signalDropPct: -9.9, nowMs: st.entrySplitLeg1Ts! })).toBe(false);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -10, nowMs: st.entrySplitLeg1Ts! })).toBe(true);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -10.1, nowMs: st.entrySplitLeg1Ts! })).toBe(true);

    st.avgFirstLegDone = true;
    expect(stagedAvgFirstEligible({ st, signalDropPct: -10.1, nowMs: st.entrySplitLeg1Ts! })).toBe(false);
  });
});

describe('liveStagedEntryInPositionTtl', () => {
  const ttlCfg1h = ttlCfg(3_600_000);
  const signalTs = 1_000_000;
  const afterTtl = signalTs + 3_600_000 + 28 * 60_000;

  it('preserves staged plan after TTL when entry split done but avg @ -10% pending (SOLANGELES)', () => {
    const st = {
      ...baseSt(),
      entrySplitLeg2Done: true,
      avgSecondDropPct: 10,
      avgSecondLegUsd: 300,
      avgFirstLegDone: false,
      secondLegDone: false,
    };
    expect(liveStagedEntryHasPendingLegs(st)).toBe(true);
    expect(liveStagedEntryTtlPreservesPlan(st)).toBe(true);
    expect(
      liveStagedEntryAddWindowOpen({ cfg: ttlCfg1h, st, signalTs, nowMs: afterTtl }),
    ).toBe(true);
  });

  it('preserves staged plan after TTL while entry split leg2 still pending', () => {
    const st = { ...baseSt(), entrySplitTargetDropPct: 5, entrySplitLeg2Done: false };
    expect(liveStagedEntryHasPendingLegs(st)).toBe(true);
    expect(liveStagedEntryTtlPreservesPlan(st)).toBe(true);
    expect(
      liveStagedEntryAddWindowOpen({ cfg: ttlCfg1h, st, signalTs, nowMs: afterTtl }),
    ).toBe(true);
  });

  it('allows TTL clear once all staged legs complete on open trade', () => {
    const st = {
      ...baseSt(),
      entrySplitLeg2Done: true,
      avgFirstLegDone: true,
      avgSecondLegDone: true,
      secondLegDone: true,
      thirdLegDone: true,
    };
    expect(liveStagedEntryHasPendingLegs(st)).toBe(false);
    expect(liveStagedEntryTtlPreservesPlan(st)).toBe(false);
    expect(
      liveStagedEntryAddWindowOpen({ cfg: ttlCfg1h, st, signalTs, nowMs: afterTtl }),
    ).toBe(false);
  });

  it('pre-entry TTL still expires discovery anchor (unchanged)', () => {
    const anchor = {
      signalTs,
      signalPriceUsd: 1,
      signalMarketCapUsd: 50_000,
      holderCount: 100,
      expiresAt: signalTs + 3_600_000,
    };
    const plan = planLiveStagedEntrySignalResolution({
      existing: anchor,
      now: afterTtl,
      currentPriceUsd: 0.9,
      marketCapUsd: 45_000,
      holderCount: 90,
      reanchorBlocked: false,
      cfg: ttlCfg1h,
    });
    expect(plan.action).toBe('ttl_expired_clear');
  });
});

describe('reconcileEntrySplitV2FromLegs', () => {
  it('marks entrySplitLeg2Done when entry_split leg exists after restore', () => {
    const st = { ...baseSt(), entrySplitLeg2Done: false };
    const ot = {
      legs: [
        { ts: 1, price: 0.123, marketPrice: 0.1229, sizeUsd: 500, reason: 'open' },
        { ts: 2, price: 0.124, marketPrice: 0.1233, sizeUsd: 500, reason: 'entry_split', triggerPct: 0.003 },
      ],
      liveStagedEntry: st,
    } as unknown as OpenTrade;
    reconcileEntrySplitV2FromLegs(ot);
    expect(st.entrySplitLeg2Done).toBe(true);
  });
});
