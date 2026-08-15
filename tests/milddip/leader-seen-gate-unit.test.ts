import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MildDipConfig } from '../../src/milddip/config.js';
import {
  leaderBuyGateOk,
  leaderEverSeenInState,
} from '../../src/milddip/leader-seen-gate.js';
import type { MildDipState } from '../../src/milddip/state.js';

function stubCfg(requireLeaderSeen: boolean): MildDipConfig {
  return {
    requireLeaderSeen,
    leaderSeenMemoryMs: 7 * 86_400_000,
    requireLeaderSeenMaxAgeMs: 7_200_000,
    leaderSeedPath: undefined,
    leaderSeedMax: 250,
  } as MildDipConfig;
}

describe('leader-seen-gate', () => {
  const mint = 'A'.repeat(44);
  const nowMs = 1_786_000_000_000;

  it('leaderBuyGateOk passes when gate off', () => {
    const cfg = stubCfg(false);
    expect(leaderBuyGateOk(cfg, {}, mint, nowMs)).toBe(true);
  });

  it('leaderBuyGateOk blocks unknown mint when gate on', () => {
    const cfg = stubCfg(true);
    expect(leaderBuyGateOk(cfg, {}, mint, nowMs)).toBe(false);
  });

  it('leaderEverSeenInState reads state memory', () => {
    const cfg = stubCfg(true);
    const state: MildDipState = {
      leaderSeenMints: { [mint]: nowMs - 60_000 },
    } as MildDipState;
    expect(leaderEverSeenInState(cfg, state, mint, nowMs)).toBe(true);
    expect(leaderBuyGateOk(cfg, state, mint, nowMs)).toBe(true);
  });

  it('entry-attempt wires final leader gate', () => {
    const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
    expect(src).toContain('leaderBuyGateOk');
    expect(src).toContain("at: 'entry'");
  });
});
