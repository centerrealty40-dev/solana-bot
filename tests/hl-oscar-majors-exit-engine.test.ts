import { describe, expect, it } from 'vitest';

import type { HlOscarMajorsConfig } from '../src/hyperliquid/oscar-majors/config.js';
import {
  computeMajorsExitActions,
  positionKillFrac,
  resolveMajorsExitParams,
} from '../src/hyperliquid/oscar-majors/exit-engine.js';
import type { OscarOpenPosition } from '../src/hyperliquid/oscar-majors/position-types.js';

function testCfg(overrides: Partial<HlOscarMajorsConfig> = {}): HlOscarMajorsConfig {
  return {
    positionKillDropPct: 15,
    stagedKillDropPct: 10,
    timeStopHours: 12,
    btcTpRungs: [0.02, 0.03, 0.04],
    ethTpRungs: [0.015, 0.02, 0.025],
    tpSellFrac: 0.5,
    trailSellFrac: 0.25,
    btcTrailArmFrac: 0.02,
    btcTrailStepDropFrac: 0.01,
    ethTrailArmFrac: 0.015,
    ethTrailStepDropFrac: 0.008,
    ...overrides,
  } as HlOscarMajorsConfig;
}

function testPos(overrides: Partial<OscarOpenPosition> = {}): OscarOpenPosition {
  return {
    coin: 'BTC',
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

describe('hl-oscar-majors exit-engine kill', () => {
  it('positionKillFrac defaults to −15%', () => {
    expect(positionKillFrac(testCfg())).toBeCloseTo(-0.15);
  });

  it('fires KILL at −15% vs avg entry', () => {
    const cfg = testCfg();
    const pos = testPos({ signalPrice: 80 });
    const actions = computeMajorsExitActions(pos, cfg, 86, 84, 86, Date.now());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'full', reason: 'KILL' });
    expect((actions[0] as { triggerPx: number }).triggerPx).toBeCloseTo(85, 5);
  });

  it('fires STAGED_KILL at −10% from signal', () => {
    const cfg = testCfg();
    const pos = testPos({ avgEntryPx: 95, signalPrice: 100 });
    const actions = computeMajorsExitActions(pos, cfg, 90, 89, 90, Date.now());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'full', reason: 'STAGED_KILL' });
    expect((actions[0] as { triggerPx: number }).triggerPx).toBeCloseTo(90, 5);
  });
});

describe('hl-oscar-majors exit-engine BTC TP ladder', () => {
  it('resolveMajorsExitParams returns BTC rungs for BTC', () => {
    const params = resolveMajorsExitParams(testCfg(), 'BTC');
    expect(params.tpRungs).toEqual([0.02, 0.03, 0.04]);
    expect(params.trailArmFrac).toBe(0.02);
    expect(params.trailStepDropFrac).toBe(0.01);
  });

  it('fires TP level 1 at +2%', () => {
    const cfg = testCfg();
    const pos = testPos({ coin: 'BTC' });
    const actions = computeMajorsExitActions(pos, cfg, 102, 100, 102, Date.now());
    const tp = actions.filter((a) => a.kind === 'partial' && a.reason === 'TP');
    expect(tp).toHaveLength(1);
    expect(tp[0]).toMatchObject({ fraction: 0.5, level: 1 });
  });

  it('fires TP levels 1–3 at +4% high', () => {
    const cfg = testCfg();
    const pos = testPos({ coin: 'BTC' });
    const actions = computeMajorsExitActions(pos, cfg, 104, 100, 104, Date.now());
    const tp = actions.filter((a) => a.kind === 'partial' && a.reason === 'TP');
    expect(tp).toHaveLength(3);
    expect(tp.map((a) => (a as { level: number }).level)).toEqual([1, 2, 3]);
  });
});

describe('hl-oscar-majors exit-engine ETH TP ladder', () => {
  it('resolveMajorsExitParams returns ETH rungs for ETH', () => {
    const params = resolveMajorsExitParams(testCfg(), 'ETH');
    expect(params.tpRungs).toEqual([0.015, 0.02, 0.025]);
    expect(params.trailArmFrac).toBe(0.015);
    expect(params.trailStepDropFrac).toBe(0.008);
  });

  it('fires ETH TP level 1 at +1.5%', () => {
    const cfg = testCfg();
    const pos = testPos({ coin: 'ETH' });
    const actions = computeMajorsExitActions(pos, cfg, 101.5, 100, 101.5, Date.now());
    const tp = actions.filter((a) => a.kind === 'partial' && a.reason === 'TP');
    expect(tp).toHaveLength(1);
    expect(tp[0]).toMatchObject({ fraction: 0.5, level: 1 });
  });

  it('does not fire ETH TP below +1.5%', () => {
    const cfg = testCfg();
    const pos = testPos({ coin: 'ETH' });
    const actions = computeMajorsExitActions(pos, cfg, 101.4, 100, 101.4, Date.now());
    expect(actions.some((a) => a.reason === 'TP')).toBe(false);
  });
});

describe('hl-oscar-majors exit-engine trail', () => {
  it('BTC trail fires after −1% drop from peak when armed @ +2%', () => {
    const cfg = testCfg();
    const pos = testPos({
      coin: 'BTC',
      peakPnlFrac: 0.03,
      preArmReached: true,
      trailAnchor: 0.03,
    });
    const actions = computeMajorsExitActions(pos, cfg, 102, 101.9, 102, Date.now());
    const trail = actions.filter((a) => a.kind === 'partial' && a.reason === 'TRAIL');
    expect(trail.length).toBeGreaterThanOrEqual(1);
    expect(trail[0]!.fraction).toBe(0.25);
  });

  it('ETH trail fires after −0.8% drop from peak when armed @ +1.5%', () => {
    const cfg = testCfg();
    const pos = testPos({
      coin: 'ETH',
      peakPnlFrac: 0.02,
      preArmReached: true,
      trailAnchor: 0.02,
    });
    const actions = computeMajorsExitActions(pos, cfg, 101.2, 101.1, 101.2, Date.now());
    const trail = actions.filter((a) => a.kind === 'partial' && a.reason === 'TRAIL');
    expect(trail.length).toBeGreaterThanOrEqual(1);
    expect(trail[0]!.fraction).toBe(0.25);
  });
});

describe('hl-oscar-majors exit-engine time stop', () => {
  it('fires TIME_STOP after 12h', () => {
    const cfg = testCfg({ timeStopHours: 12 });
    const pos = testPos({ entryTs: Date.now() - 13 * 3_600_000 });
    const actions = computeMajorsExitActions(pos, cfg, 100, 100, 100, Date.now());
    expect(actions.some((a) => a.kind === 'full' && a.reason === 'TIME_STOP')).toBe(true);
  });
});
