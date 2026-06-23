import { describe, expect, it } from 'vitest';
import { livePostCloseTailSweepCapApplies } from '../src/live/post-close-tail-sweep.js';

describe('livePostCloseTailSweepCapApplies', () => {
  it('applies cap only for killstop-class exits', () => {
    expect(livePostCloseTailSweepCapApplies('KILLSTOP')).toBe(true);
    expect(livePostCloseTailSweepCapApplies('FLASH_CRASH_KILL')).toBe(true);
    expect(livePostCloseTailSweepCapApplies('TP')).toBe(false);
    expect(livePostCloseTailSweepCapApplies('TRAIL')).toBe(false);
    expect(livePostCloseTailSweepCapApplies(undefined)).toBe(false);
  });
});
