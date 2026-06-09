/**
 * HL TWAP 24/7 watchdog: PM2 status + heartbeat file + auto-restart + Telegram ALERT.
 *
 * Env:
 *   HL_TWAP_WATCH_PM2_APP — default hl-twap-telegram-watch
 *   HL_TWAP_WATCH_POLL_MS — default 30000
 *   HL_TWAP_WATCH_HEARTBEAT_PATH — default data/hl-twap/heartbeat.json
 *   HL_TWAP_WATCH_HEARTBEAT_MAX_STALE_MS — default 300000 (5 min)
 *   HL_TWAP_WATCH_AUTO_RESTART — default 1 (pm2 restart on fault)
 *   HL_TWAP_WATCH_TELEGRAM — default 1
 *   HL_TWAP_WATCH_ALERT_REPEAT_MIN — default 15
 *   HL_TWAP_WATCH_STATE_PATH — default data/hl-twap/process-watch-state.json
 *   TELEGRAM_* — operator channel (see scripts/lib/telegram.mjs)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sendTagged } from '../scripts/lib/telegram.mjs';
import { assessHlTwapHealth, parseHeartbeatJson } from './hl-twap-watch-lib.mjs';

const ROOT = process.cwd();
const PM2_APP = process.env.HL_TWAP_WATCH_PM2_APP || 'hl-twap-telegram-watch';
const POLL_MS = Number(process.env.HL_TWAP_WATCH_POLL_MS || 30_000);
const HEARTBEAT_PATH =
  process.env.HL_TWAP_WATCH_HEARTBEAT_PATH ||
  path.join(ROOT, 'data/hl-twap/heartbeat.json');
const HEARTBEAT_MAX_STALE_MS = Number(
  process.env.HL_TWAP_WATCH_HEARTBEAT_MAX_STALE_MS || 300_000,
);
const TELEGRAM_ON = process.env.HL_TWAP_WATCH_TELEGRAM !== '0';
const AUTO_RESTART = process.env.HL_TWAP_WATCH_AUTO_RESTART !== '0';
const REPEAT_MIN = Number(process.env.HL_TWAP_WATCH_ALERT_REPEAT_MIN || 15);
const STATE_PATH =
  process.env.HL_TWAP_WATCH_STATE_PATH ||
  path.join(ROOT, 'data/hl-twap/process-watch-state.json');
const LAST_FATAL_PATH = path.join(ROOT, 'data/hl-twap/last-fatal.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function getPm2Status() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const apps = JSON.parse(out);
    const app = apps.find((a) => a.name === PM2_APP);
    return app?.pm2_env?.status ?? 'missing';
  } catch {
    return 'unknown';
  }
}

function readHeartbeatAgeMs(now) {
  if (!fs.existsSync(HEARTBEAT_PATH)) return Infinity;
  try {
    const hb = parseHeartbeatJson(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
    if (!hb) return Infinity;
    return now - hb.ts;
  } catch {
    return Infinity;
  }
}

function readLastFatal() {
  if (!fs.existsSync(LAST_FATAL_PATH)) return null;
  try {
    return parseHeartbeatJson(fs.readFileSync(LAST_FATAL_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function pm2Restart() {
  execSync(`pm2 restart ${PM2_APP} --update-env`, {
    cwd: ROOT,
    stdio: 'pipe',
  });
}

function issueDetail(issue, status, heartbeatAgeMs) {
  if (issue.startsWith('pm2_status_')) {
    return `PM2 ${PM2_APP} status=${status} (expected online)`;
  }
  if (issue.startsWith('heartbeat_stale_')) {
    const min = Math.round(heartbeatAgeMs / 60_000);
    return `heartbeat stale ~${min}m (file ${HEARTBEAT_PATH})`;
  }
  return issue;
}

async function tick() {
  const now = Date.now();
  const state = loadState();
  const status = getPm2Status();
  const heartbeatAgeMs = readHeartbeatAgeMs(now);
  const health = assessHlTwapHealth({
    status,
    heartbeatAgeMs,
    heartbeatMaxStaleMs: HEARTBEAT_MAX_STALE_MS,
  });

  let restarted = false;
  if (!health.ok && AUTO_RESTART) {
    try {
      pm2Restart();
      restarted = true;
    } catch (e) {
      health.issues.push(`restart_failed:${String(e?.message || e).slice(0, 200)}`);
    }
  }

  const fatal = readLastFatal();
  if (fatal?.ts && state.lastFatalTsAlerted !== fatal.ts) {
    const msg = `last-fatal ${new Date(fatal.ts).toISOString()}\n${fatal.source}: ${fatal.message}`;
    if (TELEGRAM_ON) await sendTagged('ALERT', 'hl_twap_watch', `HL TWAP watchdog fatal:\n${msg}`);
    state.lastFatalTsAlerted = fatal.ts;
    saveState(state);
  }

  if (!health.ok) {
    const key = health.issues.join('|');
    const due = now - (state.lastAlertAt ?? 0) >= REPEAT_MIN * 60_000 || state.lastAlertKey !== key;
    if (due) {
      const lines = health.issues.map((i) => `• ${issueDetail(i, status, heartbeatAgeMs)}`);
      if (restarted) lines.push('• pm2 restart issued');
      const body = [`HL TWAP watchdog (${PM2_APP}):`, ...lines].join('\n');
      if (TELEGRAM_ON) await sendTagged('ALERT', 'hl_twap_watch', body);
      state.lastAlertAt = now;
      state.lastAlertKey = key;
      saveState(state);
    }
  } else if (state.lastAlertKey) {
    if (TELEGRAM_ON) {
      await sendTagged('ALERT', 'hl_twap_watch', `HL TWAP watchdog: ${PM2_APP} recovered (online + heartbeat ok)`);
    }
    state.lastAlertKey = '';
    state.lastAlertAt = 0;
    saveState(state);
  }

  console.log(
    JSON.stringify({
      ok: health.ok,
      status,
      heartbeatAgeSec: Number.isFinite(heartbeatAgeMs) ? Math.round(heartbeatAgeMs / 1000) : null,
      issues: health.issues,
      restarted,
      ts: new Date(now).toISOString(),
    }),
  );
}

async function main() {
  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
