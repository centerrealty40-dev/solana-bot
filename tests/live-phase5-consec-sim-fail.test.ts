import { describe, expect, it, beforeEach } from 'vitest';
import {
  liveConsecSimFailCount,
  notifyLiveExecutionSimErr,
  notifyLiveExecutionSimErrForTerminal,
  notifyLiveExecutionSimOk,
  resetLivePhase5Counters,
} from '../src/live/phase5-state.js';

describe('phase5 consec sim fail', () => {
  beforeEach(() => {
    resetLivePhase5Counters();
  });

  it('does not increment on transient no_quote / quote_stale', () => {
    notifyLiveExecutionSimErrForTerminal('no_quote');
    notifyLiveExecutionSimErrForTerminal('quote_stale:120ms>50ms');
    expect(liveConsecSimFailCount()).toBe(0);
  });

  it('increments on terminal messages and resets on ok', () => {
    notifyLiveExecutionSimErrForTerminal('swap_build');
    expect(liveConsecSimFailCount()).toBe(1);
    notifyLiveExecutionSimErr();
    expect(liveConsecSimFailCount()).toBe(2);
    notifyLiveExecutionSimOk();
    expect(liveConsecSimFailCount()).toBe(0);
  });
});
