import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { appendMildDipJournal } from './state.js';
import { otherMildDipInstanceProcess } from './instance-lock.js';

const exec = promisify(execFile);
type Watched = { app: string; dataDir: string };
type WatchdogConfig = {
  watched: Watched[];
  intervalMs: number;
  staleMs: number;
  maxRestartsPerHour: number;
  cooldownMs: number;
  journalPath: string;
  minFreeBytes: number;
  minFreePct: number;
  lockMinAgeMs: number;
};
export type WatchdogDeps = {
  pm2Online?: (app: string) => Promise<boolean | null>;
  restart?: (app: string) => Promise<boolean>;
  statfs?: (dir: string) => fs.StatsFs;
  stat?: (file: string) => fs.Stats;
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
  unlink?: (file: string) => void;
  owner?: (lockPath: string) => { proven: boolean; live: boolean };
};

const restartHistory = new Map<string, number[]>();
const lastRestart = new Map<string, number>();
let pm2FailureCount = 0;
let previousDiskLow = false;

function num(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function loadWatchdogConfig(): WatchdogConfig {
  const raw = (process.env.MILD_DIP_WATCHDOG_INSTANCES ?? '').trim();
  const watched = (raw || 'mild-dip-mirror:data/milddip-mirror,mild-dip-mirror2:data/milddip-mirror2')
    .split(',')
    .map((item) => {
      const [app, dataDir] = item.split(':');
      return app && dataDir ? { app: app.trim(), dataDir: path.resolve(dataDir.trim()) } : null;
    })
    .filter((item): item is Watched => item != null);
  return {
    watched,
    intervalMs: num('MILD_DIP_WATCHDOG_INTERVAL_MS', 60_000),
    staleMs: num('MILD_DIP_WATCHDOG_STALE_MS', 8 * 60_000),
    maxRestartsPerHour: num('MILD_DIP_WATCHDOG_MAX_RESTARTS_PER_HOUR', 4),
    cooldownMs: num('MILD_DIP_WATCHDOG_COOLDOWN_MS', 5 * 60_000),
    journalPath: process.env.MILD_DIP_WATCHDOG_JOURNAL_PATH?.trim() || 'data/milddip/watchdog-journal.jsonl',
    minFreeBytes: num('MILD_DIP_DATA_MIN_FREE_BYTES', 2 * 1024 ** 3),
    minFreePct: num('MILD_DIP_DATA_MIN_FREE_PCT', 5),
    lockMinAgeMs: num('MILD_DIP_LOCK_EMPTY_MIN_AGE_MS', 60_000),
  };
}

function journal(cfg: WatchdogConfig, event: Record<string, unknown>): void {
  try { appendMildDipJournal(cfg.journalPath, event); } catch { /* watchdog must remain alive */ }
}

async function pm2Status(app: string): Promise<boolean | null> {
  try {
    const { stdout } = await exec('pm2', ['jlist'], { timeout: 10_000 });
    const rows = JSON.parse(stdout) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    return rows.some((row) => row.name === app && row.pm2_env?.status === 'online');
  } catch { return null; }
}

async function restartApp(app: string): Promise<boolean> {
  try {
    await exec('pm2', ['restart', app, '--update-env'], { timeout: 30_000 });
    return true;
  } catch { return false; }
}

export async function watchdogTick(cfg: WatchdogConfig, deps: WatchdogDeps = {}): Promise<void> {
  let diskLow = false;
  try {
    const stat = (deps.statfs ?? fs.statfsSync)(cfg.watched[0]?.dataDir ?? '.');
    const free = Number(stat.bavail) * Number(stat.bsize);
    const total = Number(stat.blocks) * Number(stat.bsize);
    diskLow = free < cfg.minFreeBytes || (total > 0 && free / total * 100 < cfg.minFreePct);
    if (diskLow && !previousDiskLow) {
      console.warn(`[mild-dip-watchdog] disk low freeBytes=${free}`);
      journal(cfg, { kind: 'mild_dip_watchdog_disk_low', freeBytes: free, freePct: total > 0 ? free / total * 100 : 0 });
    } else if (!diskLow && previousDiskLow) {
      journal(cfg, { kind: 'mild_dip_watchdog_disk_recovered', freeBytes: free, freePct: total > 0 ? free / total * 100 : 0 });
    }
    previousDiskLow = diskLow;
  } catch (err) {
    journal(cfg, { kind: 'mild_dip_watchdog_error', error: String(err) });
  }
  for (const instance of cfg.watched) {
    const statePath = path.join(instance.dataDir, 'state.json');
    let ageMs = Number.POSITIVE_INFINITY;
    try { ageMs = Date.now() - (deps.stat ?? fs.statSync)(statePath).mtimeMs; } catch { /* treated stale */ }
    let online: boolean | null;
    try {
      online = await (deps.pm2Online ?? pm2Status)(instance.app);
    } catch {
      online = null;
    }
    if (online == null) {
      pm2FailureCount += 1;
      console.warn(`[mild-dip-watchdog] PM2 unavailable failures=${pm2FailureCount}`);
      journal(cfg, {
        kind: 'mild_dip_watchdog_pm2_unavailable',
        app: instance.app,
        failureCount: pm2FailureCount,
      });
    } else {
      pm2FailureCount = 0;
    }
    const wedged = ageMs > cfg.staleMs;
    journal(cfg, { kind: 'mild_dip_watchdog_tick', app: instance.app, stateAgeMs: ageMs, wedged, online, diskLow });
    if (online == null || (online && !wedged)) continue;
    const now = Date.now();
    const history = (restartHistory.get(instance.app) ?? []).filter((at) => now - at < 3_600_000);
    restartHistory.set(instance.app, history);
    if (now - (lastRestart.get(instance.app) ?? 0) < cfg.cooldownMs) continue;
    if (history.length >= cfg.maxRestartsPerHour) {
      console.warn(`[mild-dip-watchdog] restart cap reached app=${instance.app} count=${history.length}`);
      journal(cfg, { kind: 'mild_dip_watchdog_restart_cap', app: instance.app, count: history.length });
      continue;
    }
    const lockPath = path.join(instance.dataDir, 'mild-dip-bot.lock');
    try {
      let reclaimable = false;
      if ((deps.exists ?? fs.existsSync)(lockPath)) {
        const stat = (deps.stat ?? fs.statSync)(lockPath);
        const first = (deps.read ?? ((file) => fs.readFileSync(file, 'utf8')))(lockPath).split(/\r?\n/)[0]?.trim() ?? '';
        reclaimable = now - stat.mtimeMs >= cfg.lockMinAgeMs && !/^\d+$/.test(first);
      }
      if (reclaimable) {
        const owner = (deps.owner ?? otherMildDipInstanceProcess)(lockPath);
        if (owner.proven && !owner.live) {
          (deps.unlink ?? fs.unlinkSync)(lockPath);
          journal(cfg, { kind: 'mild_dip_watchdog_lock_cleared', app: instance.app, lockPath });
        }
      }
    } catch (err) {
      journal(cfg, { kind: 'mild_dip_watchdog_lock_clear_failed', app: instance.app, error: String(err) });
    }
    if (await (deps.restart ?? restartApp)(instance.app)) {
      history.push(now);
      lastRestart.set(instance.app, now);
      journal(cfg, { kind: 'mild_dip_watchdog_restart_issued', app: instance.app });
    }
  }
}

export async function runWatchdog(cfg = loadWatchdogConfig()): Promise<void> {
  for (;;) {
    try { await watchdogTick(cfg); } catch (err) { journal(cfg, { kind: 'mild_dip_watchdog_error', error: String(err) }); }
    await new Promise((resolve) => setTimeout(resolve, cfg.intervalMs));
  }
}
