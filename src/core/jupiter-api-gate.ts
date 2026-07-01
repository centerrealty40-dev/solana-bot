/**
 * Cross-process Jupiter API slot scheduler (file lock + nextAllowedMs).
 * All solana-alpha PM2 apps share one Developer key (~10 RPS) — without this,
 * per-process hot-tick / discovery / sa-jupiter bursts exceed quota.
 *
 * Env:
 * - `JUPITER_GLOBAL_RATE_LIMIT=0` — disable gate.
 * - `JUPITER_GLOBAL_RATE_LIMIT=1` — force enable.
 * - default: on when `JUPITER_API_KEY` is set.
 * - `JUPITER_GLOBAL_MAX_RPS` — default 8 when `JUPITER_DEVELOPER_TIER=1`, else 1.
 * - `JUPITER_GLOBAL_GATE_PATH` — state file (default `data/jupiter-api-gate.json` under cwd).
 */
import fs from 'node:fs';
import path from 'node:path';

function gateEnabled(): boolean {
  const flag = process.env.JUPITER_GLOBAL_RATE_LIMIT?.trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  const key = process.env.JUPITER_API_KEY?.trim();
  return Boolean(key && key.length > 0);
}

function maxRps(): number {
  const raw = process.env.JUPITER_GLOBAL_MAX_RPS?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(20, n);
  }
  return process.env.JUPITER_DEVELOPER_TIER === '1' ? 8 : 1;
}

function statePath(): string {
  const custom = process.env.JUPITER_GLOBAL_GATE_PATH?.trim();
  if (custom) return custom;
  return path.join(process.cwd(), 'data', 'jupiter-api-gate.json');
}

function lockPath(): string {
  return `${statePath()}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readState(): { nextAllowedMs: number } {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const j = JSON.parse(raw) as { nextAllowedMs?: unknown };
    const next = j?.nextAllowedMs;
    return { nextAllowedMs: typeof next === 'number' && Number.isFinite(next) ? next : 0 };
  } catch {
    return { nextAllowedMs: 0 };
  }
}

function writeState(nextAllowedMs: number): void {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ nextAllowedMs, updatedAt: Date.now() }), 'utf8');
  fs.renameSync(tmp, p);
}

function clearStaleLock(maxAgeMs = 30_000): void {
  try {
    const st = fs.statSync(lockPath());
    if (Date.now() - st.mtimeMs > maxAgeMs) fs.unlinkSync(lockPath());
  } catch {
    /* no lock */
  }
}

async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    clearStaleLock();
    try {
      const fd = fs.openSync(lockPath(), 'wx');
      try {
        return await fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath());
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
        await sleep(5 + Math.floor(Math.random() * 15));
        continue;
      }
      throw e;
    }
  }
  return fn();
}

/** Reserve the next Jupiter HTTP slot; waits until grant time. */
export async function acquireJupiterApiSlot(): Promise<void> {
  if (!gateEnabled()) return;
  const minGapMs = Math.ceil(1000 / maxRps());
  let waitMs = 0;
  await withFileLock(async () => {
    const now = Date.now();
    const state = readState();
    const grantAt = Math.max(now, state.nextAllowedMs);
    waitMs = Math.max(0, grantAt - now);
    writeState(grantAt + minGapMs);
  });
  if (waitMs > 0) await sleep(waitMs);
}

/** Test helper — reset gate schedule. */
export function resetJupiterApiGateForTests(): void {
  try {
    fs.unlinkSync(statePath());
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath());
  } catch {
    /* ignore */
  }
}
