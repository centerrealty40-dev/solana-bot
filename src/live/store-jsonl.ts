import fs from 'node:fs';
import path from 'node:path';
import type { LiveEventBody } from './events.js';
import { LIVE_SCHEMA_V1, LIVE_SCHEMA_V2, safeParseLiveEventBody } from './events.js';

function envelopeLiveSchema(body: LiveEventBody): number {
  return body.kind === 'live_reconcile_report' || body.kind === 'live_reconcile_quarantine'
    ? LIVE_SCHEMA_V2
    : LIVE_SCHEMA_V1;
}

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

/** W8.0-p1 §7 — default fsync policy (override with `opts.sync`). */
export function liveEventDefaultFsync(body: LiveEventBody): boolean {
  if (process.env.LIVE_JSONL_FSYNC_HEARTBEAT === '1' && body.kind === 'heartbeat') {
    return true;
  }
  switch (body.kind) {
    case 'heartbeat':
      return false;
    case 'live_boot':
    case 'live_shutdown':
    case 'risk_block':
    case 'capital_skip':
    case 'capital_rotate_close':
      return true;
    case 'execution_attempt':
      return true;
    case 'execution_result':
      return ['sim_ok', 'sim_err', 'sent', 'confirmed', 'failed'].includes(body.status);
    case 'execution_skip':
      return true;
    case 'live_position_open':
    case 'live_position_dca':
    case 'live_position_partial_sell':
    case 'live_position_close':
      return true;
    case 'live_reconcile_report':
    case 'live_reconcile_quarantine':
      return true;
    default:
      return false;
  }
}

/**
 * Single write path for live JSONL (W8.0-p1). Validates body; merges envelope; applies fsync policy.
 */
export function appendLiveJsonlEvent(body: unknown, opts?: { sync?: boolean }): void {
  const parsed = safeParseLiveEventBody(body);
  if (!parsed.success) {
    console.warn(`live JSONL validation failed: ${parsed.error.message}`);
    return;
  }
  const validated = parsed.data;

  try {
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      strategyId,
      channel: 'live',
      liveSchema: envelopeLiveSchema(validated),
      ...validated,
    };
    const line = JSON.stringify(payload) + '\n';
    const sync = opts?.sync ?? liveEventDefaultFsync(validated);
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
