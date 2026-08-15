import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';
import {
  DEFAULT_MILD_DIP_TAPE_GATES,
  MildDipTapeShadow,
  createMildDipTapeShadowStateSaver,
  loadMildDipTapeShadowState,
  saveMildDipTapeShadowState,
} from '../../src/milddip/tape-shadow.js';

const mint = '7pQYyWKPtxMCzdWDPZKJ7xTnCzFB25SPxp8cM4xJpump';

function seedGreenSignal(shadow: MildDipTapeShadow, nowMs: number): void {
  for (const [offset, priceUsd] of [
    [-60 * 60_000, 100],
    [-50 * 60_000, 160],
    [-5 * 60_000, 100],
    [0, 104],
  ] as const) {
    shadow.onPriceSample({
      mint,
      priceUsd,
      tsMs: nowMs + offset,
      pairAgeHours: 1,
    });
  }
}

function makeShadow(
  events: Record<string, unknown>[],
  ring = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
): MildDipTapeShadow {
  return new MildDipTapeShadow({
    ring,
    gates: { ...DEFAULT_MILD_DIP_TAPE_GATES },
    minIntervalMs: 60_000,
    maxSignalsPerHour: 60,
    outcomeStaleMs: 5 * 60_000,
    append: (event) => events.push(event),
  });
}

describe('persistent tape-shadow state', () => {
  it('round-trips ring, pending state, and already-emitted horizons', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-tape-state-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      const firstEvents: Record<string, unknown>[] = [];
      const nowMs = 100 * 60_000;
      const first = makeShadow(firstEvents);
      seedGreenSignal(first, nowMs);
      first.tick(nowMs + 15 * 60_000);
      saveMildDipTapeShadowState(filePath, first, nowMs + 20 * 60_000);

      const restoredEvents: Record<string, unknown>[] = [];
      const restored = makeShadow(restoredEvents);
      const result = loadMildDipTapeShadowState(filePath, restored, nowMs + 20 * 60_000);
      expect(result.samples).toBe(4);
      expect(result.pending).toBe(1);

      restored.tick(nowMs + 30 * 60_000);
      restored.tick(nowMs + 60 * 60_000);
      const outcomes = restoredEvents.filter(
        (event) => event.kind === 'mild_dip_tape_lane_outcome',
      );
      expect(outcomes.map((event) => event.horizonMinutes)).toEqual([30, 60]);
      expect(firstEvents.filter((event) => event.horizonMinutes === 15)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops samples older than the tape window during restore', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-tape-state-old-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      const nowMs = 200 * 60_000;
      const source = makeShadow([]);
      source.onPriceSample({
        mint,
        priceUsd: 100,
        tsMs: nowMs - 2 * 60 * 60_000,
        pairAgeHours: 1,
      });
      source.onPriceSample({
        mint,
        priceUsd: 104,
        tsMs: nowMs - 10 * 60_000,
        pairAgeHours: 1,
      });
      saveMildDipTapeShadowState(filePath, source, nowMs);

      const restoredRing = new MildDipPriceRing({ ttlMs: 90 * 60_000 });
      const restored = makeShadow([], restoredRing);
      const result = loadMildDipTapeShadowState(filePath, restored, nowMs);
      expect(result.samples).toBe(1);
      expect(restoredRing.watchedMints(nowMs)).toEqual([mint]);
      expect(restoredRing.toJSON(nowMs)[mint]).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses restored 60-minute history to qualify a new signal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-tape-state-signal-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      const nowMs = 300 * 60_000;
      const source = makeShadow([]);
      source.onPriceSample({ mint, priceUsd: 100, tsMs: nowMs - 60 * 60_000, pairAgeHours: 1 });
      source.onPriceSample({ mint, priceUsd: 160, tsMs: nowMs - 50 * 60_000, pairAgeHours: 1 });
      source.onPriceSample({ mint, priceUsd: 100, tsMs: nowMs - 5 * 60_000, pairAgeHours: 1 });
      saveMildDipTapeShadowState(filePath, source, nowMs);

      const events: Record<string, unknown>[] = [];
      const restored = makeShadow(events);
      loadMildDipTapeShadowState(filePath, restored, nowMs);
      restored.onPriceSample({ mint, priceUsd: 104, tsMs: nowMs, pairAgeHours: 1 });
      expect(events.some((event) => event.kind === 'mild_dip_tape_lane_signal')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails soft on a corrupt state file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-tape-state-bad-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      writeFileSync(filePath, '{not-json', 'utf8');
      const events: Record<string, unknown>[] = [];
      const restored = makeShadow(events);
      expect(() => loadMildDipTapeShadowState(filePath, restored, 400 * 60_000)).not.toThrow();
      expect(restored.toJSON(400 * 60_000).pending).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops pending signals whose final horizon has expired', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-tape-state-expired-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      const signalTsMs = 500 * 60_000;
      const sourceEvents: Record<string, unknown>[] = [];
      const source = makeShadow(sourceEvents);
      seedGreenSignal(source, signalTsMs);
      saveMildDipTapeShadowState(filePath, source, signalTsMs + 61 * 60_000);

      const restored = makeShadow([]);
      const result = loadMildDipTapeShadowState(
        filePath,
        restored,
        signalTsMs + 61 * 60_000,
      );
      expect(result.pending).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes immediately, throttles subsequent saves, and forces shutdown saves', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-tape-state-throttle-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      const events: Record<string, unknown>[] = [];
      const ring = new MildDipPriceRing({ ttlMs: 90 * 60_000 });
      const shadow = makeShadow(events, ring);
      let nowMs = 600 * 60_000;
      const logs: string[] = [];
      const saver = createMildDipTapeShadowStateSaver({
        filePath,
        shadow,
        ring,
        saveIntervalMs: 60_000,
        idleEvictMs: 90 * 60_000,
        now: () => nowMs,
        log: (message) => logs.push(message),
      });

      expect(saver.save()).toBe(true);
      const first = readFileSync(filePath, 'utf8');
      nowMs += 30_000;
      expect(saver.save()).toBe(false);
      expect(readFileSync(filePath, 'utf8')).toBe(first);
      expect(saver.save(true)).toBe(true);
      expect(readFileSync(filePath, 'utf8')).not.toBe(first);
      expect(logs).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('evicts idle mints before saving while retaining the tape history mint', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-tape-state-evict-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      const nowMs = 700 * 60_000;
      const ring = new MildDipPriceRing({ ttlMs: 90 * 60_000 });
      const shadow = makeShadow([], ring);
      ring.note('idle-mint', 1, { tsMs: nowMs - 2 * 60 * 60_000, source: 'stream' });
      for (const [offset, priceUsd] of [
        [-60 * 60_000, 100],
        [-30 * 60_000, 120],
        [-10 * 60_000, 104],
      ] as const) {
        ring.note(mint, priceUsd, { tsMs: nowMs + offset, source: 'stream' });
      }
      const saver = createMildDipTapeShadowStateSaver({
        filePath,
        shadow,
        ring,
        saveIntervalMs: 60_000,
        idleEvictMs: 90 * 60_000,
        now: () => nowMs,
      });
      expect(saver.save()).toBe(true);

      const payload = JSON.parse(readFileSync(filePath, 'utf8')) as {
        ring: Record<string, unknown[]>;
      };
      expect(payload.ring['idle-mint']).toBeUndefined();
      expect(payload.ring[mint]).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
