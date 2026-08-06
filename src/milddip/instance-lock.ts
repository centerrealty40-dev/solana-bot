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
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* contend again or fail */
      }
      return null;
    }
  }
  return null;
}
