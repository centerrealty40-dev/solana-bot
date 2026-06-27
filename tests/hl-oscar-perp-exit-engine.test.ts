import { describe, expect, it } from 'vitest';

import type { HlOscarPerpConfig } from '../src/hyperliquid/oscar-perp/config.js';
import { computeOscarExitActions, positionKillFrac } from '../src/hyperliquid/oscar-perp/exit-engine.js';
import type { OscarOpenPosition } from '../src/hyperliquid/oscar-perp/position-types.js';

function testCfg(overrides: Partial<HlOscarPerpConfig> = {}): HlOscarPerpConfig {
  return {
    positionKillDropPct: 45,
    stagedKillDropPct: 45,
    timeStopHours: 12,
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
