import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMildDipState, mildDipStateSaveBlocked, saveMildDipState } from '../../src/milddip/state.js';

describe('mild-dip state', () => {
  it('persists nonnegative green exit hold fields and drops invalid values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mild-dip-green-hold-state-'));
    const statePath = path.join(dir, 'state.json');
    saveMildDipState(statePath, {
      open: {
        MintGreen111111111111111111111111111111111111: {
          mint: 'MintGreen111111111111111111111111111111111111',
          symbol: 'GREEN',
          entryPriceUsd: 1,
          sizeUsd: 5,
          tokenRaw: null,
          openedAtMs: 1_000,
          entryPc5mPct: 0,
          buySignature: null,
          greenExitHoldMs: 12_000,
          greenExitHoldAtMs: 2_000,
          greenExitHoldReentries: 1,
        },
        MintInvalid111111111111111111111111111111111111: {
          mint: 'MintInvalid111111111111111111111111111111111111',
          symbol: 'BAD',
          entryPriceUsd: 1,
          sizeUsd: 5,
          tokenRaw: null,
          openedAtMs: 1_000,
          entryPc5mPct: 0,
          buySignature: null,
          greenExitHoldMs: -1,
          greenExitHoldAtMs: -1,
          greenExitHoldReentries: 'bad' as unknown as number,
        },
      },
      cooldownUntilMs: {},
      updatedAtMs: 2_000,
    });
    const loaded = loadMildDipState(statePath);
    expect(loaded.open.MintGreen111111111111111111111111111111111111).toMatchObject({
      greenExitHoldMs: 12_000,
      greenExitHoldAtMs: 2_000,
      greenExitHoldReentries: 1,
    });
    expect(loaded.open.MintInvalid111111111111111111111111111111111111).not.toHaveProperty('greenExitHoldMs');
    expect(loaded.open.MintInvalid111111111111111111111111111111111111).not.toHaveProperty('greenExitHoldAtMs');
    expect(loaded.open.MintInvalid111111111111111111111111111111111111).not.toHaveProperty('greenExitHoldReentries');
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
            sellFraction: null,
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
    const nowMs = Date.now();
    const state = {
      open: {},
      cooldownUntilMs: {},
      leaderMirrorWatches: {
        'MintWatch:Leader111': {
          hit: {
            mint: 'MintWatch',
            leader: 'Leader111',
            lastSeenAtMs: nowMs - 2_000,
            fillPriceUsd: 1,
            blockTime: 2,
          },
          hitKey: 'MintWatch:Leader111:2',
          startedAtMs: nowMs - 2_000,
          expiresAtMs: nowMs + 3_000,
          metricSource: 'seed' as const,
        },
      },
      leaderMirrorDecisions: {
        'MintOld:Leader111': {
          hitKey: 'old',
          decidedAtMs: nowMs - 2_000,
          reason: 'leader_mirror_execution_skip',
        },
      },
      updatedAtMs: nowMs,
    };
    saveMildDipState(statePath, state);
    const loaded = loadMildDipState(statePath);
    expect(loaded.leaderMirrorWatches).toEqual(state.leaderMirrorWatches);
    expect(loaded.leaderMirrorDecisions).toEqual(state.leaderMirrorDecisions);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a digit-only pre-exit balance and drops garbage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mild-dip-last-exit-'));
    const statePath = path.join(dir, 'state.json');
    saveMildDipState(statePath, {
      open: {},
      cooldownUntilMs: {},
      lastExitByMint: {
        MintKept1111111111111111111111111111111111: { priceUsd: 1, atMs: 1_000, preExitTokenRaw: '22878791411' },
        MintJunk1111111111111111111111111111111111: { priceUsd: 1, atMs: 1_000, preExitTokenRaw: 'not-a-number' },
      },
      updatedAtMs: 1_000,
    });
    const loaded = loadMildDipState(statePath);
    expect(loaded.lastExitByMint?.MintKept1111111111111111111111111111111111?.preExitTokenRaw).toBe('22878791411');
    expect(loaded.lastExitByMint?.MintJunk1111111111111111111111111111111111?.preExitTokenRaw).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists and validates leader open bags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mild-dip-open-bag-state-'));
    const statePath = path.join(dir, 'state.json');
    const state = {
      open: {},
      cooldownUntilMs: {},
      mirrorLeaderOpenBags: {
        'MintOpen|LeaderOpen': {
          mint: 'MintOpen1111111111111111111111111111111111',
          leader: 'LeaderOpen111111111111111111111111111111111',
          fillPriceUsd: 2,
          sizeUsd: 50,
          leaderBuyAtMs: 10_000,
          lastCheckAtMs: 20_000,
          lastReason: 'tracked',
        },
      },
      updatedAtMs: 20_000,
    };
    saveMildDipState(statePath, state);
    const loaded = loadMildDipState(statePath);
    expect(loaded.mirrorLeaderOpenBags).toEqual(state.mirrorLeaderOpenBags);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prunes stale mirror decisions and keeps only newest entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mild-dip-state-prune-'));
    const statePath = path.join(dir, 'state.json');
    const nowMs = 1_000_000;
    const decisions = Object.fromEntries(
      Array.from({ length: 520 }, (_, index) => [
        `Mint${index}`,
        {
          hitKey: `hit${index}`,
          decidedAtMs: nowMs - index * 100,
          reason: 'leader_mirror_execution_skip',
        },
      ]),
    );
    saveMildDipState(statePath, {
      open: {},
      cooldownUntilMs: {},
      leaderMirrorDecisions: {
        ...decisions,
        stale: {
          hitKey: 'stale',
          decidedAtMs: nowMs - 600_000,
          reason: 'leader_mirror_execution_skip',
        },
      },
      updatedAtMs: nowMs,
    });
    const loaded = loadMildDipState(statePath, {
      nowMs,
      mirrorObserveMs: 1_000,
    });
    expect(Object.keys(loaded.leaderMirrorDecisions ?? {})).toHaveLength(512);
    expect(loaded.leaderMirrorDecisions?.stale).toBeUndefined();
    expect(loaded.leaderMirrorDecisions?.Mint0).toBeDefined();
    expect(loaded.leaderMirrorDecisions?.Mint519).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('swallows state write failures and blocks entries after the configured limit', () => {
    const state = { open: {}, cooldownUntilMs: {}, updatedAtMs: 0 };
    const badPath = path.join('/dev/null', 'milddip-state.json');
    expect(saveMildDipState(badPath, state)).toBe(false);
    expect(saveMildDipState(badPath, state)).toBe(false);
    expect(saveMildDipState(badPath, state)).toBe(false);
    expect(mildDipStateSaveBlocked()).toBe(true);
  });
});
