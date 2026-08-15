import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';
import { MildDipPairAgeRegistry } from '../../src/milddip/pair-age-registry.js';
import {
  DEFAULT_MILD_DIP_TAPE_GATES,
  MildDipTapeShadow,
  createMildDipTapeShadowStateSaver,
  loadMildDipTapeShadowState,
} from '../../src/milddip/tape-shadow.js';

const mint = '7pQYyWKPtxMCzdWDPZKJ7xTnCzFB25SPxp8cM4xJpump';
const otherMint = '9wFF1kqJYhYxg8oJkH2K4pQmD6rS7tU8vW3xY5zA1bC';

function makeShadow(
  registry: MildDipPairAgeRegistry,
  ring = new MildDipPriceRing({ maxSamplesPerMint: 1_000, ttlMs: 90 * 60_000 }),
  events: Record<string, unknown>[] = [],
): MildDipTapeShadow {
  return new MildDipTapeShadow({
    ring,
    pairAgeRegistry: registry,
    gates: { ...DEFAULT_MILD_DIP_TAPE_GATES },
    minIntervalMs: 60_000,
    maxSignalsPerHour: 60,
    append: (event) => events.push(event),
  });
}

describe('mild-dip pair age registry', () => {
  it('accepts Dex creation timestamps and leader age observations idempotently', () => {
    const registry = new MildDipPairAgeRegistry();
    const seenAtMs = 10 * 3_600_000;
    expect(
      registry.notePairCreatedAt(mint, seenAtMs - 2 * 3_600_000, seenAtMs),
    ).toBe(true);
    expect(registry.notePairAgeHours(mint, 1, seenAtMs + 3_600_000)).toBe(
      false,
    );
    expect(registry.pairAgeHours(mint, seenAtMs + 3_600_000)).toBeCloseTo(3);
    expect(registry.notePairCreatedAt(otherMint, 0, seenAtMs)).toBe(false);
    expect(registry.notePairCreatedAt(otherMint, seenAtMs + 1, seenAtMs)).toBe(
      false,
    );
  });

  it('drops stale entries and keeps only the newest bounded entries', () => {
    const registry = new MildDipPairAgeRegistry();
    const nowMs = 100 * 3_600_000;
    registry.notePairCreatedAt(mint, nowMs - 2 * 3_600_000, nowMs - 2_000);
    registry.notePairCreatedAt(otherMint, nowMs - 3 * 3_600_000, nowMs - 1_000);
    registry.evict(nowMs, 1_500, 1);
    expect(registry.size()).toBe(1);
    expect(registry.pairAgeHours(otherMint, nowMs)).toBeCloseTo(3);
    expect(registry.pairAgeHours(mint, nowMs)).toBeNull();
  });

  it('round-trips through tape-shadow state and supplies age on structural-cache miss', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milddip-pair-age-'));
    try {
      const filePath = path.join(dir, 'tape-shadow-state.json');
      const nowMs = 300 * 60_000;
      const sourceRegistry = new MildDipPairAgeRegistry();
      sourceRegistry.notePairCreatedAt(mint, nowMs - 2 * 3_600_000, nowMs);
      const sourceRing = new MildDipPriceRing({
        maxSamplesPerMint: 1_000,
        ttlMs: 90 * 60_000,
      });
      const source = makeShadow(sourceRegistry, sourceRing);
      source.onPriceSample({
        mint,
        priceUsd: 100,
        tsMs: nowMs - 60 * 60_000,
        pairAgeHours: null,
      });
      const saver = createMildDipTapeShadowStateSaver({
        filePath,
        shadow: source,
        ring: sourceRing,
        saveIntervalMs: 60_000,
        idleEvictMs: 90 * 60_000,
        now: () => nowMs,
      });
      expect(saver.save()).toBe(true);
      const payload = JSON.parse(
        readFileSync(filePath, 'utf8') || '{}',
      ) as unknown;
      expect(payload).toBeTruthy();

      const restoredRegistry = new MildDipPairAgeRegistry();
      const restored = makeShadow(restoredRegistry);
      loadMildDipTapeShadowState(filePath, restored, nowMs);
      expect(restoredRegistry.pairAgeHours(mint, nowMs)).toBeCloseTo(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a restored age when the structural cache has no entry', () => {
    const registry = new MildDipPairAgeRegistry();
    const nowMs = 400 * 60_000;
    registry.notePairCreatedAt(mint, nowMs - 2 * 3_600_000, nowMs);
    const events: Record<string, unknown>[] = [];
    const shadow = makeShadow(registry, undefined, events);
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
        pairAgeHours: null,
      });
    }
    const signal = events.find(
      (event) => event.kind === 'mild_dip_tape_lane_signal',
    );
    expect(signal).toMatchObject({ lane: 'green', pairAgeHours: 2 });
  });
});
