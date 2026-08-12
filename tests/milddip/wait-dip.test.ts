import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateWaitDipPreBuy,
  evaluateWaitDipReady,
  isRebuyBelowExitWindow,
  shouldParkWaitDip,
  upsertWaitDipWatch,
  waitDipAppliesToSource,
  waitDipMaxPriceUsd,
  waitDipTargetPriceUsd,
  type WaitDipGates,
} from '../../src/milddip/wait-dip.js';
import type { MildDipCandidateMetrics } from '../../src/milddip/gates.js';

const metrics: MildDipCandidateMetrics = {
  priceChange5mPct: -12,
  volume5mUsd: 5_000,
  liquidityUsd: 40_000,
  marketCapUsd: 200_000,
  pairAgeHours: 2,
  dexId: 'pumpswap',
  buys5m: 10,
  sells5m: 20,
  volume1hUsd: 50_000,
  priceChange1hPct: -15,
};

const gates: WaitDipGates = {
  enabled: true,
  waitDipPct: -7,
  maxWatchMs: 1_200_000,
};

describe('waitDipAppliesToSource', () => {
  it('parks main-band only; skips h1 / stabilize / wait_dip', () => {
    expect(waitDipAppliesToSource('dex')).toBe(true);
    expect(waitDipAppliesToSource('dex+stream')).toBe(true);
    expect(waitDipAppliesToSource('stream')).toBe(true);
    expect(waitDipAppliesToSource('flat_micro_dip')).toBe(true);
    expect(waitDipAppliesToSource('h1_red_shallow')).toBe(false);
    expect(waitDipAppliesToSource('knife_stabilize')).toBe(false);
    expect(waitDipAppliesToSource('mild_stabilize')).toBe(false);
    expect(waitDipAppliesToSource('wait_dip')).toBe(false);
    expect(waitDipAppliesToSource(null)).toBe(false);
  });
});

describe('shouldParkWaitDip / rebuy window', () => {
  const nowMs = 1_000_000;
  const base = {
    nowMs,
    rebuyBelowExitPct: 10,
    rebuyBelowExitMaxAgeMs: 900_000,
  };

  it('isRebuyBelowExitWindow only inside max age with pct>0', () => {
    expect(
      isRebuyBelowExitWindow({
        ...base,
        lastExitAtMs: nowMs - 60_000,
      }),
    ).toBe(true);
    expect(
      isRebuyBelowExitWindow({
        ...base,
        lastExitAtMs: nowMs - 901_000,
      }),
    ).toBe(false);
    expect(
      isRebuyBelowExitWindow({
        ...base,
        rebuyBelowExitPct: 0,
        lastExitAtMs: nowMs - 60_000,
      }),
    ).toBe(false);
    expect(
      isRebuyBelowExitWindow({
        ...base,
        lastExitAtMs: null,
      }),
    ).toBe(false);
  });

  it('does not park h1_red_shallow even outside rebuy', () => {
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'h1_red_shallow',
        lastExitAtMs: null,
      }),
    ).toBe(false);
  });

  it('does not park main branch inside rebuy-below-exit window', () => {
    for (const src of ['dex', 'dex+stream', 'stream', 'flat_micro_dip'] as const) {
      expect(
        shouldParkWaitDip({
          ...base,
          dipSource: src,
          lastExitAtMs: nowMs - 120_000,
        }),
      ).toBe(false);
    }
  });

  it('still parks main branch outside rebuy window; stabilize never parks', () => {
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'dex',
        lastExitAtMs: null,
      }),
    ).toBe(true);
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'dex',
        lastExitAtMs: nowMs - 901_000,
      }),
    ).toBe(true);
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'mild_stabilize',
        lastExitAtMs: null,
      }),
    ).toBe(false);
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'knife_stabilize',
        lastExitAtMs: null,
      }),
    ).toBe(false);
  });
});

describe('waitDipTargetPriceUsd', () => {
  it('computes −7% target', () => {
    expect(waitDipTargetPriceUsd(100, -7)).toBeCloseTo(93, 8);
  });
});

