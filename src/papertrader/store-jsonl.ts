import fs from 'node:fs';
import path from 'node:path';
import type { JsonlEventBase, JsonlEventKind } from './types.js';

let storePath = '/tmp/paper-trades.jsonl';
let strategyId = 'paper_v1';

export function configureStore(opts: { storePath: string; strategyId: string }): void {
  storePath = opts.storePath;
  strategyId = opts.strategyId;
  ensureStoreDir();
}

function ensureStoreDir(): void {
  try {
    const dir = path.dirname(storePath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`store mkdir failed: ${(err as Error).message}`);
  }
}

const DEFAULT_FSYNC_KINDS: ReadonlySet<JsonlEventKind> = new Set(['open', 'close']);

/**
 * Append-only JSONL. For `open`/`close` we fsync so a crash right after a trade
 * does not lose the record on a machine with write caching.
 */
export function appendEvent(
  event: Omit<JsonlEventBase, 'ts' | 'strategyId'> & Record<string, unknown>,
  opts?: { sync?: boolean },
): void {
  try {
    const payload: Record<string, unknown> = { ts: Date.now(), strategyId, ...event };
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (v instanceof Set) payload[k] = Array.from(v);
    }
    const line = JSON.stringify(payload) + '\n';
    const sync = opts?.sync ?? DEFAULT_FSYNC_KINDS.has(event.kind as JsonlEventKind);
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
    console.warn(`store write failed: ${(err as Error).message}`);
  }
}
