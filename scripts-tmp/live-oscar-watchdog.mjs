/**
 * Живой Оскар — внешний watchdog для автономной работы.
 * Проверяет свежесть heartbeat в LIVE_TRADES_PATH и наличие data/live/last-fatal.json.
 * Запуск по cron каждые 1–3 минуты под тем же пользователем, что и процесс (salpha), из /opt/solana-alpha.
 *
 * Env:
 *   LIVE_TRADES_PATH — JSONL (default data/live/pt1-oscar-live.jsonl от cwd)
 *   LIVE_WATCHDOG_MAX_STALE_MIN — порог «мёртвого» heartbeat (default 4; интервал heartbeat обычно 60 с)
 *   LIVE_WATCHDOG_TAIL_LINES — сколько последних строк читать (default 400)
 *   LIVE_WATCHDOG_TELEGRAM=0 — не слать в Telegram (только stdout / exit code)
 *   LIVE_WATCHDOG_ALERT_REPEAT_MIN — не чаще одного алерта по stale/missing на этот интервал (default 15)
 *   LIVE_WATCHDOG_FATAL_MAX_AGE_H — учитывать last-fatal только если новее N часов (default 72)
 *   LIVE_WATCHDOG_STATE_PATH — state для дедупа (default data/live/watchdog-state.json)
 *   TELEGRAM_* — как в hourly / paper2-healthcheck (на VPS часто в `.env.hourly`)
 * Опционально для cooldown между сообщениями: TELEGRAM_COOLDOWN_ALERT_LIVE_WATCHDOG_MS
 *
 * Загрузка env: сначала `.env`, затем `.env.hourly` (не перезаписывает уже заданные ключи).
 */
import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.hourly' });
import { sendTagged } from '../scripts/lib/telegram.mjs';

const ROOT = process.cwd();
const LIVE_TRADES_PATH =
  process.env.LIVE_TRADES_PATH || path.join(ROOT, 'data/live/pt1-oscar-live.jsonl');
const LAST_FATAL_PATH =
  process.env.LIVE_WATCHDOG_LAST_FATAL_PATH || path.join(ROOT, 'data/live/last-fatal.json');
const STATE_PATH =
  process.env.LIVE_WATCHDOG_STATE_PATH || path.join(ROOT, 'data/live/watchdog-state.json');
const MAX_STALE_MIN = Number(process.env.LIVE_WATCHDOG_MAX_STALE_MIN || 4);
const TAIL_LINES = Number(process.env.LIVE_WATCHDOG_TAIL_LINES || 400);
const TELEGRAM_ON = process.env.LIVE_WATCHDOG_TELEGRAM !== '0';
const REPEAT_MIN = Number(process.env.LIVE_WATCHDOG_ALERT_REPEAT_MIN || 15);
const FATAL_MAX_AGE_H = Number(process.env.LIVE_WATCHDOG_FATAL_MAX_AGE_H || 72);

function tailLastHeartbeatTs(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let buf;
  try {
    buf = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const lines = buf.split('\n');
  const start = Math.max(0, lines.length - TAIL_LINES);
  for (let i = lines.length - 1; i >= start; i--) {
    const ln = lines[i];
    if (!ln) continue;
    if (!ln.includes('"heartbeat"')) continue;
    try {
      const j = JSON.parse(ln);
      if (j && j.kind === 'heartbeat' && typeof j.ts === 'number') return j.ts;
    } catch {
      // skip
    }
  }
  return null;
}

function readLastFatal() {
  if (!fs.existsSync(LAST_FATAL_PATH)) return null;
  try {
    const raw = fs.readFileSync(LAST_FATAL_PATH, 'utf8').trim();
    const line = raw.split('\n')[0];
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(s) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

async function main() {
  const now = Date.now();
  const staleCutoffMin = MAX_STALE_MIN;

  let heartbeatTs = null;
  let heartbeatAgeMin = null;
  let heartbeatIssue = null;

  if (!fs.existsSync(LIVE_TRADES_PATH)) {
    heartbeatIssue = 'missing_jsonl';
  } else {
    heartbeatTs = tailLastHeartbeatTs(LIVE_TRADES_PATH);
    if (heartbeatTs == null) heartbeatIssue = 'no_heartbeat_in_tail';
    else {
      heartbeatAgeMin = (now - heartbeatTs) / 60000;
      if (heartbeatAgeMin > staleCutoffMin) heartbeatIssue = 'heartbeat_stale';
    }
  }

  const fatal = readLastFatal();
  let fatalIssue = null;
  if (fatal && typeof fatal.ts === 'number') {
    const fatalAgeH = (now - fatal.ts) / 3600000;
    if (fatalAgeH <= FATAL_MAX_AGE_H)
      fatalIssue = {
        ts: fatal.ts,
        text: `${fatal.source}: ${fatal.message}`.slice(0, 900),
      };
  }

  const state = loadState();
  const telegramLines = [];
  let stateDirty = false;

  if (heartbeatIssue) {
    const repeatKey = 'lastStaleOrMissingAlertAt';
    const last = state[repeatKey] ?? 0;
    const due = now - last >= REPEAT_MIN * 60_000;
    let detail;
    if (heartbeatIssue === 'missing_jsonl') detail = `no file ${LIVE_TRADES_PATH}`;
    else if (heartbeatIssue === 'no_heartbeat_in_tail')
      detail = `no heartbeat in last ${TAIL_LINES} lines of ${LIVE_TRADES_PATH}`;
    else detail = `last heartbeat ${heartbeatAgeMin?.toFixed(1)}m ago (threshold ${staleCutoffMin}m)`;

    if (due) {
      telegramLines.push(`live-oscar watchdog: ${heartbeatIssue}\n${detail}`);
      state[repeatKey] = now;
      stateDirty = true;
    }
  } else if (state.lastStaleOrMissingAlertAt) {
    state.lastStaleOrMissingAlertAt = 0;
    stateDirty = true;
  }

  if (fatalIssue) {
    const alertedTs = state.lastFatalTsAlerted;
    if (alertedTs !== fatalIssue.ts) {
      telegramLines.push(
        `live-oscar watchdog: last-fatal.json (${new Date(fatalIssue.ts).toISOString()})\n${fatalIssue.text}`,
      );
      state.lastFatalTsAlerted = fatalIssue.ts;
      stateDirty = true;
    }
  }

  const summary = {
    ok: !heartbeatIssue && !fatalIssue,
    now: new Date(now).toISOString(),
    liveTradesPath: LIVE_TRADES_PATH,
    heartbeatIssue,
    heartbeatAgeMin: heartbeatAgeMin != null ? +heartbeatAgeMin.toFixed(2) : null,
    fatalAcknowledged: fatalIssue ? state.lastFatalTsAlerted === fatalIssue.ts : null,
    telegramSent: false,
  };

  if (telegramLines.length && TELEGRAM_ON) {
    const text = telegramLines.join('\n\n').slice(0, 3900);
    await sendTagged('ALERT', 'live_watchdog', text);
    summary.telegramSent = true;
  }

  if (stateDirty) saveState(state);

  console.log(JSON.stringify(summary, null, 2));

  if (heartbeatIssue || fatalIssue) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
