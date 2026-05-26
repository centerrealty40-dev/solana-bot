/** 1.11.231 — unit tests для auto-permanent-denylist по cooldown rearms. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  configureStagedAddSimCooldown,
  recordStagedAddOutcome,
  _resetStagedAddCooldownForTests,
} from '../src/live/staged-add-sim-cooldown.js';
import {
  invalidateLivePermanentDenylistCache,
  loadPermanentDenylistCombined,
} from '../src/live/mint-permanent-denylist.js';
import type { LiveOscarConfig } from '../src/live/config.js';

vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: vi.fn(),
}));

vi.mock('../src/core/telegram/sender.js', () => ({
  sendTagged: vi.fn(async () => true),
}));

const MINT_A = 'CooLdownAuto11111111111111111111111111111A';

function makeTmpDenylistCfg(): { cfg: LiveOscarConfig; localPath: string; seedPath: string; cleanup: () => void } {
  const localPath = path.join(os.tmpdir(), `live-denylist-test-${Date.now()}-${Math.random()}.txt`);
  const seedPath = path.join(os.tmpdir(), `live-denylist-seed-${Date.now()}-${Math.random()}.txt`);
  const cfg = {
    livePermanentDenylistDisabled: false,
    livePermanentDenylistLocalPath: localPath,
    livePermanentDenylistSeedPath: seedPath,
  } as unknown as LiveOscarConfig;
  return {
    cfg,
    localPath,
    seedPath,
    cleanup: () => {
      try { fs.unlinkSync(localPath); } catch { /* */ }
      try { fs.unlinkSync(seedPath); } catch { /* */ }
    },
  };
}

describe('auto-denylist on cooldown rearms', () => {
  let tmp: ReturnType<typeof makeTmpDenylistCfg>;

  beforeEach(() => {
    invalidateLivePermanentDenylistCache();
    _resetStagedAddCooldownForTests();
    tmp = makeTmpDenylistCfg();
  });
  afterEach(() => {
    tmp.cleanup();
    invalidateLivePermanentDenylistCache();
  });

  it('adds mint to permanent-denylist after N rearms', () => {
    configureStagedAddSimCooldown(
      {
        streakThreshold: 2,
        cooldownMs: 1000,
        autoDenylistEnabled: true,
        autoDenylistRearmsThreshold: 3,
        autoDenylistTelegramEnabled: false,
      },
      tmp.cfg,
    );

    /** Arm cooldown 3 раза (3 rearm'а на одном mint). */
    for (let i = 0; i < 3; i++) {
      /** Сначала reset (success) → потом 2 sim_err для arm. */
      if (i > 0) {
        recordStagedAddOutcome({ mint: MINT_A, intentKind: 'dca_add', kind: 'success' });
      }
      recordStagedAddOutcome({
        mint: MINT_A,
        intentKind: 'dca_add',
        kind: 'sim_err',
        terminalMessage: 'sim_failed:Custom:1',
      });
      recordStagedAddOutcome({
        mint: MINT_A,
        intentKind: 'dca_add',
        kind: 'sim_err',
        terminalMessage: 'sim_failed:Custom:1',
      });
    }

    const denylist = loadPermanentDenylistCombined(tmp.cfg);
    expect(denylist.has(MINT_A)).toBe(true);
  });

  it('does NOT add mint when autoDenylistEnabled=false', () => {
    configureStagedAddSimCooldown(
      {
        streakThreshold: 2,
        cooldownMs: 1000,
        autoDenylistEnabled: false,
        autoDenylistRearmsThreshold: 1,
        autoDenylistTelegramEnabled: false,
      },
      tmp.cfg,
    );

    recordStagedAddOutcome({ mint: MINT_A, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint: MINT_A, intentKind: 'dca_add', kind: 'sim_err' });

    invalidateLivePermanentDenylistCache();
    const denylist = loadPermanentDenylistCombined(tmp.cfg);
    expect(denylist.has(MINT_A)).toBe(false);
  });

  it('only adds once even if rearms continue past threshold', () => {
    configureStagedAddSimCooldown(
      {
        streakThreshold: 2,
        cooldownMs: 1000,
        autoDenylistEnabled: true,
        autoDenylistRearmsThreshold: 2,
        autoDenylistTelegramEnabled: false,
      },
      tmp.cfg,
    );

    for (let i = 0; i < 5; i++) {
      recordStagedAddOutcome({ mint: MINT_A, intentKind: 'dca_add', kind: 'success' });
      recordStagedAddOutcome({ mint: MINT_A, intentKind: 'dca_add', kind: 'sim_err' });
      recordStagedAddOutcome({ mint: MINT_A, intentKind: 'dca_add', kind: 'sim_err' });
    }

    invalidateLivePermanentDenylistCache();
    const body = fs.existsSync(tmp.localPath) ? fs.readFileSync(tmp.localPath, 'utf8') : '';
    const lines = body.split(/\n/).filter((l) => l.trim().split('#')[0]?.trim() === MINT_A);
    expect(lines.length).toBe(1);
  });
});
