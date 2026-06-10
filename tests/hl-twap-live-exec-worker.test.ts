import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isLiveExecWorkerBusy,
  kickLiveExecWorker,
  resetLiveExecWorkerForTests,
} from '../src/hyperliquid/twap/live/live-exec-worker.js';

afterEach(() => {
  resetLiveExecWorkerForTests();
  vi.useRealTimers();
});

describe('live exec worker', () => {
  it('runs work in background and clears busy flag', async () => {
    let ran = false;
    const result = kickLiveExecWorker(async () => {
      ran = true;
    });
    expect(result).toBe('started');
    expect(isLiveExecWorkerBusy()).toBe(true);
    await vi.waitFor(() => {
      expect(ran).toBe(true);
      expect(isLiveExecWorkerBusy()).toBe(false);
    });
  });

  it('skips when a batch is already in flight', async () => {
    vi.useFakeTimers();
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    expect(kickLiveExecWorker(() => work)).toBe('started');
    expect(kickLiveExecWorker(async () => {})).toBe('skipped_busy');

    resolveWork!();
    await work;
    await vi.runAllTimersAsync();
    expect(isLiveExecWorkerBusy()).toBe(false);
  });
});
