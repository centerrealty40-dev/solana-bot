/**
 * Unified PM2 watchdog for live trading bots: status + heartbeat + auto-restart + Telegram.
 *
 * Watches by default: hl-twap-telegram-watch, live-oscar, copy-trader.
 * Override: STRATEGY_PROCESS_WATCH_TARGETS JSON array [{ pm2, heartbeatPath, staleMs?, fatalPath? }]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sendTagged } from '../scripts/lib/telegram.mjs';
import {
  assessProcessHealth,
  defaultStrategyWatchTargets,
  parseHeartbeatJson,
  parseWatchTargetsJson,
} from './process-watch-lib.mjs';

const ROOT = process.cwd();
const POLL_MS = Number(process.env.STRATEGY_PROCESS_WATCH_POLL_MS || 30_000);
const TELEGRAM_ON = process.env.STRATEGY_PROCESS_WATCH_TELEGRAM !== '0';
const AUTO_RESTART = process.env.STRATEGY_PROCESS_WATCH_AUTO_RESTART !== '0';
const REPEAT_MIN = Number(process.env.STRATEGY_PROCESS_WATCH_ALERT_REPEAT_MIN || 15);
const STATE_PATH =
  process.env.STRATEGY_PROCESS_WATCH_STATE_PATH ||
  path.join(ROOT, 'data/ops-heartbeats/process-watch-state.json');

function loadTargets() {
  const raw = process.env.STRATEGY_PROCESS_WATCH_TARGETS;
  return parseWatchTargetsJson(raw, ROOT) ?? defaultStrategyWatchTargets(ROOT);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { alerts: {}, fatals: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function getPm2StatusMap() {
  try {
    const out = execSync('pm2 jlist', {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(out);
    const map = new Map();
    for (const app of apps) map.set(app.name, app?.pm2_env?.status ?? 'unknown');
    return map;
  } catch {
    return new Map();
  }
}

function readHeartbeatAgeMs(heartbeatPath, now) {
  if (!fs.existsSync(heartbeatPath)) return Infinity;
  try {
    const hb = parseHeartbeatJson(fs.readFileSync(heartbeatPath, 'utf8'));
    if (!hb) return Infinity;
    return now - hb.ts;
  } catch {
    return Infinity;
  }
}

function readFatal(fatalPath) {
  if (!fatalPath || !fs.existsSync(fatalPath)) return null;
  try {
    return parseHeartbeatJson(fs.readFileSync(fatalPath, 'utf8'));
  } catch {
    return null;
  }
}

function pm2Restart(pm2Name) {
  execSync(`pm2 restart ${pm2Name} --update-env`, { cwd: ROOT, stdio: 'pipe' });
}

function issueDetail(issue, target, status, heartbeatAgeMs) {
  if (issue.startsWith('pm2_status_')) {
    return `${target.pm2}: PM2 status=${status} (expected online)`;
  }
  if (issue.startsWith('heartbeat_stale_')) {
    const min = Math.round(heartbeatAgeMs / 60_000);
    return `${target.pm2}: heartbeat stale ~${min}m (${target.heartbeatPath})`;
  }
  return `${target.pm2}: ${issue}`;
}

async function tick() {
  const now = Date.now();
  const state = loadState();
  if (!state.alerts) state.alerts = {};
  if (!state.fatals) state.fatals = {};
  const targets = loadTargets();
  const statusMap = getPm2StatusMap();
  const summary = [];

  for (const target of targets) {
    const status = statusMap.get(target.pm2) ?? 'missing';
    const heartbeatAgeMs = readHeartbeatAgeMs(target.heartbeatPath, now);
    const health = assessProcessHealth({
      status,
      heartbeatAgeMs,
      heartbeatMaxStaleMs: target.staleMs,
    });

    let restarted = false;
    if (!health.ok && AUTO_RESTART) {
      try {
        pm2Restart(target.pm2);
        restarted = true;
      } catch (e) {
        health.issues.push(`restart_failed:${String(e?.message || e).slice(0, 160)}`);
      }
    }

    const fatal = readFatal(target.fatalPath);
    const fatalKey = `${target.pm2}:${fatal?.ts ?? 0}`;
    if (fatal?.ts && state.fatals[fatalKey] !== fatal.ts) {
      const msg = `${target.pm2} last-fatal ${new Date(fatal.ts).toISOString()}\n${fatal.source ?? 'fatal'}: ${fatal.message ?? ''}`;
      if (TELEGRAM_ON) await sendTagged('ALERT', 'strategy_watch', msg);
      state.fatals[fatalKey] = fatal.ts;
    }

    if (!health.ok) {
      const alertKey = health.issues.join('|');
      const prev = state.alerts[target.pm2] ?? {};
      const due =
        now - (prev.lastAlertAt ?? 0) >= REPEAT_MIN * 60_000 || prev.lastAlertKey !== alertKey;
      if (due) {
        const lines = health.issues.map((i) => `• ${issueDetail(i, target, status, heartbeatAgeMs)}`);
        if (restarted) lines.push(`• pm2 restart ${target.pm2} issued`);
        const body = [`Strategy watchdog:`, ...lines].join('\n');
        if (TELEGRAM_ON) await sendTagged('ALERT', 'strategy_watch', body);
        state.alerts[target.pm2] = { lastAlertAt: now, lastAlertKey: alertKey };
      }
    } else if (state.alerts[target.pm2]?.lastAlertKey) {
      if (TELEGRAM_ON) {
        await sendTagged('ALERT', 'strategy_watch', `Strategy watchdog: ${target.pm2} recovered`);
      }
      state.alerts[target.pm2] = { lastAlertAt: 0, lastAlertKey: '' };
    }

    summary.push({
      pm2: target.pm2,
      ok: health.ok,
      status,
      heartbeatAgeSec: Number.isFinite(heartbeatAgeMs) ? Math.round(heartbeatAgeMs / 1000) : null,
      issues: health.issues,
      restarted,
    });
  }

  saveState(state);
  console.log(JSON.stringify({ ok: summary.every((s) => s.ok), targets: summary, ts: new Date(now).toISOString() }));
}

async function main() {
  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
