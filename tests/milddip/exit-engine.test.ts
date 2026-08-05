import { describe, expect, it } from 'vitest';
import {
  applyMarkDecisionToPosition,
  decideMarkExit,
  mapPool,
  orderMintsForMark,
} from '../../src/milddip/exit-engine.js';
import type { MildDipOpenPosition } from '../../src/milddip/state.js';

function pos(partial: Partial<MildDipOpenPosition> & { mint: string }): MildDipOpenPosition {
  return {
    symbol: partial.symbol ?? partial.mint.slice(0, 6),
    entryPriceUsd: partial.entryPriceUsd ?? 100,
    sizeUsd: partial.sizeUsd ?? 5,
    tokenRaw: partial.tokenRaw ?? '1',
    openedAtMs: partial.openedAtMs ?? 0,
    entryPc5mPct: partial.entryPc5mPct ?? -5,
    buySignature: partial.buySignature ?? null,
    peakPriceUsd: partial.peakPriceUsd,
    trailArmed: partial.trailArmed,
    mint: partial.mint,
  };
}

describe('orderMintsForMark', () => {
  it('puts armed positions first, then older opens', () => {
    const open = {
      a: pos({ mint: 'a', openedAtMs: 100, trailArmed: false }),
      b: pos({ mint: 'b', openedAtMs: 300, trailArmed: true }),
      c: pos({ mint: 'c', openedAtMs: 200, trailArmed: false }),
      d: pos({ mint: 'd', openedAtMs: 50, trailArmed: true }),
    };
    expect(orderMintsForMark(open)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('decideMarkExit / applyMarkDecisionToPosition', () => {
  const gates = {
    armPct: 8,
    givebackPct: 6,
    neverArmPatienceMs: 300_000,
    neverArmMaxHoldMs: 2_400_000,
  };

  it('updates peak and arms without exiting', () => {
    const p = pos({
      mint: 'm1',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs: 1_000_000,
    });
    const d = decideMarkExit({
      mint: 'm1',
      pos: p,
      markPriceUsd: 110,
      gates,
      nowMs: 1_060_000,
    });
    expect(d).not.toBeNull();
    expect(d!.armed).toBe(true);
    expect(d!.justArmed).toBe(true);
    expect(d!.shouldExit).toBe(false);
    applyMarkDecisionToPosition(p, d!);
    expect(p.trailArmed).toBe(true);
    expect(p.peakPriceUsd).toBe(110);
  });

  it('queues exit on giveback after arm — position fields still mergeable', () => {
    const p = pos({
      mint: 'm2',
      entryPriceUsd: 100,
      peakPriceUsd: 108,
      trailArmed: true,
      openedAtMs: 1_000_000,
    });
    const d = decideMarkExit({
      mint: 'm2',
      pos: p,
      markPriceUsd: 101.52,
      gates,
      nowMs: 1_060_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('peak_giveback');
    applyMarkDecisionToPosition(p, d!);
    // Still "open" until sell confirms — we only mutate trail fields here.
    expect(p.peakPriceUsd).toBe(108);
    expect(p.trailArmed).toBe(true);
  });

  it('queues never-arm giveback after patience', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm4',
      entryPriceUsd: 100,
      peakPriceUsd: 104,
      trailArmed: false,
      openedAtMs,
    });
    const d = decideMarkExit({
      mint: 'm4',
      pos: p,
      markPriceUsd: 97.76,
      gates,
      nowMs: openedAtMs + 300_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_giveback');
  });

  it('returns null for non-positive mark (keep tracking)', () => {
    const p = pos({ mint: 'm3', entryPriceUsd: 100 });
    expect(decideMarkExit({ mint: 'm3', pos: p, markPriceUsd: 0, gates })).toBeNull();
  });
});

describe('mapPool', () => {
  it('respects concurrency and preserves order', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = await mapPool(items, 3, async (n) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(maxInflight).toBeGreaterThan(1);
  });

  it('handles empty input', async () => {
    expect(await mapPool([], 8, async (x) => x)).toEqual([]);
  });
});
