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

function watched(app: string) {
  return { ...cfg, watched: [{ app, dataDir: `/data/${app}` }] };
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

  it('restarts an offline app and clears only an old ownerless lock first', async () => {
    const order: string[] = [];
    const d = deps({
      pm2Online: async () => false,
      exists: () => true,
      stat: () => ({ mtimeMs: 0 } as fs.Stats),
      read: () => '',
      owner: () => ({ proven: true, live: false }),
      unlink: () => { order.push('unlink'); },
      restart: async () => { order.push('restart'); return true; },
    });
    await watchdogTick(watched('offline-a'), d);
    expect(order).toEqual(['unlink', 'restart']);
  });

  it('leaves a lock owned by the same instance in place', async () => {
    let unlinked = false;
    const d = deps({
      pm2Online: async () => false,
      exists: () => true,
      stat: () => ({ mtimeMs: 0 } as fs.Stats),
      read: () => '',
      owner: () => ({ proven: true, live: true }),
      unlink: () => { unlinked = true; },
    });
    await watchdogTick(watched('live-lock-a'), d);
    expect(unlinked).toBe(false);
    expect(d.restarts).toEqual(['live-lock-a']);
  });

  it('enforces cooldown and hourly cap', async () => {
    const app = `cap-${Date.now()}`;
    let count = 0;
    const d = deps({
      restart: async () => { count += 1; return true; },
      pm2Online: async () => false,
    });
    const limited = { ...watched(app), maxRestartsPerHour: 1, cooldownMs: 0 };
    await watchdogTick(limited, d);
    await watchdogTick(limited, d);
    expect(count).toBe(1);
    const cool = `cool-${Date.now()}`;
    const c = deps({ restart: async () => { count += 1; return true; }, pm2Online: async () => false });
    await watchdogTick({ ...watched(cool), cooldownMs: 60_000 }, c);
    await watchdogTick({ ...watched(cool), cooldownMs: 60_000 }, c);
    expect(count).toBe(2);
  });

  it('swallows filesystem failures', async () => {
    const d = deps({
      statfs: () => { throw new Error('statfs'); },
      stat: () => { throw new Error('stat'); },
      pm2Online: async () => { throw new Error('exec'); },
    });
    await expect(watchdogTick(watched(`errors-${Date.now()}`), d)).resolves.toBeUndefined();
  });
});
