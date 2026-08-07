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
    exitPendingReason: partial.exitPendingReason,
    mint: partial.mint,
  };
}

describe('orderMintsForMark', () => {
  it('puts sticky exits first, then armed, then older opens', () => {
    const open = {
      a: pos({ mint: 'a', openedAtMs: 100, trailArmed: false }),
      b: pos({ mint: 'b', openedAtMs: 300, trailArmed: true }),
      c: pos({ mint: 'c', openedAtMs: 200, trailArmed: false }),
      d: pos({ mint: 'd', openedAtMs: 50, trailArmed: true }),
      e: pos({ mint: 'e', openedAtMs: 400, trailArmed: false, exitPendingReason: 'peak_giveback' }),
    };
    expect(orderMintsForMark(open)).toEqual(['e', 'd', 'b', 'a', 'c']);
  });
});

describe('decideMarkExit / applyMarkDecisionToPosition', () => {
  const gates = {
    armPct: 8,
    givebackPct: 8,
    partialSellFraction: 0,
    secondGivebackPct: 0,
    neverArmPatienceMs: 0,
    neverArmMaxHoldMs: 5_400_000,
    neverArmDeadMinMs: 900_000,
    neverArmDeadPnlPct: 15,
    neverArmVolFadeMinMs: 600_000,
    neverArmVolFadeRatio: 0.35,
    neverArmVolFadeFloorUsd: 500,
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
      markPriceUsd: 99.36, // −8% of 108
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

  it('queues never-arm dead after 15m deep loss (patience off)', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm4',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    const early = decideMarkExit({
      mint: 'm4',
      pos: p,
      markPriceUsd: 80,
      gates,
      nowMs: openedAtMs + 300_000,
    });
    expect(early?.shouldExit).toBe(false);

    const d = decideMarkExit({
      mint: 'm4',
      pos: p,
      markPriceUsd: 80,
      gates,
      nowMs: openedAtMs + 900_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_dead');
  });

  it('returns null for non-positive mark (keep tracking)', () => {
    const p = pos({ mint: 'm3', entryPriceUsd: 100 });
    expect(decideMarkExit({ mint: 'm3', pos: p, markPriceUsd: 0, gates })).toBeNull();
  });

  it('holds a flat unarmed bag while 5m volume stays alive', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm5',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    const d = decideMarkExit({
      mint: 'm5',
      pos: p,
      markPriceUsd: 98,
      gates,
      nowMs: openedAtMs + 1_800_000,
      volume5mUsd: 3_000,
    });
    expect(d?.shouldExit).toBe(false);
  });

  it('exits unarmed on volume fade vs entry baseline', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm6',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    const early = decideMarkExit({
      mint: 'm6',
      pos: p,
      markPriceUsd: 98,
      gates,
      nowMs: openedAtMs + 300_000,
      volume5mUsd: 900,
    });
    expect(early?.shouldExit).toBe(false);

    const d = decideMarkExit({
      mint: 'm6',
      pos: p,
      markPriceUsd: 98,
      gates,
      nowMs: openedAtMs + 600_000,
      volume5mUsd: 900,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_vol_fade');
  });

  it('exits unarmed on absolute volume floor with no entry baseline', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm7',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    const d = decideMarkExit({
      mint: 'm7',
      pos: p,
      markPriceUsd: 99,
      gates,
      nowMs: openedAtMs + 900_000,
      volume5mUsd: 120,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_vol_fade');
  });

  it('does not vol-fade an armed position', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm8',
      entryPriceUsd: 100,
      peakPriceUsd: 120,
      trailArmed: true,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    const d = decideMarkExit({
      mint: 'm8',
      pos: p,
      markPriceUsd: 118,
      gates,
      nowMs: openedAtMs + 1_800_000,
      volume5mUsd: 50,
    });
    expect(d?.shouldExit).toBe(false);
  });

  it('sticky exitPendingReason forces sell and freezes peak through a bounce', () => {
    const p = pos({
      mint: 'mSticky',
      entryPriceUsd: 100,
      peakPriceUsd: 130,
      trailArmed: true,
      exitPendingReason: 'peak_giveback',
      openedAtMs: 1_000_000,
    });
    // Bounce above giveback threshold — without sticky this would not exit.
    const d = decideMarkExit({
      mint: 'mSticky',
      pos: p,
      markPriceUsd: 140,
      gates,
      nowMs: 1_060_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('peak_giveback');
    expect(d?.peakPriceUsd).toBe(130); // frozen — bounce must not raise HWM
    expect(d?.sellFraction).toBe(1);
    applyMarkDecisionToPosition(p, d!);
    expect(p.peakPriceUsd).toBe(130);
  });

  it('ladder: first giveback peels 50%, second giveback after partialTaken dumps rest', () => {
    const ladderGates = {
      ...gates,
      armPct: 5,
      givebackPct: 3,
      partialSellFraction: 0.5,
      secondGivebackPct: 5,
    };
    const p = pos({
      mint: 'mLadder',
      entryPriceUsd: 100,
      peakPriceUsd: 110,
      trailArmed: true,
      openedAtMs: 1_000_000,
    });
    const first = decideMarkExit({
      mint: 'mLadder',
      pos: p,
      markPriceUsd: 110 * 0.97,
      gates: ladderGates,
      nowMs: 1_060_000,
    });
    expect(first?.reason).toBe('peak_giveback_partial');
    expect(first?.sellFraction).toBe(0.5);

    p.exitPartialTaken = true;
    p.peakPriceUsd = 110 * 0.97;
    const second = decideMarkExit({
      mint: 'mLadder',
      pos: p,
      markPriceUsd: p.peakPriceUsd! * 0.95,
      gates: ladderGates,
      nowMs: 1_090_000,
    });
    expect(second?.reason).toBe('peak_giveback');
    expect(second?.sellFraction).toBe(1);
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
