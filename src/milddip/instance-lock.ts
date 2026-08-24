/**
 * Exclusive process lock so two PM2 homes (root vs salpha) cannot trade the
 * same mild-dip wallet in parallel — the cause of duplicate $5 buys.
 */
import fs from 'node:fs';
import path from 'node:path';

export type InstanceLock = {
  lockPath: string;
  release: () => void;
};

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function emptyLockMinAgeMs(): number {
  const value = Number(process.env.MILD_DIP_LOCK_EMPTY_MIN_AGE_MS ?? 60_000);
  return Number.isFinite(value) && value >= 1_000 ? value : 60_000;
}

function otherMildDipInstanceProcess(lockPath: string): { proven: boolean; live: boolean } {
  try {
    const entries = fs.readdirSync('/proc', { withFileTypes: true });
    const instanceDir = path.dirname(lockPath);
    const statePath = path.join(instanceDir, 'state.json');
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (pid === process.pid) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${entry.name}/cmdline`, 'utf8').replace(/\0/g, ' ');
        let cwd = '';
        try {
          cwd = fs.readlinkSync(`/proc/${entry.name}/cwd`);
        } catch {
          /* Process may exit while it is being inspected. */
        }
        let environ = '';
        try {
          environ = fs.readFileSync(`/proc/${entry.name}/environ`, 'utf8').replace(/\0/g, '\n');
        } catch {
          /* Environment may become unreadable as a process exits. */
        }
        if (
          cwd === instanceDir ||
          cmd.includes(instanceDir) ||
          environ.includes(`MILD_DIP_STATE_PATH=${statePath}`)
        ) {
          return { proven: true, live: true };
        }
      } catch {
        /* Process may exit while it is being inspected. */
      }
    }
    return { proven: true, live: false };
  } catch {
    return { proven: false, live: false };
  }
}

/**
 * Acquire an exclusive lock file. If a stale lock from a dead pid exists, replace it.
 * Returns null when another live process holds the lock.
 */
export function tryAcquireMildDipInstanceLock(lockPath: string): InstanceLock | null {
  const dir = path.dirname(lockPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  const payload = `${process.pid}\n${new Date().toISOString()}\n`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try {
          const cur = fs.readFileSync(lockPath, 'utf8');
          const lockPid = Number.parseInt(cur.split('\n')[0] ?? '', 10);
          if (lockPid === process.pid) fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      };
      return { lockPath, release };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw err;
      try {
        const cur = fs.readFileSync(lockPath, 'utf8');
        const lockPid = Number.parseInt(cur.split('\n')[0] ?? '', 10);
        if (Number.isFinite(lockPid) && lockPid > 0 && !pidAlive(lockPid)) {
          console.warn(`[mild-dip] reclaiming stale lock ${lockPath}: pid ${lockPid} is not alive`);
          fs.unlinkSync(lockPath);
          continue;
        }
        if (!(Number.isFinite(lockPid) && lockPid > 0)) {
          const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (ageMs < emptyLockMinAgeMs()) {
            console.error(
              `[mild-dip] refusing lock ${lockPath}: unreadable PID and age ${ageMs}ms is below safety threshold`,
            );
            return null;
          }
          const owner = otherMildDipInstanceProcess(lockPath);
          if (!owner.proven) {
            console.error(
              `[mild-dip] refusing lock ${lockPath}: unreadable PID and live-owner scan failed`,
            );
            return null;
          }
          if (owner.live) {
            console.error(
              `[mild-dip] refusing lock ${lockPath}: unreadable PID but another mild-dip instance is live`,
            );
            return null;
          }
          console.warn(
            `[mild-dip] reclaiming stale lock ${lockPath}: unreadable PID, age ${ageMs}ms, no live instance found`,
          );
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        console.error(`[mild-dip] refusing lock ${lockPath}: cannot read or inspect existing lock`);
      }
      return null;
    }
  }
  return null;
}
