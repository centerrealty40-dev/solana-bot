import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMildDipState, saveMildDipState } from '../../src/milddip/state.js';

describe('mild-dip state', () => {
  it('persists and hydrates a mirror leader-sell intent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mild-dip-state-'));
    const statePath = path.join(dir, 'state.json');
    const state = {
      open: {
        MintIntent: {
          mint: 'MintIntent',
          symbol: 'TEST',
          entryPriceUsd: 1,
          sizeUsd: 10,
          tokenRaw: null,
          openedAtMs: 1_000,
          entryPc5mPct: 0,
          buySignature: null,
          lane: 'leader_mirror' as const,
          leaderMirrorLeader: 'Leader111',
          mirrorLeaderSellIntent: {
            leader: 'Leader111',
            signature: 'sell-signature',
            leaderBlockTimeMs: 2_000,
            detectedAtMs: 3_000,
            attemptCount: 1,
          },
        },
      },
      cooldownUntilMs: {},
      updatedAtMs: 3_000,
    };
    saveMildDipState(statePath, state);
    expect(loadMildDipState(statePath).open.MintIntent.mirrorLeaderSellIntent).toEqual(
      state.open.MintIntent.mirrorLeaderSellIntent,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists and hydrates mirror watches and decisions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mild-dip-watch-state-'));
    const statePath = path.join(dir, 'state.json');
    const state = {
      open: {},
      cooldownUntilMs: {},
      leaderMirrorWatches: {
        'MintWatch:Leader111': {
          hit: {
            mint: 'MintWatch',
            leader: 'Leader111',
            lastSeenAtMs: 2_000,
            fillPriceUsd: 1,
            blockTime: 2,
          },
          hitKey: 'MintWatch:Leader111:2',
          startedAtMs: 2_000,
          expiresAtMs: 3_000,
          metricSource: 'seed' as const,
        },
      },
      leaderMirrorDecisions: {
        'MintOld:Leader111': {
          hitKey: 'old',
          decidedAtMs: 2_000,
          reason: 'leader_mirror_execution_skip',
        },
      },
      updatedAtMs: 2_000,
    };
    saveMildDipState(statePath, state);
    const loaded = loadMildDipState(statePath);
    expect(loaded.leaderMirrorWatches).toEqual(state.leaderMirrorWatches);
    expect(loaded.leaderMirrorDecisions).toEqual(state.leaderMirrorDecisions);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
