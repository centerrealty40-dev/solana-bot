/**
 * Каждые 30 мин — [REPORT][agent_429] в операторский Telegram: сколько HTTP 429 / rate-limit
 * за интервал по PM2-логам (+ опционально journal buy_fail/add_fail).
 *
 * Env:
 *   RATE_429_REPORT_INTERVAL_MS — период отчёта (default 1800000 = 30 min)
 *   RATE_429_REPORT_POLL_MS — как часто читать логи (default 60000)
 *   RATE_429_REPORT_STATE — JSON state (default data/rate-429-report-state.json)
 *   RATE_429_REPORT_LOGS — через запятую glob или пути; иначе все *-out.log / *-error.log в PM2_HOME/logs
 *   RATE_429_JOURNAL_PATHS — jsonl для buy_fail/add_fail с rate (default follow live+paper journals)
 *   RATE_429_REPORT_TELEGRAM — `0` только лог в stdout
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — операторский канал
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendTagged } from '../scripts/lib/telegram.mjs';

const INTERVAL_MS = Math.max(60_000, Number(process.env.RATE_429_REPORT_INTERVAL_MS || 30 * 60 * 1000));
const POLL_MS = Math.max(10_000, Number(process.env.RATE_429_REPORT_POLL_MS || 60_000));
const STATE_PATH =
  process.env.RATE_429_REPORT_STATE || path.join('data', 'rate-429-report-state.json');
const TELEGRAM_ON = !['0', 'false', 'no'].includes(
  String(process.env.RATE_429_REPORT_TELEGRAM ?? '1').toLowerCase(),
);

function defaultJournalPaths() {
  return [
    path.join('data', 'pumpswap-combo-follow', 'journal.jsonl'),
    path.join('data', 'pumpswap-combo-follow', 'paper-journal.jsonl'),
  ];
}

function journalPaths() {
  const raw = process.env.RATE_429_JOURNAL_PATHS || '';
  if (raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return defaultJournalPaths();
}

function pm2LogsDir() {
  return path.join(process.env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'logs');
}

function defaultLogFiles() {
  const dir = pm2LogsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /-(out|error)\.log$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

function logPaths() {
  const raw = process.env.RATE_429_REPORT_LOGS || '';
  if (raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((p) => {
        if (p.includes('*')) {
          const dir = path.dirname(p);
          const base = path.basename(p);
          const re = new RegExp(`^${base.replace(/\*/g, '.*')}$`, 'i');
          if (!fs.existsSync(dir)) return [];
          return fs
            .readdirSync(dir)
            .filter((f) => re.test(f))
            .map((f) => path.join(dir, f));
        }
        return [p];
      });
  }
  return defaultLogFiles();
}

function processKeyFromLogFile(absPath) {
  const base = path.basename(absPath);
  return base.replace(/-(out|error)\.log$/i, '') || base;
}

function journalKeyFromPath(absPath) {
  const base = path.basename(absPath);
  if (base.includes('paper')) return 'follow-paper-journal';
  if (base.includes('journal')) return 'follow-live-journal';
  return base.replace(/\.jsonl$/i, '');
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      offsets: j.offsets && typeof j.offsets === 'object' ? j.offsets : {},
      lastReportAt: typeof j.lastReportAt === 'number' ? j.lastReportAt : 0,
      windowStartIso: typeof j.windowStartIso === 'string' ? j.windowStartIso : new Date().toISOString(),
      pending: j.pending && typeof j.pending === 'object' ? j.pending : {},
    };
  } catch {
    return {
      offsets: {},
      lastReportAt: 0,
      windowStartIso: new Date().toISOString(),
      pending: {},
    };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function parseJsonFragment(line) {
  const i = line.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(line.slice(i));
  } catch {
    return null;
  }
}

function isRateLimitLine(line) {
  if (!line || typeof line !== 'string') return false;
  const obj = parseJsonFragment(line);
  if (obj && typeof obj === 'object') {
    if (obj.status === 429) return true;
    if (obj.rateLimited === true) return true;
    if (obj.reason === 'rate') return true;
    if (typeof obj.error === 'object' && obj.error?.code === 429) return true;
    if (typeof obj.error === 'object' && obj.error?.code === -32005) return true;
    if (obj.msg === 'request retry scheduled' && obj.status === 429) return true;
    const msg = String(obj.msg || '');
    if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg) || /too many requests/i.test(msg)) return true;
    const err = String(obj.error || '');
    if (/\b429\b/.test(err) || /too many requests/i.test(err)) return true;
    if (typeof obj.reason === 'string' && /^(rate|.*429|.*too many requests)/i.test(obj.reason)) return true;
  }
  if (/\b429\b/.test(line) && /status|HTTP|rate|limit|Too Many/i.test(line)) return true;
  if (/Too Many Requests/i.test(line)) return true;
  if (/"reason"\s*:\s*"rate"/.test(line)) return true;
  if (/rateLimited"\s*:\s*true/.test(line)) return true;
  if (/error.*-32005/.test(line)) return true;
  return false;
}

function isJournalRateFail(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const kind = String(obj.kind || '');
  if (!/(buy_fail|add_fail|sell_fail|fill_failed)/i.test(kind)) return false;
  const reason = String(obj.reason || obj.message || '');
  return /\b429\b/.test(reason) || /rate/i.test(reason) || /too many requests/i.test(reason);
}

function bump(state, key) {
  state.pending[key] = (state.pending[key] || 0) + 1;
}

function readNewLines(absPath, state) {
  if (!fs.existsSync(absPath)) return [];
  const st = fs.statSync(absPath);
  const size = st.size;
  let offset = state.offsets[absPath] ?? 0;
  if (offset > size) offset = 0;
  if (offset === size) return [];
  const fd = fs.openSync(absPath, 'r');
  try {
    const toRead = size - offset;
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, offset);
    state.offsets[absPath] = size;
    return buf.toString('utf8').split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function scanLogs(state) {
  for (const p of logPaths()) {
    const abs = path.resolve(p);
    const key = processKeyFromLogFile(abs);
    try {
      for (const line of readNewLines(abs, state)) {
        if (line.trim() && isRateLimitLine(line)) bump(state, key);
      }
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), err: String(e), file: abs }));
    }
  }
}

function scanJournals(state) {
  for (const p of journalPaths()) {
    const abs = path.resolve(p);
    const key = journalKeyFromPath(abs);
    try {
      for (const line of readNewLines(abs, state)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (isJournalRateFail(obj)) bump(state, key);
        } catch {
          if (isRateLimitLine(line)) bump(state, key);
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), err: String(e), journal: abs }));
    }
  }
}

function readQnMeterDay() {
  const p = process.env.QUICKNODE_USAGE_PATH || path.join('data', 'quicknode-usage.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof j.creditsUsedDay === 'number' && typeof j.dayUtc === 'string') {
      return { dayUtc: j.dayUtc, creditsUsedDay: Math.round(j.creditsUsedDay) };
    }
  } catch {
    /* */
  }
  return null;
}

function formatWindow(startIso, endIso) {
  const fmt = (iso) => {
    const d = new Date(iso);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  };
  return `${fmt(startIso)}–${fmt(endIso)}`;
}

function buildReportBody(state, endIso) {
  const entries = Object.entries(state.pending).filter(([, n]) => n > 0);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const window = formatWindow(state.windowStartIso, endIso);
  const lines = [
    `📊 429 / rate-limit за 30 мин (${window})`,
    '',
    `Всего: ${total}`,
  ];

  if (entries.length === 0) {
    lines.push('• за интервал событий не было');
  } else {
    entries.sort((a, b) => b[1] - a[1]);
    for (const [name, n] of entries) {
      lines.push(`• ${name}: ${n}`);
    }
  }

  const qn = readQnMeterDay();
  if (qn) {
    lines.push('');
    lines.push(
      `QN meter сегодня (${qn.dayUtc}): ${qn.creditsUsedDay.toLocaleString('en-US')} credits (локальный cap не блокирует)`,
    );
  }

  lines.push('');
  lines.push('Источник: PM2 logs + follow journal; для агента / triage.');

  return lines.join('\n');
}

async function maybeSendReport(state) {
  const now = Date.now();
  if (state.lastReportAt > 0 && now - state.lastReportAt < INTERVAL_MS) return;

  const endIso = new Date().toISOString();
  const body = buildReportBody(state, endIso);
  const total429 = Object.values(state.pending).reduce((a, b) => a + b, 0);

  if (TELEGRAM_ON) {
    await sendTagged('REPORT', 'agent_429', body, { skipQuietHours: true });
  } else {
    console.log(JSON.stringify({ ts: endIso, msg: 'rate-429 report (telegram off)', body }));
  }

  state.lastReportAt = now;
  state.windowStartIso = endIso;
  state.pending = {};
  saveState(state);

  console.log(
    JSON.stringify({
      ts: endIso,
      msg: 'rate-429 report sent',
      total429,
      telegram: TELEGRAM_ON,
    }),
  );
}

async function tick() {
  const state = loadState();
  scanLogs(state);
  scanJournals(state);
  saveState(state);
  await maybeSendReport(state);
}

async function main() {
  const logs = logPaths();
  const journals = journalPaths();
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: 'rate-429-halfhour-report start',
      intervalMin: INTERVAL_MS / 60_000,
      pollMs: POLL_MS,
      logFiles: logs.length,
      journals,
      statePath: STATE_PATH,
      telegram: TELEGRAM_ON,
    }),
  );

  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
