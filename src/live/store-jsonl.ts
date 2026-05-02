import fs from 'node:fs';
import path from 'node:path';

let storePath = '';
let strategyId = 'live-oscar';

export function configureLiveStore(opts: { storePath: string; strategyId: string }): void {
  storePath = opts.storePath;
  strategyId = opts.strategyId;
}

function ensureStoreDir(): void {
  try {
    const dir = path.dirname(storePath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`live store mkdir failed: ${(err as Error).message}`);
  }
}

export function appendLiveEvent(
  event: Record<string, unknown>,
  opts?: { sync?: boolean },
): void {
  try {
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      strategyId,
      channel: 'live',
      ...event,
    };
    const line = JSON.stringify(payload) + '\n';
    const sync = opts?.sync ?? false;
    ensureStoreDir();
    if (sync) {
      const fd = fs.openSync(storePath, 'a');
      try {
        fs.writeSync(fd, line, 0, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.appendFileSync(storePath, line);
    }
  } catch (err) {
    console.warn(`live store write failed: ${(err as Error).message}`);
  }
}
