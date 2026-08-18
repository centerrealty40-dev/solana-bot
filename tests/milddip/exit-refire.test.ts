import { describe, expect, it } from 'vitest';
import { decideExitRefire } from '../../src/milddip/exit-refire.js';

const base = {
  lane: 'leader_mirror',
  sellReason: 'confirm_timeout',
  fraction: 1,
  attemptsUsed: 0,
  maxAttempts: 2,
  onchainRaw: 101n,
  dustRaw: 1n,
};

describe('decideExitRefire', () => {
  it('never refires non-mirror exits', () => {
    expect(decideExitRefire({ ...base, lane: 'dip' })).toBe('give_up');
  });

  it('stays disabled when maxAttempts is zero', () => {
    expect(decideExitRefire({ ...base, maxAttempts: 0 })).toBe('give_up');
  });

  it('settles when the chain is at dust', () => {
    expect(decideExitRefire({ ...base, onchainRaw: 1n })).toBe('settle_closed');
  });

  it('refires while attempts remain and a balance exists', () => {
    expect(decideExitRefire(base)).toBe('refire');
  });

  it('gives up after the configured attempts', () => {
    expect(decideExitRefire({ ...base, attemptsUsed: 2 })).toBe('give_up');
  });

  it('requires confirm_timeout and a full exit', () => {
    expect(decideExitRefire({ ...base, sellReason: 'send_failed' })).toBe('give_up');
    expect(decideExitRefire({ ...base, fraction: 0.5 })).toBe('give_up');
  });
});
