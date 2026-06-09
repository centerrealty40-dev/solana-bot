/**
 * Pure helpers for hl-twap-process-watch (testable without PM2).
 */

/** @param {string} line */
export function parseHeartbeatLogLine(line) {
  if (!line.includes('[hl-twap-telegram-watch] heartbeat')) return null;
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
export function assessHlTwapHealth(input) {
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
