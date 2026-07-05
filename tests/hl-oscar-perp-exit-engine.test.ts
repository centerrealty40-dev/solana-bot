import { describe, expect, it } from 'vitest';

import type { HlOscarPerpConfig } from '../src/hyperliquid/oscar-perp/config.js';
import {
  computeOscarExitActions,
  OSCAR_EXIT_DEFAULTS,
  positionKillFrac,
  resolveOscarExitParams,
} from '../src/hyperliquid/oscar-perp/exit-engine.js';
import type { OscarOpenPosition } from '../src/hyperliquid/oscar-perp/position-types.js';

function testCfg(overrides: Partial<HlOscarPerpConfig> = {}): HlOscarPerpConfig {
  return {
    positionKillDropPct: 45,
    stagedKillDropPct: 45,
    timeStopHours: 12,
    remainderClosePct: 10,
    tpRungs: [0.08, 0.12, 0.16],
    trailArmFrac: 0.08,
    trailStepDropFrac: 0.025,
    tpSellFrac: 0.5,
    trailSellFrac: 0.2,
    ...overrides,
  } as HlOscarPerpConfig;
}

function testPos(overrides: Partial<OscarOpenPosition> = {}): OscarOpenPosition {
  return {
    avgEntryPx: 100,
    signalPrice: 100,
    remainingFraction: 1,
    tpLevelsTaken: new Set(),
    trailLevelsTaken: new Set(),
    maxTpTaken: 0,
    peakPnlFrac: -Infinity,
    trailAnchor: 0,
    preArmReached: false,
    entryTs: Date.now() - 3_600_000,
    ...overrides,
  } as OscarOpenPosition;
}

describe('hl-oscar-perp exit-engine kill', () => {
  it('positionKillFrac defaults to −45%', () => {
    expect(positionKillFrac(testCfg())).toBeCloseTo(-0.45);
  });

  it('fires KILL at −45% vs avg entry', () => {
    const cfg = testCfg();
    const pos = testPos({ signalPrice: 80 });
    const actions = computeOscarExitActions(pos, cfg, 56, 54, 56, Date.now());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'full', reason: 'KILL' });
    expect((actions[0] as { triggerPx: number }).triggerPx).toBeCloseTo(55, 5);
  });

  it('does not fire KILL at −44% vs avg entry', () => {
    const cfg = testCfg();
    const pos = testPos({ signalPrice: 80 });
    const actions = computeOscarExitActions(pos, cfg, 57, 56.1, 57, Date.now());
    expect(actions.some((a) => a.kind === 'full' && a.reason === 'KILL')).toBe(false);
  });

  it('fires STAGED_KILL at −45% from signal before position kill', () => {
    const cfg = testCfg();
    const pos = testPos({ avgEntryPx: 80, signalPrice: 100 });
    const actions = computeOscarExitActions(pos, cfg, 56, 54, 56, Date.now());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'full', reason: 'STAGED_KILL' });
    expect((actions[0] as { triggerPx: number }).triggerPx).toBeCloseTo(55, 5);
  });
});

describe('hl-oscar-perp exit-engine TP ladder', () => {
  it('defaults tpRungs to +5%, +7.5%, +10% with 50% sell each', () => {
    const exit = resolveOscarExitParams({ ...testCfg(), tpRungs: [] } as HlOscarPerpConfig);
    expect(exit.tpRungs).toEqual([0.05, 0.075, 0.1]);
    expect(exit.tpSellFrac).toBe(0.5);
    expect(exit.trailArmFrac).toBe(0.08);
    expect(OSCAR_EXIT_DEFAULTS.tpRungs).toEqual([0.05, 0.075, 0.1]);
  });

  it('reads custom TP rungs from config', () => {
    const exit = resolveOscarExitParams(testCfg({ tpRungs: [0.05, 0.075, 0.1] }));
    expect(exit.tpRungs).toEqual([0.05, 0.075, 0.1]);
  });

  it('fires TP level 1 at +8%', () => {
    const cfg = testCfg();
    const pos = testPos();
    const actions = computeOscarExitActions(pos, cfg, 108, 100, 108, Date.now());
    const tp = actions.filter((a) => a.kind === 'partial' && a.reason === 'TP');
    expect(tp).toHaveLength(1);
    expect(tp[0]).toMatchObject({ fraction: 0.5, level: 1 });
    expect(pos.tpLevelsTaken.has(0)).toBe(true);
    expect(pos.maxTpTaken).toBeCloseTo(0.08);
  });

  it('fires TP levels 1–3 at +16% high', () => {
    const cfg = testCfg();
    const pos = testPos();
    const actions = computeOscarExitActions(pos, cfg, 116, 100, 116, Date.now());
    const tp = actions.filter((a) => a.kind === 'partial' && a.reason === 'TP');
    expect(tp).toHaveLength(3);
    expect(tp.map((a) => (a as { level: number }).level)).toEqual([1, 2, 3]);
    expect(tp.every((a) => a.fraction === 0.5)).toBe(true);
  });

  it('does not fire TP below +8%', () => {
    const cfg = testCfg();
    const pos = testPos();
    const actions = computeOscarExitActions(pos, cfg, 107, 100, 107, Date.now());
    expect(actions.some((a) => a.reason === 'TP')).toBe(false);
  });
});

