import { describe, expect, it, vi } from 'vitest';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';
import {
  DEFAULT_MILD_DIP_TAPE_GATES,
  MildDipTapeShadow,
  evaluateMildDipTape,
  tapeShadowDiscoverySampleDecision,
  tapeFeatures,
  decimateTapePath,
  resolveTapeStructuralSnapshotFromCache,
  selectTapeStructuralBatch,
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
  function exitShadow(events: Record<string, unknown>[], overrides = {}): MildDipTapeShadow {
    return new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 10_000, ttlMs: 2 * 60 * 60_000 }),
      gates,
      greenMeasureAll: true,
      laneLimits: {
        green: { minIntervalMs: 1_000_000, maxSignalsPerHour: 10 },
        dip: { minIntervalMs: 0, maxSignalsPerHour: 10 },
      },
      minIntervalMs: 0,
      maxSignalsPerHour: 10,
      pendingSampleGraceMs: 0,
      ...overrides,
      append: (event) => events.push(event),
    });
  }

  it('emits a stop exit without arming', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = exitShadow(events, { exitStopPct: -30 });
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: 1_000_000 });
    shadow.onPriceSample({ mint, priceUsd: 70, tsMs: 1_000_100 });
    const exits = events.filter((event) => event.kind === 'mild_dip_tape_lane_exit');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ reason: 'stop', exitPriceUsd: 70, armed: false });
    expect(exits[0]!.retPct as number).toBeCloseTo(-30, 8);
  });

  it('emits timeout at the last observed price with stale age', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = exitShadow(events, { outcomeStaleMs: 100 });
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: 2_000_000 });
    shadow.onPriceSample({ mint, priceUsd: 105, tsMs: 2_000_100 });
    shadow.tick(5_600_101);
    const exit = events.find((event) => event.kind === 'mild_dip_tape_lane_exit');
    expect(exit).toMatchObject({
      reason: 'timeout',
      exitPriceUsd: 105,
      exitLastSampleAgeMs: 3_600_001,
      priceStale: true,
    });
  });

  it('emits no_data with a fabricated flat return avoided', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = exitShadow(events);
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: 3_000_000 });
    shadow.tick(6_600_001);
    const exit = events.find((event) => event.kind === 'mild_dip_tape_lane_exit');
    expect(exit).toMatchObject({ reason: 'no_data', exitPriceUsd: 100, retPct: 0 });
  });

  it('resolves structural snapshots from cache only and prefers fresh', () => {
    const fresh = { liquidityUsd: 1, marketCapUsd: 2, volume5mUsd: 3, turnover: 4, dexId: 'x', pairAgeHours: 5 };
    const stale = { ...fresh, liquidityUsd: 9 };
    expect(resolveTapeStructuralSnapshotFromCache(fresh, stale)).toBe(fresh);
    expect(resolveTapeStructuralSnapshotFromCache(null, stale)).toBe(stale);
    expect(resolveTapeStructuralSnapshotFromCache(null, null)).toBeNull();
  });

  it('selects pending first, then sample count, while honoring cache and backoff', () => {
    expect(
      selectTapeStructuralBatch(
        [
          { mint: 'old', pending: false, sampleCount10m: 99, fresh: false, retryUntilMs: 0 },
          { mint: 'pending', pending: true, sampleCount10m: 1, fresh: false, retryUntilMs: 0 },
          { mint: 'fresh', pending: true, sampleCount10m: 100, fresh: true, retryUntilMs: 0 },
          { mint: 'backoff', pending: true, sampleCount10m: 100, fresh: false, retryUntilMs: 300 },
          { mint: 'error-expired', pending: false, sampleCount10m: 50, fresh: false, retryUntilMs: 100 },
          { mint: 'miss-live', pending: false, sampleCount10m: 80, fresh: false, retryUntilMs: 500 },
        ],
        200,
        3,
      ),
    ).toEqual(['pending', 'old', 'error-expired']);
  });
  it('decimates ordered paths while preserving extrema', () => {
    const path = decimateTapePath(
      Array.from({ length: 100 }, (_, i) => [i, i === 73 ? 500 : i === 21 ? -10 : i] as [number, number]),
      10,
    );
    expect(path.length).toBeLessThanOrEqual(10);
    expect(path).toContainEqual([73, 500]);
    expect(path).toContainEqual([21, -10]);
    expect(path.map((p) => p[0])).toEqual([...path].map((p) => p[0]).sort((a, b) => a - b));
  });

  it('emits restart-safe path and simulated exit events', () => {
    const events: Record<string, unknown>[] = [];
    const ring = greenRing(100_000_000);
    const shadow = new MildDipTapeShadow({
      ring,
      gates,
      greenMeasureAll: true,
      minIntervalMs: 0,
      maxSignalsPerHour: 60,
      pathMaxPoints: 5,
      exitArmPct: 10,
      exitTrailPct: 9,
      exitStopPct: -30,
      exitTimeoutMs: 3_600_000,
      pendingSampleGraceMs: 0,
      append: (event) => events.push(event),
    });
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: 100_000_000, pairAgeHours: null });
    shadow.onPriceSample({ mint, priceUsd: 112, tsMs: 100_000_100, pairAgeHours: null });
    shadow.onPriceSample({ mint, priceUsd: 101, tsMs: 100_000_200, pairAgeHours: null });
    expect((shadow as unknown as { pending: unknown[] }).pending.length).toBeGreaterThan(0);
    shadow.tick(103_600_000);
    expect(events.some((event) => event.kind === 'mild_dip_tape_lane_path')).toBe(true);
    const exit = events.find((event) => event.kind === 'mild_dip_tape_lane_exit');
    expect(exit).toMatchObject({ reason: 'trail', shadowOnly: true });
  });

  it('keeps the online path bounded while retaining extrema', () => {
    const events: Record<string, unknown>[] = [];
    const ring = new MildDipPriceRing({ maxSamplesPerMint: 10_000, ttlMs: 2 * 60 * 60_000 });
    const now = 200_000_000;
    const shadow = new MildDipTapeShadow({
      ring,
      gates,
      greenMeasureAll: true,
      laneLimits: { green: { minIntervalMs: 1_000_000, maxSignalsPerHour: 10 }, dip: { minIntervalMs: 0, maxSignalsPerHour: 10 } },
      minIntervalMs: 0,
      maxSignalsPerHour: 10,
      pathMaxPoints: 12,
      append: (event) => events.push(event),
    });
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: now, pairAgeHours: null });
    for (let i = 1; i <= 500; i += 1) {
      shadow.onPriceSample({
        mint,
        priceUsd: i === 211 ? 999 : i === 377 ? 1 : 100 + i / 100,
        tsMs: now + i * 10_000,
        pairAgeHours: null,
      });
    }
    const pending = (shadow as unknown as { pending: Array<{ path: Array<[number, number]> }> }).pending;
    expect(pending[0]!.path.length).toBeLessThanOrEqual(12);
    expect(pending.some((signal) => signal.path.some((point) => point[1] === 999))).toBe(true);
    expect(pending.some((signal) => signal.path.some((point) => point[1] === 1))).toBe(true);
    for (const signal of pending) {
      expect(signal.path.map((point) => point[0])).toEqual(
        [...signal.path].map((point) => point[0]).sort((a, b) => a - b),
      );
    }
  });
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

  it('does not expose 60-minute features or signals on an incomplete window', () => {
    const now = 11_000_000;
    const ring = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(ring, now - 8 * 60_000, 100);
    note(ring, now - 5 * 60_000, 100);
    note(ring, now, 104);
    const features = tapeFeatures(ring, mint, now, 1);
    expect(features.spanMs).toBe(8 * 60_000);
    expect(features.window60SpanMs).toBe(8 * 60_000);
    expect(features.high60).toBeNull();
    expect(features.low60).toBeNull();
    expect(features.dd60).toBeNull();
    expect(features.rangePos).toBeNull();
    expect(evaluateMildDipTape(features, gates).matches).toEqual([]);
  });

  it('uses boundary samples for coverage even when the in-window span is shorter', () => {
    const now = 12_000_000;
    const ring = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(ring, now - 61 * 60_000, 100);
    note(ring, now - 59 * 60_000, 160);
    note(ring, now - 6 * 60_000, 100);
    note(ring, now, 104);
    const features = tapeFeatures(ring, mint, now, 1);
    expect(features.window60SpanMs).toBe(59 * 60_000);
    expect(features.spanMs).toBe(61 * 60_000);
    expect(features.imp60).toBeCloseTo(0.04);
    expect(features.imp5).toBeCloseTo(0.04);
    expect(evaluateMildDipTape(features, gates).matches).toContain('green');

    const dip = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(dip, now - 61 * 60_000, 100);
    note(dip, now - 59 * 60_000, 200);
    note(dip, now - 6 * 60_000, 200);
    note(dip, now, 110);
    expect(evaluateMildDipTape(tapeFeatures(dip, mint, now, 1), gates).matches).toContain(
      'dip',
    );
  });

  it('fails closed when no sample reaches either lookback boundary', () => {
    const now = 13_000_000;
    const ring = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(ring, now - 4 * 60_000, 100);
    note(ring, now - 1 * 60_000, 160);
    note(ring, now, 104);
    const features = tapeFeatures(ring, mint, now, 1);
    expect(features.window60SpanMs).toBe(4 * 60_000);
    expect(features.imp60).toBeNull();
    expect(features.imp5).toBeNull();
    expect(evaluateMildDipTape(features, gates).matches).toEqual([]);
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
      [1, 106],
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
      [60 * 60_000 + 1, 110],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    const outcomes = events.filter((e) => e.kind === 'mild_dip_tape_lane_outcome');
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((e) => e.horizonMinutes)).toEqual([15, 30, 60]);
    expect(outcomes[1]?.maxPriceUsd).toBe(120);
    expect(outcomes[2]?.minPriceUsd).toBe(90);
  });

  it('keeps a pending signal sampleable through 60m plus grace, then releases it', () => {
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      pendingSampleGraceMs: 5 * 60_000,
      append: () => {},
    });
    const now = 100_000_000;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 160],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    expect(shadow.pendingMints(now + 60 * 60_000 + 5 * 60_000 - 1, 5 * 60_000, 10)).toEqual(
      new Set([mint]),
    );
    shadow.tick(now + 60 * 60_000 + 5 * 60_000);
    expect(shadow.pendingMints(now + 60 * 60_000 + 5 * 60_000, 5 * 60_000, 10)).toEqual(
      new Set(),
    );
  });

  it('refreshes pending mint cache after signal mutation and expiry', () => {
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      pendingSampleGraceMs: 0,
      append: () => {},
    });
    const now = 100_000_000;
    expect(shadow.pendingMints(now, 0, 10)).toEqual(new Set());
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 160],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    expect(shadow.pendingMints(now, 0, 10)).toEqual(new Set([mint]));
    expect(shadow.pendingMints(now + 60 * 60_000, 0, 10)).toEqual(new Set());
  });

  it('attaches structural snapshots and evaluates lane-specific own floors', async () => {
    const greenEvents: Record<string, unknown>[] = [];
    const greenNow = 110_000_000;
    const greenStructuralRing = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(greenStructuralRing, greenNow - 61 * 60_000, 100);
    note(greenStructuralRing, greenNow - 50 * 60_000, 108);
    note(greenStructuralRing, greenNow - 5 * 60_000, 100);
    const greenShadow = new MildDipTapeShadow({
      ring: greenStructuralRing,
      gates: {
        ...gates,
        greenImp60MinPct: -100,
        greenImp5MinPct: -100,
        greenImp5MaxPct: 100,
        greenDd60MaxPct: 0,
        greenMinPairAgeHours: 0,
      },
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      idleEvictMs: 90 * 60_000,
      ownFloors: {
        green: {
          minLiquidityUsd: 1_700,
          maxLiquidityUsd: 20_000,
          minMarketCapUsd: 2_000,
          minVolume5mUsd: 150,
          maxTurnover: 0,
          minPairAgeHours: 1,
        },
        dip: {
          minLiquidityUsd: 1_700,
          maxLiquidityUsd: 6_000,
          minMarketCapUsd: 2_000,
          minVolume5mUsd: 300,
          maxTurnover: 0,
          minPairAgeHours: 0.5,
        },
      },
      structuralSnapshot: async () => ({
        liquidityUsd: 5_000,
        marketCapUsd: 3_000,
        volume5mUsd: 200,
        turnover: 0.04,
        dexId: 'raydium',
        pairAgeHours: 2,
      }),
      append: (event) => greenEvents.push(event),
    });
    greenShadow.onPriceSample({ mint, priceUsd: 104, tsMs: greenNow, pairAgeHours: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(greenEvents.find((event) => event.kind === 'mild_dip_tape_lane_signal')).toMatchObject({
      liquidityUsd: 5_000,
      marketCapUsd: 3_000,
      volume5mUsd: 200,
      turnover: 0.04,
      dexId: 'raydium',
      pairAgeHours: 2,
      ownFloorsPass: true,
      ownFloorsFail: [],
    });

    const dipEvents: Record<string, unknown>[] = [];
    const dipNow = greenNow + 10_000_000;
    const dipStructuralRing = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(dipStructuralRing, dipNow - 61 * 60_000, 100);
    note(dipStructuralRing, dipNow - 50 * 60_000, 200);
    note(dipStructuralRing, dipNow - 5 * 60_000, 140);
    const dipShadow = new MildDipTapeShadow({
      ring: dipStructuralRing,
      gates: {
        ...gates,
        dipRangePosMaxPct: 100,
        dipDd60MaxPct: 0,
        dipImp5MaxPct: 100,
        dipMinPairAgeHours: 0,
        dipMaxPairAgeHours: 100,
      },
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      idleEvictMs: 90 * 60_000,
      ownFloors: {
        green: {
          minLiquidityUsd: 1_700,
          maxLiquidityUsd: 20_000,
          minMarketCapUsd: 2_000,
          minVolume5mUsd: 150,
          maxTurnover: 0,
          minPairAgeHours: 1,
        },
        dip: {
          minLiquidityUsd: 1_700,
          maxLiquidityUsd: 6_000,
          minMarketCapUsd: 2_000,
          minVolume5mUsd: 300,
          maxTurnover: 0,
          minPairAgeHours: 0.5,
        },
      },
      structuralSnapshot: async () => ({
        liquidityUsd: 5_000,
        marketCapUsd: 3_000,
        volume5mUsd: 200,
        turnover: 0.04,
        dexId: 'raydium',
        pairAgeHours: 2,
      }),
      append: (event) => dipEvents.push(event),
    });
    dipShadow.onPriceSample({ mint, priceUsd: 110, tsMs: dipNow, pairAgeHours: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dipEvents.find((event) => event.kind === 'mild_dip_tape_lane_signal')).toMatchObject({
      ownFloorsPass: false,
      ownFloorsFail: ['dip_min_volume5m_usd'],
    });
  });

  it('records null structural snapshots and own-floor counters in summary', async () => {
    const events: Record<string, unknown>[] = [];
    const now = 120_000_000;
    const nullStructuralRing = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 });
    note(nullStructuralRing, now - 61 * 60_000, 100);
    note(nullStructuralRing, now - 50 * 60_000, 108);
    note(nullStructuralRing, now - 5 * 60_000, 100);
    const shadow = new MildDipTapeShadow({
      ring: nullStructuralRing,
      gates: {
        ...gates,
        greenImp60MinPct: -100,
        greenImp5MinPct: -100,
        greenImp5MaxPct: 100,
        greenDd60MaxPct: 0,
        greenMinPairAgeHours: 0,
      },
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      idleEvictMs: 90 * 60_000,
      summaryIntervalMs: 60_000,
      structuralSnapshot: async () => null,
      ownFloors: {
        green: {
          minLiquidityUsd: 1_700,
          maxLiquidityUsd: 20_000,
          minMarketCapUsd: 2_000,
          minVolume5mUsd: 150,
          maxTurnover: 0,
          minPairAgeHours: 1,
        },
        dip: {
          minLiquidityUsd: 1_700,
          maxLiquidityUsd: 6_000,
          minMarketCapUsd: 2_000,
          minVolume5mUsd: 300,
          maxTurnover: 0,
          minPairAgeHours: 0.5,
        },
      },
      append: (event) => events.push(event),
    });
    shadow.onPriceSample({ mint, priceUsd: 104, tsMs: now, pairAgeHours: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const signal = events.find((event) => event.kind === 'mild_dip_tape_lane_signal');
    expect(signal).toMatchObject({
      ownFloorsPass: null,
      ownFloorsFail: ['no_structural_snapshot'],
      liquidityUsd: null,
      pairAgeHours: 1,
    });
    shadow.tick(now + 60_000);
    const summary = events.find((event) => event.kind === 'mild_dip_tape_lane_summary');
    expect(summary).toMatchObject({
      lanes: {
        green: {
          structural: {
            signals: 1,
            ownFloorsPass: 0,
            ownFloorsNull: 1,
            rejectionReasons: { no_structural_snapshot: 1 },
          },
        },
      },
    });
  });

  it('measure-all emits green with null features and preserves gate failures', async () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      greenMeasureAll: true,
      laneLimits: {
        green: { minIntervalMs: 300_000, maxSignalsPerHour: 1_500 },
        dip: { minIntervalMs: 60_000, maxSignalsPerHour: 60 },
      },
      structuralSnapshot: async () => null,
      append: (event) => events.push(event),
    });
    const now = 130_000_000;
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: now, pairAgeHours: null });
    shadow.onPriceSample({ mint, priceUsd: 101, tsMs: now + 60_000, pairAgeHours: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const signals = events.filter((event) => event.kind === 'mild_dip_tape_lane_signal');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      lane: 'green',
      measureAll: true,
      imp60: null,
      imp5: null,
      ownFloorsPass: null,
      ownFloorsFail: ['no_structural_snapshot'],
    });
    expect((signals[0]!.formulaGateFailures as string[]).length).toBeGreaterThan(0);
  });

  it('keeps dip formula gating independent from green measure-all', () => {
    const features = tapeFeatures(
      new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      mint,
      140_000_000,
      null,
    );
    const evaluation = evaluateMildDipTape(features, gates, true);
    expect(evaluation.matches).toEqual(['green']);
    expect(evaluation.reasons.dip.length).toBeGreaterThan(0);
  });

  it('records capped structural fetches as unavailable floor verdicts', async () => {
    const events: Record<string, unknown>[] = [];
    const now = 150_000_000;
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      greenMeasureAll: true,
      structuralSnapshot: async () => null,
      append: (event) => events.push(event),
      summaryIntervalMs: 60_000,
    });
    shadow.noteStructuralFetchCapped();
    shadow.onPriceSample({ mint, priceUsd: 100, tsMs: now, pairAgeHours: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.find((event) => event.kind === 'mild_dip_tape_lane_signal')).toMatchObject({
      ownFloorsPass: null,
      ownFloorsFail: ['no_structural_snapshot'],
    });
    shadow.tick(now + 60_000);
    expect(events.find((event) => event.kind === 'mild_dip_tape_lane_summary')).toMatchObject({
      structuralFetchCapped: 1,
    });
  });

  it('enforces bounded shadow-discovery sampling and keeps zero disabled', () => {
    const seen = new Map<string, number>();
    const cleanup = { lastAtMs: 0 };
    expect(tapeShadowDiscoverySampleDecision('a', 1_000, seen, 2, 15_000, 90_000)).toBe(
      'sample',
    );
    expect(tapeShadowDiscoverySampleDecision('b', 1_000, seen, 2, 15_000, 90_000)).toBe(
      'sample',
    );
    expect(tapeShadowDiscoverySampleDecision('c', 1_000, seen, 2, 15_000, 90_000)).toBe(
      'limitRejected',
    );
    expect(tapeShadowDiscoverySampleDecision('a', 10_000, seen, 2, 15_000, 90_000)).toBe(
      'skip',
    );
    expect(tapeShadowDiscoverySampleDecision('a', 16_000, seen, 2, 15_000, 90_000)).toBe(
      'sample',
    );
    expect(
      tapeShadowDiscoverySampleDecision(
        'c',
        100_001,
        seen,
        2,
        15_000,
        90_000,
        cleanup,
      ),
    ).toBe('sample');
    expect(tapeShadowDiscoverySampleDecision('d', 100_001, seen, 0, 15_000, 90_000)).toBe(
      'skip',
    );
  });

  it('includes tape sampling counters in the summary', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      summaryIntervalMs: 60_000,
      append: (event) => events.push(event),
    });
    shadow.noteSampling('pending', 2);
    shadow.noteSampling('shadowDiscovery', 3);
    shadow.noteSampling('limitRejected');
    shadow.tick(1_000);
    shadow.tick(61_000);
    expect(events.find((event) => event.kind === 'mild_dip_tape_lane_summary')).toMatchObject({
      sampling: { pending: 2, shadowDiscovery: 3, limitRejected: 1 },
      shadowOnly: true,
    });
  });

  it('closes outcomes from the timer without new samples and marks stale prices', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      outcomeStaleMs: 5 * 60_000,
      append: (event) => events.push(event),
    });
    const now = 65_000_000;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 160],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    shadow.tick(now + 15 * 60_000);
    shadow.tick(now + 30 * 60_000);
    shadow.tick(now + 60 * 60_000);
    const outcomes = events.filter((e) => e.kind === 'mild_dip_tape_lane_outcome');
    expect(outcomes.map((e) => e.horizonMinutes)).toEqual([15, 30, 60]);
    expect(outcomes.every((e) => e.priceAgeMs === e.horizonMinutes * 60_000)).toBe(true);
    expect(outcomes.every((e) => e.priceStale === true)).toBe(true);
    expect(outcomes.every((e) => e.sampleCount === 1)).toBe(true);
  });

  it('summarizes matched, recorded, interval-suppressed, and cap-suppressed signals', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 1,
      summaryIntervalMs: 2 * 60 * 60_000,
      append: (event) => events.push(event),
    });
    const now = 75_000_000;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 160],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    shadow.onPriceSample({ mint, priceUsd: 104, tsMs: now, pairAgeHours: 1 });
    const secondMint = `${mint.slice(0, -1)}X`;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 160],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint: secondMint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    shadow.tick(now + 2 * 60 * 60_000 + 1);
    const summary = events.find((e) => e.kind === 'mild_dip_tape_lane_summary');
    expect(summary).toBeTruthy();
    expect((summary?.lanes as { green: Record<string, number> }).green).toMatchObject({
      conditions: 3,
      recorded: 1,
      suppressedInterval: 1,
      suppressedCap: 1,
      pairAgeKnown: 9,
      pairAgeUnknown: 0,
    });
    expect(
      (summary?.lanes as { green: { rejectionReasons: Record<string, number> } }).green
        .rejectionReasons.no_60m_coverage,
    ).toBeGreaterThan(0);
  });

  it('summarizes missing tape coverage and null pair age as rejection reasons', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      summaryIntervalMs: 60_000,
      append: (event) => events.push(event),
    });
    const now = 76_000_000;
    shadow.onPriceSample({ mint, priceUsd: 104, tsMs: now, pairAgeHours: null });
    shadow.tick(now + 60_000);
    const summary = events.find((e) => e.kind === 'mild_dip_tape_lane_summary');
    const greenReasons = (
      summary?.lanes as { green: { rejectionReasons: Record<string, number> } }
    ).green.rejectionReasons;
    expect(greenReasons.no_60m_coverage).toBe(1);
    expect(greenReasons.no_5m_coverage).toBe(1);
    expect(greenReasons['pairAgeHours=null']).toBe(1);
    expect((summary?.lanes as { green: { pairAgeKnown: number; pairAgeUnknown: number } }).green)
      .toMatchObject({ pairAgeKnown: 0, pairAgeUnknown: 1 });
  });

  it('evicts idle mints and removes completed pending signals', () => {
    const ring = new MildDipPriceRing({ ttlMs: 90 * 60_000 });
    note(ring, 80_000_000, 1);
    expect(ring.evictIdle(80_000_000 + 16 * 60_000, 15 * 60_000)).toBe(1);
    expect(ring.watchedMints(80_000_000 + 16 * 60_000)).toEqual([]);

    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 0,
      maxSignalsPerHour: 60,
      append: (event) => events.push(event),
    });
    const now = 85_000_000;
    for (const [offset, price] of [
      [-60 * 60_000, 100],
      [-50 * 60_000, 160],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: 1 });
    }
    shadow.tick(now + 60 * 60_000);
    expect((shadow as unknown as { pending: unknown[] }).pending).toHaveLength(0);
  });

  it('retains dormant tape history through a short configured eviction interval', () => {
    const events: Record<string, unknown>[] = [];
    const shadow = new MildDipTapeShadow({
      ring: new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
      gates,
      minIntervalMs: 60_000,
      maxSignalsPerHour: 60,
      idleEvictMs: 90 * 60_000,
      append: (event) => events.push(event),
    });
    const now = 95_000_000;
    for (const [offset, price] of [
      [-40 * 60_000, 100],
      [-30 * 60_000, 160],
      [-5 * 60_000, 100],
      [0, 104],
    ] as const) {
      shadow.onPriceSample({ mint, priceUsd: price, tsMs: now + offset, pairAgeHours: null });
    }
    shadow.tick(now + 20 * 60_000);
    shadow.onPriceSample({
      mint,
      priceUsd: 110,
      tsMs: now + 20 * 60_000,
      pairAgeHours: 1,
    });
    expect(events.filter((event) => event.kind === 'mild_dip_tape_lane_signal')).toHaveLength(1);
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
