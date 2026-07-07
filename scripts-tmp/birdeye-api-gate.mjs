/**
 * Cross-process Birdeye HTTP slot scheduler (file lock + nextAllowedMs).
 *
 * Env:
 * - `BIRDEYE_GLOBAL_RATE_LIMIT=0` — disable gate.
 * - `BIRDEYE_GLOBAL_RATE_LIMIT=1` — force enable (default when API key set).
 * - `BIRDEYE_GLOBAL_MAX_RPS` — shared requests/sec (default 12; Lite plan ≈15 rps).
 * - `BIRDEYE_GLOBAL_GATE_PATH` — state file (default `data/birdeye-api-gate.json`).
 */
import fs from 'node:fs';
import path from 'node:path';

function gateEnabled() {
  const flag = String(process.env.BIRDEYE_GLOBAL_RATE_LIMIT ?? '1').trim();
  if (flag === '0') return false;
  return Boolean(process.env.BIRDEYE_API_KEY?.trim());
}

function maxRps() {
  const raw = process.env.BIRDEYE_GLOBAL_MAX_RPS?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(50, n);
  }
  return 12;
}

function statePath() {
  const custom = process.env.BIRDEYE_GLOBAL_GATE_PATH?.trim();
  if (custom) return custom;
  return path.join(process.cwd(), 'data', 'birdeye-api-gate.json');
}

function lockPath() {
  return `${statePath()}.lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const j = JSON.parse(raw);
    const next = j?.nextAllowedMs;
    return { nextAllowedMs: typeof next === 'number' && Number.isFinite(next) ? next : 0 };
  } catch {
    return { nextAllowedMs: 0 };
  }
}

function writeState(nextAllowedMs) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ nextAllowedMs, updatedAt: Date.now() }), 'utf8');
  fs.renameSync(tmp, p);
}

function clearStaleLock(maxAgeMs = 30_000) {
  try {
    const st = fs.statSync(lockPath());
    if (Date.now() - st.mtimeMs > maxAgeMs) fs.unlinkSync(lockPath());
  } catch {
    /* no lock */
  }
}

async function withFileLock(fn) {
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
      if (e?.code === 'EEXIST') {
        await sleep(5 + Math.floor(Math.random() * 15));
        continue;
      }
      throw e;
    }
  }
  return fn();
}

export function isBirdeyeUrl(url) {
  return typeof url === 'string' && url.includes('public-api.birdeye.so');
}

/** Reserve the next Birdeye HTTP slot; waits until grant time. */
export async function acquireBirdeyeSlot() {
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
