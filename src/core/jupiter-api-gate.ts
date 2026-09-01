/**
 * Cross-process Jupiter API scheduler (file lock + nextAllowedMs + 429 pause).
 * live-oscar + copy-trader share one Developer key (10 RPS org limit).
 *
 * Env:
 * - `JUPITER_GLOBAL_RATE_LIMIT=0` — disable gate.
 * - `JUPITER_GLOBAL_RATE_LIMIT=1` — force enable.
 * - default: on when `JUPITER_API_KEY` is set.
 * - `JUPITER_GLOBAL_MAX_RPS` — default 8 (headroom under Developer 10 RPS).
 * - `JUPITER_GLOBAL_GATE_PATH` — state file (default `data/jupiter-api-gate.json`).
 */
import fs from 'node:fs';
import path from 'node:path';

type GateState = {
  nextAllowedMs: number;
  pausedUntilMs: number;
  nextBackgroundAllowedMs?: number;
};

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
  return 8;
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

function readState(): GateState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const j = JSON.parse(raw) as {
      nextAllowedMs?: unknown;
      pausedUntilMs?: unknown;
      nextBackgroundAllowedMs?: unknown;
    };
    const next = j?.nextAllowedMs;
    const paused = j?.pausedUntilMs;
    const background = j?.nextBackgroundAllowedMs;
    return {
      nextAllowedMs: typeof next === 'number' && Number.isFinite(next) ? next : 0,
      pausedUntilMs: typeof paused === 'number' && Number.isFinite(paused) ? paused : 0,
      nextBackgroundAllowedMs:
        typeof background === 'number' && Number.isFinite(background) ? background : 0,
    };
  } catch {
    return { nextAllowedMs: 0, pausedUntilMs: 0, nextBackgroundAllowedMs: 0 };
  }
}

function writeState(state: GateState): void {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ ...state, updatedAt: Date.now() }),
    'utf8',
  );
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

/** Extend org-wide Jupiter pause after HTTP 429 (x-ratelimit-reset or fallback). */
export function extendJupiterApiPause(untilMs: number): void {
  if (!gateEnabled() || !(untilMs > 0)) return;
  try {
    clearStaleLock();
    const fd = fs.openSync(lockPath(), 'wx');
    try {
      const state = readState();
      writeState({
        ...state,
        pausedUntilMs: Math.max(state.pausedUntilMs, untilMs),
      });
    } finally {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lockPath());
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best-effort — lock held by another process */
  }
}

/** Parse Jupiter rate-limit headers → ms to wait (0 if slot already free). */
export function jupiterRateLimitWaitMs(headers: Headers, fallbackMs = 1000): number {
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const sec = Number.parseFloat(reset);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.max(0, Math.min(15_000, Math.round(sec * 1000 - Date.now())));
    }
  }
  const ra = headers.get('retry-after');
  if (ra) {
    const sec = Number.parseFloat(ra);
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.max(0, Math.min(15_000, Math.round(sec * 1000)));
    }
  }
  return Math.max(0, Math.min(15_000, fallbackMs));
}

/** Reserve the next Jupiter HTTP slot; waits until grant time and any 429 pause. */
export async function acquireJupiterApiSlot(): Promise<void> {
  if (!gateEnabled()) return;
  const minGapMs = Math.ceil(1000 / maxRps());
  let waitMs = 0;
  await withFileLock(async () => {
    const now = Date.now();
    const state = readState();
    const grantAt = Math.max(now, state.nextAllowedMs, state.pausedUntilMs);
    waitMs = Math.max(0, grantAt - now);
    writeState({
      nextAllowedMs: grantAt + minGapMs,
      pausedUntilMs: state.pausedUntilMs,
      nextBackgroundAllowedMs: state.nextBackgroundAllowedMs,
    });
  });
  if (waitMs > 0) await sleep(waitMs);
}

function backgroundMaxRps(): number {
  const raw = process.env.JUPITER_GLOBAL_BACKGROUND_MAX_RPS?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(20, n);
  }
  return 3;
}

function backgroundMaxWaitMs(): number {
  const raw = process.env.JUPITER_BACKGROUND_MAX_WAIT_MS?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(60_000, n);
  }
  return 1_200;
}

/** Try to reserve a background slot without waiting behind execution traffic. */
export async function acquireJupiterApiSlotWithPriority(
  priority: 'execution' | 'background',
): Promise<boolean> {
  if (priority === 'execution') {
    await acquireJupiterApiSlot();
    return true;
  }
  if (!gateEnabled()) return true;
  const globalGapMs = Math.ceil(1000 / maxRps());
  const backgroundGapMs = Math.ceil(1000 / backgroundMaxRps());
  let granted = false;
  await withFileLock(async () => {
    const now = Date.now();
    const state = readState();
    if (now < state.pausedUntilMs) return;
    const projectedWaitMs = Math.max(0, state.nextAllowedMs - now);
    if (projectedWaitMs > backgroundMaxWaitMs()) return;
    const nextBackgroundAllowedMs = state.nextBackgroundAllowedMs ?? 0;
    if (now < nextBackgroundAllowedMs) return;
    const grantAt = Math.max(now, state.nextAllowedMs);
    writeState({
      nextAllowedMs: grantAt + globalGapMs,
      pausedUntilMs: state.pausedUntilMs,
      nextBackgroundAllowedMs: now + backgroundGapMs,
    });
    granted = true;
  });
  return granted;
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