describe('upsertWaitDipWatch / evaluateWaitDipReady', () => {
  it('anchors signal price and fires only after extra −7%', () => {
    const t0 = 1_000_000;
    const w0 = upsertWaitDipWatch(undefined, {
      nowMs: t0,
      priceUsd: 100,
      signalPriceUsd: 100,
      waitDipPct: -7,
      symbol: 'TEST',
      originalDipSource: 'dex',
      metrics,
    });
    expect(w0.signalPriceUsd).toBe(100);

    // Deeper mark must not walk the signal anchor.
    const w1 = upsertWaitDipWatch(w0, {
      nowMs: t0 + 5_000,
      priceUsd: 96,
      signalPriceUsd: 96,
      waitDipPct: -7,
      symbol: 'TEST',
      originalDipSource: 'dex',
      metrics,
    });
    expect(w1.signalPriceUsd).toBe(100);
    expect(w1.troughPriceUsd).toBe(96);

    const notReady = evaluateWaitDipReady(w1, gates, t0 + 5_000, 96);
    expect(notReady.ready).toBe(false);
    expect(notReady.expire).toBe(false);

    const ready = evaluateWaitDipReady(w1, gates, t0 + 10_000, 93);
    expect(ready.ready).toBe(true);
    expect(ready.dumpFromSignalPct).toBeCloseTo(-7, 5);
  });

  it('expires after maxWatchMs', () => {
    const t0 = 1_000_000;
    const w = upsertWaitDipWatch(undefined, {
      nowMs: t0,
      priceUsd: 100,
      signalPriceUsd: 100,
      waitDipPct: -7,
      symbol: 'TEST',
      originalDipSource: 'stream',
      metrics,
    });
    const v = evaluateWaitDipReady(w, gates, t0 + 1_200_001, 99);
    expect(v.expire).toBe(true);
    expect(v.ready).toBe(false);
  });
});

