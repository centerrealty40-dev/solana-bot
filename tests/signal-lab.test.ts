import { describe, it, expect, vi, afterEach } from 'vitest';
import { signalLabShouldSample } from '../src/live/signal-lab.js';

describe('signalLabShouldSample', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for non-positive sample pct', () => {
    expect(signalLabShouldSample(0)).toBe(false);
    expect(signalLabShouldSample(-1)).toBe(false);
  });

  it('returns true when sample pct is 100', () => {
    expect(signalLabShouldSample(100)).toBe(true);
  });

  it('returns true when random * 100 < pct', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.24);
    expect(signalLabShouldSample(25)).toBe(true);
  });

  it('returns false when random * 100 >= pct', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    expect(signalLabShouldSample(25)).toBe(false);
  });
});
