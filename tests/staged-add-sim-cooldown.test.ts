/**
 * 1.11.230 — staged-add sim_err cooldown unit tests.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  configureStagedAddSimCooldown,
  isStagedAddCooldownActive,
  recordStagedAddOutcome,
  stagedAddCooldownDebugSnapshot,
  stagedAddCooldownRemainingMs,
  _resetStagedAddCooldownForTests,
} from '../src/live/staged-add-sim-cooldown.js';

vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: vi.fn(),
}));

describe('staged-add sim_err cooldown', () => {
  beforeEach(() => {
    _resetStagedAddCooldownForTests();
    configureStagedAddSimCooldown({ streakThreshold: 3, cooldownMs: 30 * 60_000 });
  });

  it('does not block before reaching the streak threshold', () => {
    const mint = 'MintA';
    expect(isStagedAddCooldownActive({ mint, intentKind: 'dca_add' })).toBe(false);
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'dca_add' })).toBe(false);
  });

  it('activates cooldown at exactly the threshold and blocks subsequent attempts', () => {
    const mint = 'MintB';
    recordStagedAddOutcome({ mint, intentKind: 'buy_scale_in', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'buy_scale_in', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'buy_scale_in', kind: 'sim_err' });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'buy_scale_in' })).toBe(true);
    expect(stagedAddCooldownRemainingMs({ mint, intentKind: 'buy_scale_in' })).toBeGreaterThan(0);
  });

  it('isolates per-(mint, intentKind) — cooldown for one does not affect another', () => {
    const mint = 'MintC';
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'dca_add' })).toBe(true);
    expect(isStagedAddCooldownActive({ mint, intentKind: 'buy_scale_in' })).toBe(false);
    expect(isStagedAddCooldownActive({ mint, intentKind: 'buy_open' })).toBe(false);
    expect(isStagedAddCooldownActive({ mint: 'OtherMint', intentKind: 'dca_add' })).toBe(false);
  });

  it('success resets streak and cooldown', () => {
    const mint = 'MintD';
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'dca_add' })).toBe(true);
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'success' });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'dca_add' })).toBe(false);
    expect(stagedAddCooldownRemainingMs({ mint, intentKind: 'dca_add' })).toBe(0);
  });

  it('"other" terminal outcome (confirm_timeout / send_failed) resets streak', () => {
    const mint = 'MintE';
    recordStagedAddOutcome({ mint, intentKind: 'buy_open', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'buy_open', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'buy_open', kind: 'other' });
    /** non-sim_err resets the streak — next sim_err starts the count from 1 again */
    expect(isStagedAddCooldownActive({ mint, intentKind: 'buy_open' })).toBe(false);
    recordStagedAddOutcome({ mint, intentKind: 'buy_open', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'buy_open', kind: 'sim_err' });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'buy_open' })).toBe(false);
  });

  it('cooldown expires after the configured ms', () => {
    const mint = 'MintF';
    const fakeNow = 1_000_000_000_000;
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err', nowMs: fakeNow });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err', nowMs: fakeNow });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err', nowMs: fakeNow });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'dca_add', nowMs: fakeNow + 1_000 })).toBe(true);
    expect(
      isStagedAddCooldownActive({ mint, intentKind: 'dca_add', nowMs: fakeNow + 30 * 60_000 + 1 }),
    ).toBe(false);
  });

  it('honours custom streak threshold = 1 (block on first sim_err)', () => {
    configureStagedAddSimCooldown({ streakThreshold: 1, cooldownMs: 5 * 60_000 });
    const mint = 'MintG';
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    expect(isStagedAddCooldownActive({ mint, intentKind: 'dca_add' })).toBe(true);
  });

  it('debug snapshot exposes per-key streak + blockedAttempts after isActive calls', () => {
    const mint = 'MintH';
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    recordStagedAddOutcome({ mint, intentKind: 'dca_add', kind: 'sim_err' });
    isStagedAddCooldownActive({ mint, intentKind: 'dca_add' });
    isStagedAddCooldownActive({ mint, intentKind: 'dca_add' });
    const snap = stagedAddCooldownDebugSnapshot();
    const entry = snap.find((e) => e.mint === mint);
    expect(entry).toBeTruthy();
    expect(entry?.streak).toBe(3);
    expect(entry?.blockedAttempts).toBe(2);
  });
});
