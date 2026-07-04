/**
 * Shared helpers for PM2 strategy process watchdogs.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

export const LIVE_OSCAR_SCRIPT_MARKER = 'src/scripts/live-oscar.ts';

/** @param {string} raw */
export function parseHeartbeatJson(raw) {
  try {
    const j = JSON.parse(String(raw).trim().split('\n')[0]);
    if (typeof j.ts !== 'number') return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * @param {{ status: string, heartbeatAgeMs: number, heartbeatMaxStaleMs: number }} input
 */
export function assessProcessHealth(input) {
  const issues = [];
  if (input.status !== 'online') issues.push(`pm2_status_${input.status}`);
  if (
    input.status === 'online' &&
    input.heartbeatAgeMs > input.heartbeatMaxStaleMs
  ) {
    issues.push(`heartbeat_stale_${Math.round(input.heartbeatAgeMs / 60_000)}m`);
  }
  return { ok: issues.length === 0, issues };
}

/** @deprecated use assessProcessHealth */
export const assessHlTwapHealth = assessProcessHealth;

/** @param {string} line */
export function parseHeartbeatLogLine(line) {
  if (!line.includes('heartbeat')) return null;
  const m = line.match(
    /active_twaps=(\d+)\s+pending_live=(\d+)\s+live_opens=(\d+)/,
  );
  if (!m) return null;
  return {
    activeTwaps: Number(m[1]),
    pendingLive: Number(m[2]),
    liveOpens: Number(m[3]),
  };
}

/**
 * @param {Array<{ pm2: string, heartbeatPath: string, staleMs?: number, fatalPath?: string }>} targets
 */
export function parseWatchTargetsJson(raw, root) {
  if (!raw?.trim()) return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('STRATEGY_PROCESS_WATCH_TARGETS must be JSON array');
  return parsed.map((t) => ({
    pm2: String(t.pm2),
    heartbeatPath: pathIsAbsolute(t.heartbeatPath)
      ? String(t.heartbeatPath)
      : `${root}/${String(t.heartbeatPath).replace(/^\.\//, '')}`,
    staleMs: Number(t.staleMs || 300_000),
    fatalPath: t.fatalPath
      ? pathIsAbsolute(t.fatalPath)
        ? String(t.fatalPath)
        : `${root}/${String(t.fatalPath).replace(/^\.\//, '')}`
      : undefined,
  }));
}

function pathIsAbsolute(p) {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

export function defaultStrategyWatchTargets(root) {
  return [
    {
      pm2: 'hl-twap-telegram-watch',
      heartbeatPath: `${root}/data/hl-twap/heartbeat.json`,
      staleMs: 300_000,
      fatalPath: `${root}/data/hl-twap/last-fatal.json`,
    },
    {
      pm2: 'live-oscar',
      heartbeatPath: `${root}/data/ops-heartbeats/live-oscar.json`,
      /** Boot replay on multi-GB journal can block the event loop >5m before first paper heartbeat. */
      staleMs: 900_000,
      fatalPath: `${root}/data/live/last-fatal-live-oscar.json`,
    },
    {
      pm2: 'copy-trader',
      heartbeatPath: `${root}/data/ops-heartbeats/copy-trader.json`,
      staleMs: 300_000,
      fatalPath: `${root}/data/ops-heartbeats/copy-trader-last-fatal.json`,
    },
  ];
}

/** @param {Buffer|string} envBuf */
export function parseProcEnvironKey(envBuf, key) {
  const raw = Buffer.isBuffer(envBuf) ? envBuf.toString('binary') : String(envBuf);
  const needle = `${key}=`;
  for (const part of raw.split('\0')) {
    if (part.startsWith(needle)) return part.slice(needle.length);
  }
  return null;
}

/** @param {string} ecosystemText */
export function readExpectedLiveOscarEntrySplitLegUsd(ecosystemText) {
  const m = ecosystemText.match(/PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD:\s*['"](\d+)['"]/);
  return m?.[1] ?? null;
}

/**
 * @param {Array<{ pid: number, user: string, entrySplitLegUsd?: string|null, firstProbeEnabled?: string|null }>} rows
 * @param {{ expectedEntrySplitLegUsd?: string|null, expectedUser?: string }} [expected]
 */
export function assessLiveOscarProcessSingleton(rows, expected = {}) {
  const issues = [];
  const expectedUser = expected.expectedUser ?? 'salpha';
  const scriptRows = rows.filter((r) => Number.isFinite(r.pid) && r.pid > 0);

  if (scriptRows.length === 0) {
    issues.push('live_oscar_script_missing');
    return { ok: false, issues, count: 0, rows: scriptRows };
  }
  if (scriptRows.length > 1) {
    issues.push(`live_oscar_script_duplicate_${scriptRows.length}`);
  }
  for (const row of scriptRows) {
    if (row.user && row.user !== expectedUser) {
      issues.push(`live_oscar_wrong_user_${row.user}`);
    }
    const exp = expected.expectedEntrySplitLegUsd;
    const leg = row.entrySplitLegUsd;
    if (exp && leg && leg !== exp) {
      issues.push(`live_oscar_env_leg_mismatch_${leg}_not_${exp}`);
    }
    const probe = row.firstProbeEnabled;
    if (probe === '1' || probe === 'true') {
      issues.push('live_oscar_first_probe_enabled_on_process');
    }
  }
  return { ok: issues.length === 0, issues, count: scriptRows.length, rows: scriptRows };
}

/**
 * Linux VPS: node processes executing live-oscar.ts (any PM2 home / user).
 * @param {typeof execSync} [execSyncFn]
 */
export function scanLiveOscarScriptProcesses(execSyncFn = execSync) {
  if (process.platform !== 'linux') return [];
  try {
    const out = execSyncFn("pgrep -af 'loader.mjs src/scripts/live-oscar.ts' 2>/dev/null || true", {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map((line) => {
      const m = line.match(/^(\d+)\s+(.+)$/);
      const pid = Number(m?.[1] ?? 0);
      let user = '';
      let entrySplitLegUsd = null;
      let firstProbeEnabled = null;
      try {
        user = execSyncFn(`ps -o user= -p ${pid}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        user = '';
      }
      try {
        const envBuf = fs.readFileSync(`/proc/${pid}/environ`);
        entrySplitLegUsd = parseProcEnvironKey(
          envBuf,
          'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD',
        );
        firstProbeEnabled = parseProcEnvironKey(envBuf, 'LIVE_MINT_FIRST_PROBE_ENABLED');
      } catch {
        /* ignore */
      }
      return { pid, user, entrySplitLegUsd, firstProbeEnabled, cmd: m?.[2] ?? line };
    });
  } catch {
    return [];
  }
}

/** @param {typeof execSync} [execSyncFn] */
export function rootPm2HasOnlineLiveOscar(execSyncFn = execSync) {
  if (process.platform !== 'linux' || !fs.existsSync('/root/.pm2')) return false;
  try {
    const out = execSyncFn('PM2_HOME=/root/.pm2 HOME=/root pm2 jlist 2>/dev/null || echo []', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(out);
    return apps.some((a) => a?.name === 'live-oscar' && a?.pm2_env?.status === 'online');
  } catch {
    return false;
  }
}
