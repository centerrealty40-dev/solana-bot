import { describe, expect, it, vi } from 'vitest';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';
import {
  DEFAULT_MILD_DIP_TAPE_GATES,
  MildDipTapeShadow,
  evaluateMildDipTape,
  tapeFeatures,
} from '../../src/milddip/tape-shadow.js';

const mint = '7pQYyWKPtxMCzdWDPZKJ7xTnCzFB25SPxp8cM4xJpump';
const gates = { ...DEFAULT_MILD_DIP_TAPE_GATES };

function note(
  ring: MildDipPriceRing,
  tsMs: number,
  priceUsd: number,
): void {
  ring.note(mint, priceUsd, { tsMs, source: 'stream' });
}

function greenRing(nowMs: number, imp5 = 0.04): MildDipPriceRing {
  const ring = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
  note(ring, nowMs - 60 * 60_000, 100);
  note(ring, nowMs - 50 * 60_000, 160);
  note(ring, nowMs - 5 * 60_000, 100);
  note(ring, nowMs, 100 * (1 + imp5));
  return ring;
}

function dipRing(nowMs: number, rangePos = 0.1): MildDipPriceRing {
  const ring = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
  note(ring, nowMs - 60 * 60_000, 100);
  note(ring, nowMs - 50 * 60_000, 200);
  note(ring, nowMs - 5 * 60_000, 140);
  const last = 100 + (200 - 100) * rangePos;
  note(ring, nowMs, last);
  return ring;
}

describe('tape shadow arithmetic and lane boundaries', () => {
  it('calculates the 5m/60m tape window and fails closed without history', () => {
    const now = 10_000_000;
    const ring = greenRing(now);
    const features = tapeFeatures(ring, mint, now, 1);
    expect(features.last).toBeCloseTo(104);
    expect(features.high60).toBe(160);
    expect(features.low60).toBe(100);
    expect(features.imp5).toBeCloseTo(0.04);
    expect(features.imp60).toBeCloseTo(0.04);
    expect(features.dd60).toBeCloseTo(-56 / 160);

    const cold = new MildDipPriceRing({ ttlMs: 90 * 60_000 });
    const coldFeatures = tapeFeatures(cold, mint, now, 1);
    expect(coldFeatures.imp5).toBeNull();
    expect(coldFeatures.imp60).toBeNull();
    expect(evaluateMildDipTape(coldFeatures, gates).matches).toEqual([]);
  });

  it.each([
    ['imp5 lower boundary', 0.04, true],
    ['imp5 upper boundary', 0.4, true],
    ['imp5 above upper boundary', 0.400001, false],
  ])('%s', (_name, imp5, pass) => {
    const now = 20_000_000;
    const evaluation = evaluateMildDipTape(
      tapeFeatures(greenRing(now, imp5), mint, now, 1),
      gates,
    );
    expect(evaluation.matches.includes('green')).toBe(pass);
  });

  it('uses strict positive imp60 and inclusive dd60/age boundaries', () => {
    const now = 30_000_000;
    const ring = greenRing(now);
    const exactDd = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(exactDd, now - 60 * 60_000, 100);
    note(exactDd, now - 50 * 60_000, 110);
    note(exactDd, now - 5 * 60_000, 100);
    note(exactDd, now, 104.5);
    expect(
      evaluateMildDipTape(tapeFeatures(exactDd, mint, now, 1), gates).matches,
    ).toContain('green');
    expect(
      evaluateMildDipTape(tapeFeatures(ring, mint, now, 0.9999), gates).matches,
    ).not.toContain('green');
    const noImp = greenRing(now);
    note(noImp, now, 100);
    expect(
      evaluateMildDipTape(tapeFeatures(noImp, mint, now, 1), gates).matches,
    ).not.toContain('green');
  });

  it('applies DIP boundaries including strict rangePos and age limits', () => {
    const now = 40_000_000;
    const base = dipRing(now, 0.1);
    note(base, now - 5 * 60_000, 110 / 0.85);
    note(base, now, 110);
    expect(evaluateMildDipTape(tapeFeatures(base, mint, now, 0.5), gates).matches).toContain('dip');

    const exactRange = dipRing(now, 0.2);
    expect(
      evaluateMildDipTape(tapeFeatures(exactRange, mint, now, 1), gates).matches,
    ).not.toContain('dip');
    const old = evaluateMildDipTape(tapeFeatures(dipRing(now), mint, now, 24), gates);
    expect(old.matches).toContain('dip');
    const tooOld = evaluateMildDipTape(tapeFeatures(dipRing(now), mint, now, 24.0001), gates);
    expect(tooOld.matches).not.toContain('dip');
    expect(
      evaluateMildDipTape(
        {
          last: 0.6,
          high60: 1,
          low60: 0.55,
          imp5: -0.15,
          imp60: null,
          rangePos: 0.1,
          dd60: -0.4,
          pairAgeHours: 0.5,
          currentPriceUsd: 0.6,
          source: 'stream',
        },
        gates,
      ).matches,
    ).toContain('dip');
  });

  it('returns both lanes if configured conditions make both pass', () => {
    const both = evaluateMildDipTape(
      {
        last: 1,
        high60: 2,
        low60: 0.5,
        imp5: 0.1,
        imp60: 0.1,
        rangePos: 0.1,
        dd60: -0.5,
        pairAgeHours: 2,
        currentPriceUsd: 1,
        source: 'stream',
      },
      {
        ...gates,
        greenImp60MinPct: -100,
        greenImp5MinPct: -100,
        greenImp5MaxPct: 100,
        greenDd60MaxPct: 0,
        greenMinPairAgeHours: 0,
        dipRangePosMaxPct: 100,
        dipDd60MaxPct: 0,
        dipImp5MaxPct: 100,
        dipMinPairAgeHours: 0,
        dipMaxPairAgeHours: 24,
      },
    );
    expect(both.matches).toEqual(['green', 'dip']);
  });
});

