/**
 * Cross-process DexScreener HTTP slot scheduler (file lock + nextAllowedMs).
 * All DEX snapshot collectors share one VPS egress IP — without this, parallel
 * search + open-mint enrich bursts exceed DexScreener quota and return 429.
 *
 * Env:
 * - `DEXSCREENER_GLOBAL_RATE_LIMIT=0` — disable gate.
 * - `DEXSCREENER_GLOBAL_RATE_LIMIT=1` — force enable (default in prod PM2).
 * - `DEXSCREENER_GLOBAL_MAX_RPM` — shared requests/min (default 42).
 * - `DEXSCREENER_GLOBAL_GATE_PATH` — state file (default `data/dexscreener-api-gate.json`).
 */
import fs from 'node:fs';
import path from 'node:path';

function gateEnabled() {
  const flag = String(process.env.DEXSCREENER_GLOBAL_RATE_LIMIT ?? '1').trim();
  if (flag === '0') return false;
  return true;
}

function maxRpm() {
  const raw = process.env.DEXSCREENER_GLOBAL_MAX_RPM?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(120, n);
  }
  return 42;
}

function statePath() {
  const custom = process.env.DEXSCREENER_GLOBAL_GATE_PATH?.trim();
  if (custom) return custom;
  return path.join(process.cwd(), 'data', 'dexscreener-api-gate.json');
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

export function isDexScreenerUrl(url) {
  return typeof url === 'string' && url.includes('api.dexscreener.com');
}

/** Reserve the next DexScreener HTTP slot; waits until grant time. */
export async function acquireDexScreenerSlot() {
  if (!gateEnabled()) return;
  const minGapMs = Math.ceil(60_000 / maxRpm());
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
