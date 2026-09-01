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
 * - `JUPITER_GATE_HEADER_BUDGET=0` — ignore `x-ratelimit-remaining/reset` window budget.
 * - `JUPITER_BACKGROUND_RESERVE` — window slots kept for execution (default 3).
 */
import fs from 'node:fs';
import path from 'node:path';

type GateState = {
  nextAllowedMs: number;
  pausedUntilMs: number;
  nextBackgroundAllowedMs?: number;
  /** Requests left in the current Jupiter window (from `x-ratelimit-remaining`). */
  windowRemaining?: number;
  /** Window end (from `x-ratelimit-reset`, epoch ms); budget unknown after it. */
  windowResetMs?: number;
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
      windowRemaining?: unknown;
      windowResetMs?: unknown;
    };
    const next = j?.nextAllowedMs;
    const paused = j?.pausedUntilMs;
    const background = j?.nextBackgroundAllowedMs;
    const remaining = j?.windowRemaining;
    const reset = j?.windowResetMs;
    return {
      nextAllowedMs: typeof next === 'number' && Number.isFinite(next) ? next : 0,
      pausedUntilMs: typeof paused === 'number' && Number.isFinite(paused) ? paused : 0,
      nextBackgroundAllowedMs:
        typeof background === 'number' && Number.isFinite(background) ? background : 0,
      windowRemaining:
        typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : undefined,
      windowResetMs: typeof reset === 'number' && Number.isFinite(reset) ? reset : undefined,
    };
  } catch {
    return { nextAllowedMs: 0, pausedUntilMs: 0, nextBackgroundAllowedMs: 0 };
  }
}

function headerBudgetEnabled(): boolean {
  return process.env.JUPITER_GATE_HEADER_BUDGET?.trim() !== '0';
}

function backgroundReserve(): number {
  const raw = process.env.JUPITER_BACKGROUND_RESERVE?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return Math.min(50, n);
  }
  return 3;
}

/** Window budget still meaningful: reset in the future and remaining known. */
function windowActive(state: GateState, now: number): boolean {
  return (
    headerBudgetEnabled() &&
    state.windowRemaining != null &&
    state.windowResetMs != null &&
    now < state.windowResetMs
  );
}

function reserveWindowSlot(state: GateState, now: number): Partial<GateState> {
  if (!windowActive(state, now)) return { windowRemaining: undefined, windowResetMs: undefined };
  return {
    windowRemaining: Math.max(0, (state.windowRemaining ?? 0) - 1),
    windowResetMs: state.windowResetMs,
  };
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

/**
 * Record `x-ratelimit-remaining` / `x-ratelimit-reset` from a Jupiter response so the
 * next grants wait for the window instead of running into HTTP 429.
 */
export function noteJupiterRateLimitHeaders(headers: Headers): void {
  if (!gateEnabled() || !headerBudgetEnabled()) return;
  const remainingRaw = headers.get('x-ratelimit-remaining');
  const resetRaw = headers.get('x-ratelimit-reset');
  if (remainingRaw == null || resetRaw == null) return;
  const remaining = Number.parseInt(remainingRaw, 10);
  const resetSec = Number.parseFloat(resetRaw);
  if (!Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(resetSec) || resetSec <= 0) {
    return;
  }
  const resetMs = Math.round(resetSec * 1000);
  const now = Date.now();
  if (resetMs <= now || resetMs - now > 120_000) return;
  try {
    clearStaleLock();
    const fd = fs.openSync(lockPath(), 'wx');
    try {
      const state = readState();
      const stale = state.windowResetMs != null && state.windowResetMs > resetMs;
      if (stale) return;
      writeState({ ...state, windowRemaining: remaining, windowResetMs: resetMs });
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
    const budgetExhausted = windowActive(state, now) && (state.windowRemaining ?? 0) <= 0;
    const grantAt = Math.max(
      now,
      state.nextAllowedMs,
      state.pausedUntilMs,
      budgetExhausted ? (state.windowResetMs ?? 0) : 0,
    );
    waitMs = Math.max(0, grantAt - now);
    writeState({
      nextAllowedMs: grantAt + minGapMs,
      pausedUntilMs: state.pausedUntilMs,
      nextBackgroundAllowedMs: state.nextBackgroundAllowedMs,
      ...(budgetExhausted
        ? { windowRemaining: undefined, windowResetMs: undefined }
        : reserveWindowSlot(state, now)),
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
    if (windowActive(state, now) && (state.windowRemaining ?? 0) <= backgroundReserve()) return;
    const grantAt = Math.max(now, state.nextAllowedMs);
    writeState({
      nextAllowedMs: grantAt + globalGapMs,
      pausedUntilMs: state.pausedUntilMs,
      nextBackgroundAllowedMs: now + backgroundGapMs,
      ...reserveWindowSlot(state, now),
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
