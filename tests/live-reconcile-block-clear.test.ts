/**
 * Regression: strict notional parity sets `reconcileBlocksNewExposure` via `setLiveReconcileBlock(true)`.
 * Phase 5 must refuse new exposure until `clearLiveReconcileBlock()` (or TTL).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import type { LiveOscarStrategyDeps } from '../src/live/phase4-types.js';
import {
  clearLiveReconcileBlock,
  liveReconcileBlocksNewExposure,
  setLiveReconcileBlock,
} from '../src/live/live-reconcile-state.js';
import { phase5AllowIncreaseExposure } from '../src/live/phase5-gates.js';

describe('live reconcile sticky block (Phase 5 gate)', () => {
  const liveCfg = {
    strategyEnabled: true,
    executionMode: 'live',
    liveKillAfterConsecFail: 0,
    liveMaxOpenPositions: undefined,
    liveMaxPositionUsd: undefined,
    liveMinWalletSol: undefined,
    liveFreeSolBufferLamports: 0,
    liveEntryMinFreeMult: 1,
    liveEntryNotionalUsd: 10,
    liveSimCreditsPerCall: 1,
    liveSimTimeoutMs: 5000,
    liveCapitalRotateCascade: false,
  } as LiveOscarConfig;

  const deps: LiveOscarStrategyDeps = {
    getOpen: () => new Map(),
    getClosed: () => [],
  };

  beforeEach(() => clearLiveReconcileBlock());
  afterEach(() => clearLiveReconcileBlock());

  it('refuses increase exposure when reconcile block flag is set (before SOL/RPC gates)', async () => {
    setLiveReconcileBlock(true);
    const allowed = await phase5AllowIncreaseExposure({
      liveCfg,
      deps,
      paperPositionUsd: 10,
      intendedUsd: 10,
      isNewPosition: true,
    });
    expect(allowed).toBe(false);
    expect(liveReconcileBlocksNewExposure()).toBe(true);
  });

  it('clearLiveReconcileBlock removes the reconcile-only hard stop', async () => {
    setLiveReconcileBlock(true);
    expect(liveReconcileBlocksNewExposure()).toBe(true);
    clearLiveReconcileBlock();
    expect(liveReconcileBlocksNewExposure()).toBe(false);
  });
});
