import { describe, expect, it } from 'vitest';
import {
  defaultKnifeExitLadderConfig,
  ladderRetraceFloorPnlPct,
  ladderRetraceTriggered,
  markRungFired,
  newlyReachableRungs,
  nextGridRungPnl,
  parseKnifeGridSellFracs,
  peakTrailTriggered,
  sellFracForRungIndex,
  updatePeakTrailArm,
} from '../src/scripts/knife-exit-ladder.js';

const cfg = {
  gridStepPct: 5,
  gridSellFracs: [0.5, 0.45, 0.4, 0.35],
  beFloorPct: 0,
  retraceMinRungs: 2,
  trailArmPct: 10,
  trailDropPct: 5,
  killPct: 30,
};

describe('knife-exit-ladder grid', () => {
  it('builds +5%/+10%/+15% rungs and escalating sell fracs', () => {
    expect(nextGridRungPnl(cfg, 0)).toBe(5);
    expect(nextGridRungPnl(cfg, 1)).toBe(10);
    expect(sellFracForRungIndex(cfg, 0)).toBe(0.5);
    expect(sellFracForRungIndex(cfg, 3)).toBe(0.35);
    expect(sellFracForRungIndex(cfg, 9)).toBe(0.35);
  });

  it('fires multiple rungs in one tick when price gaps up', () => {
    expect(newlyReachableRungs(cfg, [], 12)).toEqual([0, 1]);
    expect(newlyReachableRungs(cfg, [5, 10], 16)).toEqual([2]);
  });

  it('marks rungs without duplicates', () => {
    expect(markRungFired([], 5)).toEqual([5]);
    expect(markRungFired([5], 5)).toEqual([5]);
    expect(markRungFired([5], 10)).toEqual([5, 10]);
  });
});

describe('knife-exit-ladder break-even / retrace', () => {
  it('uses BE floor after first partial TP', () => {
    expect(ladderRetraceFloorPnlPct(cfg, [5])).toBe(0);
    expect(ladderRetraceTriggered(cfg, [5], -0.5)).toBe(true);
    expect(ladderRetraceTriggered(cfg, [5], 1)).toBe(false);
  });

  it('uses previous rung floor after two partial TPs', () => {
    expect(ladderRetraceFloorPnlPct(cfg, [5, 10])).toBe(5);
    expect(ladderRetraceTriggered(cfg, [5, 10], 4.9)).toBe(true);
    expect(ladderRetraceTriggered(cfg, [5, 10], 6)).toBe(false);
  });
});

describe('knife-exit-ladder peak trail', () => {
  it('arms at +10% and exits on 5pt drop from peak PnL', () => {
    let snap = updatePeakTrailArm(cfg, { firedRungPnls: [5], peakPnlPct: 0, trailArmed: false }, 9);
    expect(snap.trailArmed).toBe(false);
    snap = updatePeakTrailArm(cfg, snap, 11);
    expect(snap.trailArmed).toBe(true);
    expect(snap.peakPnlPct).toBe(11);
    expect(peakTrailTriggered(cfg, snap, 6)).toBe(true);
    expect(peakTrailTriggered(cfg, snap, 7)).toBe(false);
  });
});

describe('defaultKnifeExitLadderConfig', () => {
  it('defaults kill to 30 and avg leg off via separate env', () => {
    const d = defaultKnifeExitLadderConfig({});
    expect(d.killPct).toBe(30);
    expect(d.gridStepPct).toBe(5);
    expect(d.gridSellFracs).toEqual([0.5, 0.45, 0.4, 0.35]);
  });

  it('parses sell fracs from env string', () => {
    expect(parseKnifeGridSellFracs('0.6, 0.4', [0.5])).toEqual([0.6, 0.4]);
    expect(parseKnifeGridSellFracs('bad', [0.5])).toEqual([0.5]);
  });
});
