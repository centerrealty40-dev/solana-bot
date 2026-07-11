import { describe, expect, it } from 'vitest';
import { knifeWatchdogVerdict } from '../src/scripts/knife-watchdog.js';

const base = {
  rssMb: 100,
  lastActivityAgeMs: 0,
  watchedCount: 8,
  rssHardMb: 420,
  stallMs: 600_000,
};

describe('knifeWatchdogVerdict', () => {
  it('does not exit under normal RSS + fresh activity', () => {
    expect(knifeWatchdogVerdict(base).exit).toBe(false);
  });

  it('exits (rss) when RSS reaches the hard cap — before kernel OOM', () => {
    const v = knifeWatchdogVerdict({ ...base, rssMb: 420 });
    expect(v.exit).toBe(true);
    expect(v.reason).toBe('rss');
  });

  it('exits (rss) when RSS exceeds the hard cap', () => {
    const v = knifeWatchdogVerdict({ ...base, rssMb: 5800 });
    expect(v.exit).toBe(true);
    expect(v.reason).toBe('rss');
  });

  it('exits (stall) when no observations for >= stallMs while watching', () => {
    const v = knifeWatchdogVerdict({ ...base, lastActivityAgeMs: 600_000 });
    expect(v.exit).toBe(true);
    expect(v.reason).toBe('stall');
  });

  it('does NOT stall-exit when nothing is watched (empty watchlist is normal)', () => {
    const v = knifeWatchdogVerdict({ ...base, watchedCount: 0, lastActivityAgeMs: 3_600_000 });
    expect(v.exit).toBe(false);
  });

  it('RSS takes priority over stall', () => {
    const v = knifeWatchdogVerdict({ ...base, rssMb: 500, lastActivityAgeMs: 900_000 });
    expect(v.reason).toBe('rss');
  });

  it('honors disabled guards (0 disables)', () => {
    expect(
      knifeWatchdogVerdict({ ...base, rssMb: 9999, rssHardMb: 0, stallMs: 0 }).exit,
    ).toBe(false);
  });
});
