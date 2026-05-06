/**
 * Следит за PM2-логами DEX-коллекторов. Один Telegram [ALERT][dex_collectors] на события:
 * HTTP 429, retry по 5xx, сбои запросов, tick failed, skipping tick / всплеск skip,
 * pool shutdown, fatal.
 *
 * Env:
 *   COLLECTOR_WATCH_POLL_MS — интервал чтения (default 15000)
 *   COLLECTOR_WATCH_LOGS — через запятую пути к *-out.log
 *   COLLECTOR_WATCH_STATE — JSON (default data/collector-log-watch-state.json)
 *   COLLECTOR_WATCH_THROTTLE_ALERT_MS — пауза между алертами для «важных» событий
 *     (429, 5xx retry, сеть, всплеск skip, pool shutdown), не для tick_failed/fatal (default 90000)
 *   COLLECTOR_WATCH_THROTTLE_SKIP_MS — если в батче только обычный skipping tick (default 120000)
 *   COLLECTOR_WATCH_SKIP_WINDOW_MS / COLLECTOR_WATCH_SKIP_SPIKE_MIN — окно и порог всплеска skip
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *   TELEGRAM_COOLDOWN_ALERT_DEX_COLLECTORS_MS — опционально, второй слой в sendTagged
 *   COLLECTOR_WATCH_TELEGRAM — `0` не вызывает sendTagged (логи PM2 без изменений).
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendTagged } from '../scripts/lib/telegram.mjs';

const POLL_MS = Number(process.env.COLLECTOR_WATCH_POLL_MS || 15_000);
const STATE_PATH =
  process.env.COLLECTOR_WATCH_STATE || path.join('data', 'collector-log-watch-state.json');
const THROTTLE_ALERT_MS = Number(
  process.env.COLLECTOR_WATCH_THROTTLE_ALERT_MS ??
    process.env.COLLECTOR_WATCH_THROTTLE_429_MS ??
    90_000,
);
const THROTTLE_SKIP_MS = Number(process.env.COLLECTOR_WATCH_THROTTLE_SKIP_MS ?? 120_000);
const SKIP_WINDOW_MS = Number(process.env.COLLECTOR_WATCH_SKIP_WINDOW_MS ?? 600_000);
const SKIP_SPIKE_MIN = Number(process.env.COLLECTOR_WATCH_SKIP_SPIKE_MIN ?? 3);
const ERR_SNIP = Number(process.env.COLLECTOR_WATCH_ERR_SNIP || 280);
const COLLECTOR_WATCH_TELEGRAM = !['0', 'false', 'no'].includes(
  String(process.env.COLLECTOR_WATCH_TELEGRAM ?? '1').toLowerCase(),
);

function defaultLogFiles() {
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
  const logsDir = path.join(pm2Home, 'logs');
  return ['orca', 'moonshot', 'raydium', 'meteora', 'pumpswap'].map((n) =>
    path.join(logsDir, `sa-${n}-out.log`),
  );
}

function logPaths() {
  const raw = process.env.COLLECTOR_WATCH_LOGS || '';
  if (raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return defaultLogFiles();
}

function collectorKey(logFile) {
  const base = path.basename(logFile).replace(/-out\.log$/i, '');
  return base.replace(/^sa-/i, '') || base;
}

function parseJsonLine(line) {
  const i = line.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(line.slice(i));
  } catch {
    return null;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { offsets: {}, throttle: {}, skipTs: {}, lastSpikeN: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function pruneSkips(state, collector, now) {
  const arr = state.skipTs[collector] || [];
  state.skipTs[collector] = arr.filter((t) => now - t < SKIP_WINDOW_MS);
  return state.skipTs[collector];
}

function emptyBatch() {
  return {
    http429: [],
    httpRetryOther: [],
    requestFailedRetrying: [],
    tickFailed: [],
    poolShutdown: [],
    fatal: [],
    skipLines: [],
    skipHadSpike: false,
  };
}

function snip(s) {
  if (typeof s !== 'string') return '';
  return s.length <= ERR_SNIP ? s : `${s.slice(0, ERR_SNIP)}…`;
}

/** skip → строки для общего сообщения + флаг всплеска */
function recordSkip(state, collector, batch) {
  const now = Date.now();
  if (!state.skipTs[collector]) state.skipTs[collector] = [];
  pruneSkips(state, collector, now);
  state.skipTs[collector].push(now);
  const window = state.skipTs[collector];
  const n = window.length;
  const winMin = Math.round(SKIP_WINDOW_MS / 60000);

  const spikeN = state.lastSpikeN[collector] ?? 0;
  if (n >= SKIP_SPIKE_MIN && n > spikeN) {
    state.lastSpikeN[collector] = n;
    saveState(state);
    batch.skipHadSpike = true;
    batch.skipLines.push(
      `Тик не успевает — всплеск «skipping tick» (${collector}): ${n} раз за ${winMin} мин (интервал короче длительности тика).`,
    );
    return;
  }

  const k = `skipplain:${collector}`;
  if (now - (state.throttle[k] ?? 0) < THROTTLE_SKIP_MS) return;
  state.throttle[k] = now;
  saveState(state);
  batch.skipLines.push(
    `Тик не успевает (${collector}): предыдущий тик ещё выполняется (за ${winMin} мин в окне ${n} событ.).`,
  );
}

