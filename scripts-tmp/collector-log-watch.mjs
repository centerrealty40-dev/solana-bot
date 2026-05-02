/**
 * Следит за PM2-логами DEX-коллекторов: Telegram при DexScreener/Gecko 429 (retry)
 * и при росте числа «skipping tick» в скользящем окне.
 *
 * Env:
 *   COLLECTOR_WATCH_POLL_MS — интервал чтения (default 15000)
 *   COLLECTOR_WATCH_LOGS — через запятую пути к *-out.log; иначе $PM2_HOME/logs/sa-{orca,moonshot,raydium,meteora,pumpswap}-out.log
 *   COLLECTOR_WATCH_STATE — JSON с оффсетами (default data/collector-log-watch-state.json)
 *   COLLECTOR_WATCH_THROTTLE_429_MS — пауза между объединёнными ALERT про 429 (default 90000)
 *   COLLECTOR_WATCH_THROTTLE_SKIP_MS — пауза для одиночных skip (default 120000)
 *   COLLECTOR_WATCH_SKIP_WINDOW_MS — окно «роста» skip (default 600000)
 *   COLLECTOR_WATCH_SKIP_SPIKE_MIN — порог «всплеска» skip за окно (default 3)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — как у остальных скриптов
 *   Опционально: TELEGRAM_COOLDOWN_ALERT_DEXSCREENER_429_MS — второй слой паузы в sendTagged (subtag dexscreener_429)
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendTagged } from '../scripts/lib/telegram.mjs';

const POLL_MS = Number(process.env.COLLECTOR_WATCH_POLL_MS || 15_000);
const STATE_PATH =
  process.env.COLLECTOR_WATCH_STATE || path.join('data', 'collector-log-watch-state.json');
const THROTTLE_429_MS = Number(process.env.COLLECTOR_WATCH_THROTTLE_429_MS ?? 90_000);
const THROTTLE_SKIP_MS = Number(process.env.COLLECTOR_WATCH_THROTTLE_SKIP_MS ?? 120_000);
const SKIP_WINDOW_MS = Number(process.env.COLLECTOR_WATCH_SKIP_WINDOW_MS ?? 600_000);
const SKIP_SPIKE_MIN = Number(process.env.COLLECTOR_WATCH_SKIP_SPIKE_MIN ?? 3);

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

/** Один Telegram на все 429 за тик: DexScreener/Gecko и т.д., без деления по коллекторам. */
async function flush429Alerts(state, pending) {
  if (!pending.length) return;
  const now = Date.now();
  if (now - (state.throttle['429:global'] ?? 0) < THROTTLE_429_MS) return;

  /** Последний объект по каждому коллектору за этот проход чтения логов */
  const byCollector = new Map();
  for (const { collector, obj } of pending) {
    byCollector.set(collector, obj);
  }

  const names = [...byCollector.keys()].sort();
  const details = names.map((c) => {
    const o = byCollector.get(c);
    const bits = [c];
    if (o.retryTag) bits.push(`tag=${o.retryTag}`);
    if (o.attempt != null) bits.push(`attempt=${o.attempt}`);
    if (o.backoffMs != null) bits.push(`backoff=${o.backoffMs}ms`);
    return bits.join(' ');
  });

  state.throttle['429:global'] = now;
  saveState(state);

  const text = [
    'Внешнее API (DexScreener/Gecko и др.): HTTP 429 — лимит запросов, запланирован retry.',
    `Затронутые коллекторы: ${names.join(', ')}.`,
    details.join(' | '),
  ].join(' ');

  await sendTagged('ALERT', 'dexscreener_429', text);
}

async function alertSkip(collector, state) {
  const now = Date.now();
  if (!state.skipTs[collector]) state.skipTs[collector] = [];
  pruneSkips(state, collector, now);
  state.skipTs[collector].push(now);
  const window = state.skipTs[collector];
  const n = window.length;

  const spikeN = state.lastSpikeN[collector] ?? 0;
  if (n >= SKIP_SPIKE_MIN && n > spikeN) {
    state.lastSpikeN[collector] = n;
    saveState(state);
    await sendTagged(
      'ALERT',
      `dex_skip_spike_${collector}`,
      `Рост «skipping tick»: ${n} за ${Math.round(SKIP_WINDOW_MS / 60000)} мин (${collector}). Тик дольше интервала — проверьте нагрузку/API/БД.`,
    );
    return;
  }

  const k = `skip:${collector}`;
  if (now - (state.throttle[k] ?? 0) < THROTTLE_SKIP_MS) return;
  state.throttle[k] = now;
  saveState(state);
  await sendTagged(
    'ALERT',
    `dex_skip_${collector}`,
    `Skipping tick (${collector}): предыдущий тик ещё выполняется. В окне ~${Math.round(SKIP_WINDOW_MS / 60000)} мин уже ${n} событ.`,
  );
}

/** Когда окно опустело — сбрасываем порог spike, чтобы следующая серия снова алертилась. */
function decaySpikeCounter(state, collector, now) {
  const window = pruneSkips(state, collector, now);
  if (window.length === 0 && (state.lastSpikeN[collector] ?? 0) > 0) {
    state.lastSpikeN[collector] = 0;
    saveState(state);
  }
}

async function scanFile(absPath, state, pending429) {
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
    const now = Date.now();

    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      const obj = parseJsonLine(line);
      if (!obj || typeof obj.msg !== 'string') continue;

      if (obj.msg === 'request retry scheduled' && obj.status === 429) {
        pending429.push({ collector: coll, obj });
      }
      if (obj.msg === 'skipping tick, previous run still active') {
        await alertSkip(coll, state);
      }
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

  const pending429 = [];
  for (const p of paths) {
    try {
      await scanFile(path.resolve(p), state, pending429);
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), err: String(e), file: p }));
    }
  }

  await flush429Alerts(state, pending429);

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
