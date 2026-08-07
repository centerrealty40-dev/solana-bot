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
    armPct: 5,
    partialGivebackPct: 3,
    scaleOutFraction: 0.5,
    givebackPct: 8,
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
    expect(d?.fraction).toBe(1);
    applyMarkDecisionToPosition(p, d!);
    // Still "open" until sell confirms — we only mutate trail fields here.
    expect(p.peakPriceUsd).toBe(108);
    expect(p.trailArmed).toBe(true);
  });

  it('queues peak_giveback_partial at −3% when scale-out not yet taken', () => {
    const p = pos({
      mint: 'm2b',
      entryPriceUsd: 100,
      peakPriceUsd: 105,
      trailArmed: true,
      scaleOutDone: false,
      openedAtMs: 1_000_000,
    });
    const d = decideMarkExit({
      mint: 'm2b',
      pos: p,
      markPriceUsd: 101.85, // −3% of 105
      gates,
      nowMs: 1_060_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('peak_giveback_partial');
    expect(d?.fraction).toBe(0.5);
  });

  it('queues never-arm stale after 10m flat + red (before dead)', () => {
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
      nowMs: openedAtMs + 600_000,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_stale');
  });

  it('queues never-arm dead after 30m when stale is off and MFE moved', () => {
    const openedAtMs = 1_000_000;
    const gatesNoStale = { ...gates, neverArmStaleMinMs: 0, neverArmStalePnlPct: 0 };
    const p = pos({
      mint: 'm4d',
      entryPriceUsd: 100,
      peakPriceUsd: 104, // MFE 4% — would skip stale even if on
      trailArmed: false,
      openedAtMs,
    });
    const early = decideMarkExit({
      mint: 'm4d',
      pos: p,
      markPriceUsd: 88, // −12%
      gates: gatesNoStale,
      nowMs: openedAtMs + 900_000,
    });
    expect(early?.shouldExit).toBeFalsy();
    const d = decideMarkExit({
      mint: 'm4d',
      pos: p,
      markPriceUsd: 88, // −12%
      gates: gatesNoStale,
      nowMs: openedAtMs + 1_800_000,
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

  it('does not sell on a one-shot volume dip (Gymbmn case)', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm6',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 8_672;
    // Alive windows, then a single weak dip — must NOT exit.
    for (const [held, vol] of [
      [300_000, 4_000],
      [600_000, 3_500],
      [900_000, 1_199], // one weak tick vs entry×0.25 / floor
    ] as const) {
      const d = decideMarkExit({
        mint: 'm6',
        pos: p,
        markPriceUsd: 98,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: vol,
      });
      expect(d?.shouldExit).toBe(false);
      applyMarkDecisionToPosition(p, d!);
    }
    expect(p.volFadeSamples?.length).toBe(3);
  });

  it('exits only after 3 consecutive weak 5m windows', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm7',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    const marks: Array<[number, number, boolean]> = [
      [300_000, 900, false], // before minMs
      [600_000, 900, false], // still < 3 windows + minMs
      [900_000, 900, true], // 3rd consecutive weak + ≥15m
    ];
    for (const [held, vol, expectExit] of marks) {
      const d = decideMarkExit({
        mint: 'm7',
        pos: p,
        markPriceUsd: 98,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: vol,
      });
      expect(d?.shouldExit).toBe(expectExit);
      if (expectExit) expect(d?.reason).toBe('never_arm_vol_fade');
      applyMarkDecisionToPosition(p, d!);
    }
  });

  it('resets the weak streak when a strong window appears', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm7b',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    p.entryVolume5mUsd = 4_000;
    for (const [held, vol] of [
      [300_000, 500],
      [600_000, 500],
      [900_000, 3_000], // strong — breaks streak
      [1_200_000, 500],
      [1_500_000, 500],
    ] as const) {
      const d = decideMarkExit({
        mint: 'm7b',
        pos: p,
        markPriceUsd: 98,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: vol,
      });
      expect(d?.shouldExit).toBe(false);
      applyMarkDecisionToPosition(p, d!);
    }
    // Need one more weak window to reach 3 consecutive after the break.
    const d = decideMarkExit({
      mint: 'm7b',
      pos: p,
      markPriceUsd: 98,
      gates,
      nowMs: openedAtMs + 1_800_000,
      volume5mUsd: 500,
    });
    expect(d?.shouldExit).toBe(true);
    expect(d?.reason).toBe('never_arm_vol_fade');
  });

  it('exits on sustained absolute floor with no entry baseline', () => {
    const openedAtMs = 1_000_000;
    const p = pos({
      mint: 'm7c',
      entryPriceUsd: 100,
      peakPriceUsd: 100,
      trailArmed: false,
      openedAtMs,
    });
    for (const held of [300_000, 600_000, 900_000] as const) {
      const d = decideMarkExit({
        mint: 'm7c',
        pos: p,
        markPriceUsd: 99,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: 120,
      });
      applyMarkDecisionToPosition(p, d!);
      if (held < 900_000) expect(d?.shouldExit).toBe(false);
      else {
        expect(d?.shouldExit).toBe(true);
        expect(d?.reason).toBe('never_arm_vol_fade');
      }
    }
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
    for (const held of [300_000, 600_000, 900_000, 1_200_000, 1_500_000, 1_800_000] as const) {
      const d = decideMarkExit({
        mint: 'm8',
        pos: p,
        markPriceUsd: 118,
        gates,
        nowMs: openedAtMs + held,
        volume5mUsd: 50,
      });
      expect(d?.shouldExit).toBe(false);
      applyMarkDecisionToPosition(p, d!);
    }
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