function dispatchLine(coll, obj, state, batch) {
  const msg = obj.msg;
  if (msg === 'request retry scheduled' && obj.status === 429) {
    batch.http429.push({ collector: coll, obj });
    return;
  }
  if (msg === 'request retry scheduled' && obj.status != null && obj.status !== 429) {
    batch.httpRetryOther.push({ collector: coll, obj });
    return;
  }
  if (msg === 'request failed, retrying') {
    batch.requestFailedRetrying.push({ collector: coll, obj });
    return;
  }
  if (msg === 'tick failed') {
    batch.tickFailed.push({ collector: coll, obj });
    return;
  }
  if (msg === 'skipping tick, previous run still active') {
    recordSkip(state, coll, batch);
    return;
  }
  if (msg === 'pool shutdown warning') {
    batch.poolShutdown.push({ collector: coll, obj });
    return;
  }
  if (msg === 'fatal error') {
    batch.fatal.push({ collector: coll, obj });
  }
}

function batchHasContent(b) {
  return !!(
    b.http429.length ||
    b.httpRetryOther.length ||
    b.requestFailedRetrying.length ||
    b.tickFailed.length ||
    b.poolShutdown.length ||
    b.fatal.length ||
    b.skipLines.length
  );
}

/** Только «мягкий» skipping tick, без остального */
function batchIsRoutineOnly(b) {
  return (
    !b.http429.length &&
    !b.httpRetryOther.length &&
    !b.requestFailedRetrying.length &&
    !b.tickFailed.length &&
    !b.poolShutdown.length &&
    !b.fatal.length &&
    b.skipLines.length > 0 &&
    !b.skipHadSpike
  );
}

function buildAlertBody(batch) {
  const lines = ['⚠️ Коллекторы DEX — проблемы в логах:'];

  if (batch.http429.length) {
    const by = new Map();
    for (const { collector, obj } of batch.http429) {
      by.set(collector, obj);
    }
    const names = [...by.keys()].sort();
    const details = names.map((c) => {
      const o = by.get(c);
      const bits = [c];
      if (o.retryTag) bits.push(`tag=${o.retryTag}`);
      if (o.attempt != null) bits.push(`attempt=${o.attempt}`);
      if (o.backoffMs != null) bits.push(`backoff=${o.backoffMs}ms`);
      return bits.join(' ');
    });
    lines.push(`• HTTP 429 (лимит запросов / rate limit): ${names.join(', ')}`);
    lines.push(`  ${details.join(' | ')}`);
  }

  if (batch.httpRetryOther.length) {
    const parts = batch.httpRetryOther.map(({ collector, obj }) => {
      const bits = [`${collector}`];
      if (obj.status != null) bits.push(`HTTP ${obj.status}`);
      if (obj.retryTag) bits.push(String(obj.retryTag));
      return bits.join(' ');
    });
    lines.push(`• HTTP retry (5xx и т.п., не 429): ${parts.join('; ')}`);
  }

  const netMax = Number(process.env.COLLECTOR_WATCH_NET_EVENTS_MAX || 6);
  if (batch.requestFailedRetrying.length) {
    const slice = batch.requestFailedRetrying.slice(0, netMax);
    const parts = slice.map(({ collector, obj }) => {
      return `${collector}: ${snip(obj.error || '')}`;
    });
    lines.push(`• Запрос не удался, retry: ${parts.join(' · ')}`);
    if (batch.requestFailedRetrying.length > netMax) {
      lines.push(`  …ещё ${batch.requestFailedRetrying.length - netMax} строк`);
    }
  }

  for (const { collector, obj } of batch.tickFailed) {
    lines.push(`• Ошибка тика (${collector}): ${snip(obj.error || '')}`);
  }

  for (const line of batch.skipLines) {
    lines.push(`• ${line}`);
  }

  for (const { collector, obj } of batch.poolShutdown) {
    lines.push(`• Pool / БД (${collector}): ${snip(obj.error || 'shutdown warning')}`);
  }

  for (const { collector, obj } of batch.fatal) {
    lines.push(`• FATAL (${collector}): ${snip(obj.error || '')}`);
  }

  return lines.join('\n');
}