describe('waitDipMaxPriceUsd / evaluateWaitDipPreBuy', () => {
  it('ceiling is waitDipPct + overshoot vs signal', () => {
    // −7% + 2pp → max dump −5% → 95
    expect(waitDipMaxPriceUsd(100, -7, 2)).toBeCloseTo(95, 8);
  });

  it('passes at ready mark (−8.9%) and rejects reclaim to −3.5%', () => {
    const signal = 0.0000664;
    const ready = 0.00006051; // ≈ −8.87%
    const fillLike = 0.00006405; // ≈ −3.53% (2q6hhmf)

    const ok = evaluateWaitDipPreBuy({
      signalPriceUsd: signal,
      readyMarkPriceUsd: ready,
      freshPriceUsd: ready,
      waitDipPct: -7,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(ok.pass).toBe(true);
    expect(ok.maxPriceUsd).toBeCloseTo(signal * 0.95, 10);

    const bad = evaluateWaitDipPreBuy({
      signalPriceUsd: signal,
      readyMarkPriceUsd: ready,
      freshPriceUsd: fillLike,
      waitDipPct: -7,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.some((r) => r.startsWith('wait_dip_ceiling='))).toBe(true);
  });

  it('rejects chase above ready mark even if still under ceiling', () => {
    const signal = 100;
    const ready = 90; // −10%
    const fresh = 93.5; // still ≤ 95 ceiling (−5%), but +3.89% vs ready
    const bad = evaluateWaitDipPreBuy({
      signalPriceUsd: signal,
      readyMarkPriceUsd: ready,
      freshPriceUsd: fresh,
      waitDipPct: -7,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.some((r) => r.startsWith('wait_dip_chase_ready='))).toBe(true);
  });
});

describe('1.11.803 wait-dip coexists with turn-dump', () => {
  it('turn-dump gate no longer force-disables wait-dip when opted in', () => {
    const src = readFileSync(resolve('src/milddip/config.ts'), 'utf8');
    expect(src).toContain('waitDipWithTurnDump');
    expect(src).toContain('MILD_DIP_WAIT_DIP_WITH_TURN_DUMP');
    expect(src).toContain('!parsed.data.waitDipWithTurnDump');
  });

  it('live env parks the formula-selected dip for another leg down', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_WAIT_DIP: '1'");
    expect(eco).toContain("MILD_DIP_WAIT_DIP_WITH_TURN_DUMP: '1'");
    expect(eco).toContain("MILD_DIP_WAIT_DIP_PCT: '-15'");
    expect(eco).toContain("MILD_DIP_WAIT_DIP_MAX_OVERSHOOT_PCT: '5'");
    expect(eco).toContain("MILD_DIP_WAIT_DIP_MAX_CHASE_PCT: '8'");
    expect(eco).toContain("MILD_DIP_TURN_DUMP_GATE: '1'");
  });

  it('1.11.808 ask −15%, still never pay above −10% off signal', () => {
    const mk = (fresh: number) =>
      evaluateWaitDipPreBuy({
        signalPriceUsd: 100,
        readyMarkPriceUsd: 85, // ready fires at −15%
        freshPriceUsd: fresh,
        waitDipPct: -15,
        maxOvershootPct: 5,
        maxChaseFromReadyPct: 8,
      });
    // Fill window is ready 85 → ceiling 90, i.e. ~5.9% of reclaim is tolerated.
    expect(mk(85).pass).toBe(true);
    expect(mk(89.9).pass).toBe(true);
    // −12/−2 used to reject exactly here (live rejects clustered at −8.63%).
    expect(mk(91.4).pass).toBe(false);
  });

  it('1.11.856 banks in the range the leaders actually bank in', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    // 08-12, the only day whose SOL accounting is clean: 219 closed leader
    // positions, 42.9% of them landing in 0..+25%. A 30% trail put only 16%
    // there and let a +25% peak decay with nothing firing (236wfN8D).
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_STEP_PCT: '8'");
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_SELL_FRACTION: '0.5'");
    expect(eco).toContain("MILD_DIP_EXIT_GIVEBACK_PCT: '12'");
    // Floors unchanged.
    expect(eco).toContain("MILD_DIP_EXIT_BREAKEVEN_ARM_PCT: '8'");
    expect(eco).toContain("MILD_DIP_EXIT_HARD_STOP_PNL_PCT: '25'");
  });

  it('1.11.853 admits pairs up to 30 days, not 3', () => {
    // 32.7% of leader-bought mints are older than 72h, and 113 of those clear
    // every other floor: 15.6% of their universe was refused on age alone.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_MAX_PAIR_AGE_HOURS: '720'");
    // Liveness now rests on these two, so they must stay in place.
    expect(eco).toContain("MILD_DIP_MIN_VOLUME_5M_USD: '150'");
    expect(eco).toContain("MILD_DIP_MIN_LIQUIDITY_USD: '6000'");
  });

  it('throttles the ready journal so one seat cannot spam 363 lines', () => {
    const src = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(src).toContain('lastWaitDipReadyJournalMs');
    expect(src).toContain('WAIT_DIP_READY_JOURNAL_GAP_MS');
  });

  it('1.11.805 null Dex refetch falls back ring → candidate mark', () => {
    const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
    expect(src).toContain('const ringPx = mildDipPriceRing.lastPrice(c.mint, freshNow)');
    expect(src).toContain('if (ringPx && ringPx.priceUsd > 0) freshPx = ringPx.priceUsd');
    expect(src).toContain('else if (c.priceUsd > 0) freshPx = c.priceUsd');
  });

  it('ceiling still caps the fill when we fall back to the ready mark', () => {
    // signal 100, wait -12, overshoot 2 → ceiling 90. Ready mark 95 must fail.
    const tooHigh = evaluateWaitDipPreBuy({
      signalPriceUsd: 100,
      readyMarkPriceUsd: 95,
      freshPriceUsd: 95,
      waitDipPct: -12,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(tooHigh.pass).toBe(false);
  });

  it('prebuy rejects only when no price exists at all', () => {
    const missing = evaluateWaitDipPreBuy({
      signalPriceUsd: 100,
      readyMarkPriceUsd: 88,
      freshPriceUsd: null,
      waitDipPct: -12,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(missing.pass).toBe(false);
    expect(missing.reasons).toContain('wait_dip_prebuy_missing_price');
    const ok = evaluateWaitDipPreBuy({
      signalPriceUsd: 100,
      readyMarkPriceUsd: 88,
      freshPriceUsd: 88,
      waitDipPct: -12,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(ok.pass).toBe(true);
  });

  it('knife / stabilize branches still buy at signal', () => {
    expect(waitDipAppliesToSource('turn_dump_knife')).toBe(false);
    expect(waitDipAppliesToSource('knife_stabilize')).toBe(false);
    expect(waitDipAppliesToSource('mild_stabilize')).toBe(false);
    expect(waitDipAppliesToSource('dex')).toBe(true);
    expect(waitDipAppliesToSource('dex+stream')).toBe(true);
  });
});