describe('MildDipTapeShadow', () => {
  it('rate-limits per mint and hourly signals', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 1,
      append: (event) => events.push(event),
    });
    const now = 50_000_000;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 110],
      [-5 * 60_000, 100],
      [0, 104],
      [1_000, 104.1],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    expect(events.filter((e) => e.kind === 'mild_dip_tape_lane_signal')).toHaveLength(1);
    shadow.onPriceSample({ mint, priceUsd: 120, tsMs: now + 50 * 60_000 + 1, pairAgeHours: 1 });
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: now + 55 * 60_000 + 1, pairAgeHours: 1 });
    shadow.onPriceSample({ mint, priceUsd: 110, tsMs: now + 60 * 60_000 + 1, pairAgeHours: 1 });
    expect(events.filter((e) => e.kind === 'mild_dip_tape_lane_signal')).toHaveLength(2);
  });

  it('emits one 15/30/60 minute outcome with max and min since signal', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      append: (event) => events.push(event),
    });
    const now = 60_000_000;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 110],
      [-5 * 60_000, 100],
      [0, 104],
      [15 * 60_000, 120],
      [30 * 60_000, 90],
      [60 * 60_000, 105],
      [60 * 60_000 + 1, 106],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    const outcomes = events.filter((e) => e.kind === 'mild_dip_tape_lane_outcome');
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((e) => e.horizonMinutes)).toEqual([15, 30, 60]);
    expect(outcomes[1]?.maxPriceUsd).toBe(120);
    expect(outcomes[2]?.minPriceUsd).toBe(90);
  });

  it('is journal-only and never calls an execution function', () => {
    const submit = vi.fn();
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 0,
      maxSignalsPerHour: 60,
      append: (event) => events.push(event),
    });
    const now = 70_000_000;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 110],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    expect(events.some((e) => e.kind === 'mild_dip_tape_lane_signal')).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});
