/** 1.11.231 — unit tests для adaptive priority fee under congestion. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  adaptivePriorityMaxLamports,
  configureAdaptivePriorityFee,
  recordSendOutcome,
  _adaptivePriorityFeeSnapshotForTests,
  _resetAdaptivePriorityFeeForTests,
} from '../src/live/adaptive-priority-fee.js';

vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: vi.fn(),
}));

describe('adaptive-priority-fee', () => {
  beforeEach(() => {
    _resetAdaptivePriorityFeeForTests();
  });

  it('disabled by default — returns baseLamports as-is', () => {
    expect(adaptivePriorityMaxLamports(100_000)).toBe(100_000);
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    /** Should not boost when disabled. */
    expect(adaptivePriorityMaxLamports(100_000)).toBe(100_000);
  });

  it('boosts after threshold confirm_timeouts in window', () => {
    configureAdaptivePriorityFee({
      enabled: true,
      threshold: 3,
      windowMs: 60_000,
      boostFactor: 2,
      holdMs: 60_000,
    });
    recordSendOutcome({ kind: 'confirm_timeout' });
    expect(adaptivePriorityMaxLamports(100_000)).toBe(100_000);
    recordSendOutcome({ kind: 'confirm_timeout' });
    expect(adaptivePriorityMaxLamports(100_000)).toBe(100_000);
    recordSendOutcome({ kind: 'confirm_timeout' });
    /** Threshold reached → boost. */
    expect(adaptivePriorityMaxLamports(100_000)).toBe(200_000);
  });

  it('success resets recent timeouts counter', () => {
    configureAdaptivePriorityFee({
      enabled: true,
      threshold: 3,
      windowMs: 60_000,
      boostFactor: 2,
      holdMs: 60_000,
    });
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'success' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    /** Только 2 confirm_timeout после success → не должно boost'нуть. */
    expect(adaptivePriorityMaxLamports(100_000)).toBe(100_000);
  });

  it('boost has hard cap at 50M lamports', () => {
    configureAdaptivePriorityFee({
      enabled: true,
      threshold: 1,
      windowMs: 60_000,
      boostFactor: 1000,
      holdMs: 60_000,
    });
    recordSendOutcome({ kind: 'confirm_timeout' });
    expect(adaptivePriorityMaxLamports(100_000)).toBe(50_000_000);
  });

  it('boost expires after holdMs', () => {
    const realDateNow = Date.now;
    let fakeNow = 1_000_000_000_000;
    Date.now = () => fakeNow;
    try {
      configureAdaptivePriorityFee({
        enabled: true,
        threshold: 1,
        windowMs: 60_000,
        boostFactor: 2,
        holdMs: 10_000,
      });
      recordSendOutcome({ kind: 'confirm_timeout' });
      expect(adaptivePriorityMaxLamports(100_000)).toBe(200_000);

      fakeNow += 9_999;
      expect(adaptivePriorityMaxLamports(100_000)).toBe(200_000);

      fakeNow += 1_000;
      /** Истёк → возврат на base. */
      expect(adaptivePriorityMaxLamports(100_000)).toBe(100_000);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('snapshot reflects internal state', () => {
    configureAdaptivePriorityFee({
      enabled: true,
      threshold: 5,
      windowMs: 60_000,
      boostFactor: 2,
      holdMs: 60_000,
    });
    recordSendOutcome({ kind: 'confirm_timeout' });
    recordSendOutcome({ kind: 'confirm_timeout' });
    const snap = _adaptivePriorityFeeSnapshotForTests();
    expect(snap.recentTimeouts.length).toBe(2);
    expect(snap.boostUntilMs).toBe(0);
    expect(snap.cfg.enabled).toBe(true);
  });
});
