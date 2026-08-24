import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { watchdogTick, type WatchdogDeps } from '../../src/milddip/watchdog.js';

const cfg = {
  watched: [{ app: 'mirror-a', dataDir: '/data/a' }],
  intervalMs: 60_000,
  staleMs: 100,
  maxRestartsPerHour: 4,
  cooldownMs: 0,
  journalPath: '/tmp/watchdog-test.jsonl',
  minFreeBytes: 1,
  minFreePct: 1,
  lockMinAgeMs: 1,
};

function deps(overrides: Partial<WatchdogDeps> = {}) {
  const restarts: string[] = [];
  const base: WatchdogDeps = {
    statfs: () => ({ bavail: 100, bsize: 100, blocks: 1000 } as fs.StatsFs),
    stat: () => ({ mtimeMs: 0 } as fs.Stats),
    exists: () => false,
    pm2Online: async () => true,
    restart: async (app) => { restarts.push(app); return true; },
  };
  return { ...base, ...overrides, restarts };
}

describe('mild-dip watchdog', () => {
  it('restarts only a stale watched app and leaves fresh state alone', async () => {
    const stale = deps();
    await watchdogTick(cfg, stale);
    expect(stale.restarts).toEqual(['mirror-a']);
    const fresh = deps({ stat: () => ({ mtimeMs: Date.now() } as fs.Stats) });
    await watchdogTick(cfg, fresh);
    expect(fresh.restarts).toEqual([]);
  });

  it('does not restart when PM2 inspection fails', async () => {
    const d = deps({ pm2Online: async () => null });
    await expect(watchdogTick(cfg, d)).resolves.toBeUndefined();
    expect(d.restarts).toEqual([]);
  });
});