describe('hl-oscar-perp exit-engine trail', () => {
  it('arms trail from +8% peak', () => {
    const cfg = testCfg();
    const pos = testPos();
    computeOscarExitActions(pos, cfg, 108, 100, 108, Date.now());
    expect(pos.preArmReached).toBe(true);
  });

  it('fires TRAIL after −2.5% drop from peak when armed', () => {
    const cfg = testCfg();
    const pos = testPos({ peakPnlFrac: 0.09, preArmReached: true, trailAnchor: 0.09 });
    const actions = computeOscarExitActions(pos, cfg, 106.5, 106.4, 106.5, Date.now());
    const trail = actions.filter((a) => a.kind === 'partial' && a.reason === 'TRAIL');
    expect(trail.length).toBeGreaterThanOrEqual(1);
    expect(trail[0]!.fraction).toBe(0.2);
  });
});

describe('hl-oscar-perp exit-engine breakeven', () => {
  it('fires BREAKEVEN at ≤0% after first TP (+8%)', () => {
    const cfg = testCfg();
    const pos = testPos({
      maxTpTaken: 0.08,
      preArmReached: true,
      tpLevelsTaken: new Set([0]),
      peakPnlFrac: 0.08,
    });
    const actions = computeOscarExitActions(pos, cfg, 100, 99, 100, Date.now());
    expect(actions.some((a) => a.kind === 'full' && a.reason === 'BREAKEVEN')).toBe(true);
  });

  it('does not fire BREAKEVEN before trail arm', () => {
    const cfg = testCfg();
    const pos = testPos();
    const actions = computeOscarExitActions(pos, cfg, 100, 99, 100, Date.now());
    expect(actions.some((a) => a.reason === 'BREAKEVEN')).toBe(false);
  });
});

describe('hl-oscar-perp exit-engine time stop', () => {
  it('fires TIME_STOP after 12h', () => {
    const cfg = testCfg({ timeStopHours: 12 });
    const pos = testPos({ entryTs: Date.now() - 13 * 3_600_000 });
    const actions = computeOscarExitActions(pos, cfg, 100, 100, 100, Date.now());
    expect(actions.some((a) => a.kind === 'full' && a.reason === 'TIME_STOP')).toBe(true);
  });

  it('does not fire TIME_STOP when timeStopHours is 0', () => {
    const cfg = testCfg({ timeStopHours: 0 });
    const pos = testPos({ entryTs: Date.now() - 48 * 3_600_000 });
    const actions = computeOscarExitActions(pos, cfg, 100, 100, 100, Date.now());
    expect(actions.some((a) => a.reason === 'TIME_STOP')).toBe(false);
  });
});

describe('hl-oscar-perp exit-engine remainder flush', () => {
  it('fires REMAINDER_FLUSH when remaining ≤ 10% of original', () => {
    const cfg = testCfg({ remainderClosePct: 10 });
    const pos = testPos({ remainingFraction: 0.08, totalGrossUsd: 100 });
    const actions = computeOscarExitActions(pos, cfg, 100, 100, 100, Date.now());
    expect(actions).toEqual([{ kind: 'full', reason: 'REMAINDER_FLUSH' }]);
  });

  it('does not flush at 12.5% remaining (after 3×50% TP ladder)', () => {
    const cfg = testCfg({ remainderClosePct: 10 });
    const pos = testPos({ remainingFraction: 0.125, totalGrossUsd: 100 });
    const actions = computeOscarExitActions(pos, cfg, 100, 100, 100, Date.now());
    expect(actions.some((a) => a.reason === 'REMAINDER_FLUSH')).toBe(false);
  });

  it('does not preempt KILL when remainder is tiny', () => {
    const cfg = testCfg();
    const pos = testPos({
      remainingFraction: 0.05,
      signalPrice: 50,
      avgEntryPx: 100,
    });
    const actions = computeOscarExitActions(pos, cfg, 55, 54, 55, Date.now());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'full', reason: 'KILL' });
  });

  it('$100 → 3 partials → $8 left triggers flush on next tick', () => {
    const cfg = testCfg({ remainderClosePct: 10 });
    let pos = testPos({ totalGrossUsd: 100 });
    computeOscarExitActions(pos, cfg, 116, 100, 116, Date.now());
    pos = { ...pos, remainingFraction: 0.125 };
    let actions = computeOscarExitActions(pos, cfg, 103, 103, 103, Date.now());
    expect(actions.some((a) => a.reason === 'REMAINDER_FLUSH')).toBe(false);
    pos = { ...pos, remainingFraction: 0.125 * (1 - 0.2) };
    actions = computeOscarExitActions(pos, cfg, 103, 103, 103, Date.now());
    expect(actions).toEqual([{ kind: 'full', reason: 'REMAINDER_FLUSH' }]);
  });
});
