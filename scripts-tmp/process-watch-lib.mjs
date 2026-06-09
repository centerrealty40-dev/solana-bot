/**
 * Shared helpers for PM2 strategy process watchdogs.
 */

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
      staleMs: 300_000,
      fatalPath: `${root}/data/live/last-fatal-live-oscar.json`,
    },
    {
      pm2: 'copy-trader',
      heartbeatPath: `${root}/data/ops-heartbeats/copy-trader.json`,
      staleMs: 300_000,
      fatalPath: `${root}/data/ops-heartbeats/copy-trader-last-fatal.json`,
    },
    {
      pm2: 'pumpswap-combo-follow-live',
      heartbeatPath: `${root}/data/ops-heartbeats/pumpswap-combo-follow-live.json`,
      staleMs: 300_000,
      fatalPath: `${root}/data/ops-heartbeats/pumpswap-combo-follow-live-last-fatal.json`,
    },
  ];
}
