/**
 * External keepalive for Oscar trading apps — MUST NOT live only inside PM2.
 *
 * 1.11.685 — watches mild-dip-bot (+ strategy-process-watch). 8zkg twins retired.
 *
 * Usage: node scripts-tmp/strategy-keepalive-cron.mjs
 * Install: bash scripts/ops/install-strategy-keepalive-cron.sh
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { sendTagged } from '../scripts/lib/telegram.mjs';
import { parseHeartbeatJson } from './process-watch-lib.mjs';
import { ensureStrategyApps, STRATEGY_KEEPALIVE_APPS } from './strategy-keepalive-lib.mjs';

const ROOT = process.env.SOLANA_ALPHA_ROOT || process.cwd();
const TELEGRAM_ON = process.env.STRATEGY_KEEPALIVE_TELEGRAM !== '0';
const STALE_MS = Number(process.env.STRATEGY_KEEPALIVE_STALE_MS || 300_000);
const ALERT_REPEAT_MS = Number(process.env.STRATEGY_KEEPALIVE_ALERT_REPEAT_MS || 300_000);
const STATE_PATH =
  process.env.STRATEGY_KEEPALIVE_STATE_PATH ||
  path.join(ROOT, 'data/ops-heartbeats/strategy-keepalive-state.json');

const HEARTBEATS = {
  'mild-dip-bot': path.join(ROOT, 'data/ops-heartbeats/mild-dip-bot.json'),
  'strategy-process-watch': path.join(ROOT, 'data/ops-heartbeats/strategy-process-watch.json'),
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastAlertAt: 0, lastAlertKey: '' };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function heartbeatAgeMs(hbPath, now) {
  if (!fs.existsSync(hbPath)) return Infinity;
  try {
    const hb = parseHeartbeatJson(fs.readFileSync(hbPath, 'utf8'));
    if (!hb) return Infinity;
    return now - hb.ts;
  } catch {
    return Infinity;
  }
}

async function main() {
  const now = Date.now();
  const ensured = ensureStrategyApps({ root: ROOT, appNames: STRATEGY_KEEPALIVE_APPS });
  const issues = [];
  for (const row of ensured) {
    if (row.prevStatus !== 'online') {
      issues.push(
        `${row.name}: was ${row.prevStatus} → ${row.action}${row.error ? ` (${row.error})` : ''}`,
      );
    }
    const hbPath = HEARTBEATS[row.name];
    if (hbPath) {
      const age = heartbeatAgeMs(hbPath, now);
      if (age > STALE_MS) {
        const min = Number.isFinite(age) ? Math.round(age / 60_000) : '∞';
        issues.push(`${row.name}: heartbeat stale ~${min}m`);
      }
    }
  }

  const alertKey = issues.join('|') || 'ok';
  const state = loadState();
  const due =
    issues.length > 0 &&
    (now - (state.lastAlertAt ?? 0) >= ALERT_REPEAT_MS || state.lastAlertKey !== alertKey);

  if (due && TELEGRAM_ON) {
    const body = [
      'Strategy KEEPALIVE (cron, outside PM2):',
      ...issues.map((i) => `• ${i}`),
      'Auto-started missing copy lanes / process-watch from ecosystem.',
    ].join('\n');
    await sendTagged('ALERT', 'strategy_keepalive', body);
    state.lastAlertAt = now;
    state.lastAlertKey = alertKey;
    saveState(state);
  } else if (issues.length === 0 && state.lastAlertKey && state.lastAlertKey !== 'ok') {
    if (TELEGRAM_ON) {
      await sendTagged('ALERT', 'strategy_keepalive', 'Strategy KEEPALIVE: copy lanes recovered');
    }
    state.lastAlertAt = 0;
    state.lastAlertKey = 'ok';
    saveState(state);
  }

  console.log(
    JSON.stringify({
      ok: issues.length === 0,
      issues,
      ensured,
      ts: new Date(now).toISOString(),
    }),
  );
  process.exit(issues.length === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