async function flushUnifiedAlert(state, batch) {
  if (!batchHasContent(batch)) return;

  const now = Date.now();
  const immediate = batch.tickFailed.length > 0 || batch.fatal.length > 0;

  if (!immediate) {
    if (batchIsRoutineOnly(batch)) {
      if (now - (state.throttle['unified:routine'] ?? 0) < THROTTLE_SKIP_MS) return;
      state.throttle['unified:routine'] = now;
    } else {
      if (now - (state.throttle['unified:alert'] ?? 0) < THROTTLE_ALERT_MS) return;
      state.throttle['unified:alert'] = now;
    }
    saveState(state);
  }

  const body = buildAlertBody(batch);
  if (COLLECTOR_WATCH_TELEGRAM) await sendTagged('ALERT', 'dex_collectors', body);
}

function decaySpikeCounter(state, collector, now) {
  const window = pruneSkips(state, collector, now);
  if (window.length === 0 && (state.lastSpikeN[collector] ?? 0) > 0) {
    state.lastSpikeN[collector] = 0;
    saveState(state);
  }
}

function scanFile(absPath, state, batch) {
  if (!fs.existsSync(absPath)) return;
  const st = fs.statSync(absPath);
  const size = st.size;
  let offset = state.offsets[absPath] ?? 0;
  if (offset > size) offset = 0;
  if (offset === size) {
    decaySpikeCounter(state, collectorKey(absPath), Date.now());
    return;
  }

  const fd = fs.openSync(absPath, 'r');
  try {
    const toRead = size - offset;
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, offset);
    const chunk = buf.toString('utf8');
    const coll = collectorKey(absPath);

    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      const obj = parseJsonLine(line);
      if (!obj || typeof obj.msg !== 'string') continue;
      dispatchLine(coll, obj, state, batch);
    }

    state.offsets[absPath] = size;
    saveState(state);
    decaySpikeCounter(state, coll, Date.now());
  } finally {
    fs.closeSync(fd);
  }
}

async function tick() {
  const paths = logPaths();
  const state = loadState();
  if (!state.offsets) state.offsets = {};
  if (!state.throttle) state.throttle = {};
  if (!state.skipTs) state.skipTs = {};
  if (!state.lastSpikeN) state.lastSpikeN = {};

  const batch = emptyBatch();
  for (const p of paths) {
    try {
      scanFile(path.resolve(p), state, batch);
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), err: String(e), file: p }));
    }
  }

  await flushUnifiedAlert(state, batch);

  const now = Date.now();
  for (const p of paths) {
    decaySpikeCounter(state, collectorKey(path.resolve(p)), now);
  }
}

async function main() {
  const paths = logPaths();
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: 'collector-log-watch start',
      pollMs: POLL_MS,
      logs: paths,
      statePath: STATE_PATH,
      telegramTag: 'dex_collectors',
      telegramEnabled: COLLECTOR_WATCH_TELEGRAM,
      throttleAlertMs: THROTTLE_ALERT_MS,
      throttleRoutineSkipMs: THROTTLE_SKIP_MS,
      skipWindowMin: SKIP_WINDOW_MS / 60000,
      skipSpikeMin: SKIP_SPIKE_MIN,
    }),
  );

  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
