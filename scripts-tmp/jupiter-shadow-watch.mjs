/**
 * Проверка shadow JSONL (signal-lab, mtm-shadow) за окно времени — доля ошибок Jupiter HTTP.
 * Не вызывает Solana RPC; только чтение локальных файлов.
 *
 * Cron: scripts/cron/install-jupiter-shadow-watch-cron-salpha.sh
 *
 * Telegram: если заданы TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, алерты включаются по умолчанию
 * (override: SHADOW_WATCH_TELEGRAM=0). Установщик cron передаёт SHADOW_WATCH_TELEGRAM=1 явно.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const ROOT = process.env.SOLANA_ALPHA_ROOT || process.cwd();
dotenv.config({ path: path.join(ROOT, '.env') });

const WINDOW_MS = Number(process.env.SHADOW_WATCH_WINDOW_MS || 600_000);
const TAIL_BYTES = Number(process.env.SHADOW_WATCH_TAIL_BYTES || 4 * 1024 * 1024);
const MIN_EVENTS = Number(process.env.SHADOW_WATCH_MIN_EVENTS || 5);
const MAX_ERR_RATIO = Number(process.env.SHADOW_WATCH_MAX_ERR_RATIO || 0.4);

function shadowWatchTelegramEnabled() {
  const raw = process.env.SHADOW_WATCH_TELEGRAM;
  if (raw !== undefined && String(raw).trim() !== '') {
    return ['1', 'true', 'yes'].includes(String(raw).trim().toLowerCase());
  }
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  return !!(token && chat);
}

const TELEGRAM_ON = shadowWatchTelegramEnabled();
const COOLDOWN_MS = Number(process.env.SHADOW_WATCH_ALERT_COOLDOWN_MS || 1_800_000);
const STATE_PATH =
  process.env.SHADOW_WATCH_STATE_PATH || path.join(ROOT, 'data', 'live', 'jupiter-shadow-watch-state.json');

const SIGNAL_PATH =
  process.env.SHADOW_WATCH_SIGNAL_PATH || path.join(ROOT, 'data', 'live', 'signal-lab.jsonl');
const MTM_PATH =
  process.env.SHADOW_WATCH_MTM_PATH || path.join(ROOT, 'data', 'live', 'mtm-shadow.jsonl');

function readTailText(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) return '';
    const fd = fs.openSync(filePath, 'r');
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function scanWindow(text, sinceTs, channel, kindErrorPred) {
  let total = 0;
  let errs = 0;
  if (!text) return { total, errs };
  const lines = text.split('\n').filter(Boolean);
  for (const ln of lines) {
    let row;
    try {
      row = JSON.parse(ln);
    } catch {
      continue;
    }
    const ts = typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : 0;
    if (ts < sinceTs) continue;
    if (row.channel !== channel) continue;
    total += 1;
    if (kindErrorPred(row)) errs += 1;
  }
  return { total, errs };
}

function signalLabHasError(row) {
  const p = row.payload;
  if (!p || typeof p !== 'object') return false;
  const e = p.error;
  return typeof e === 'string' && e.trim().length > 0;
}

function mtmShadowAltError(row) {
  const p = row.payload;
  if (!p || typeof p !== 'object') return false;
  const e = p.errorAlt;
  return typeof e === 'string' && e.trim().length > 0;
}

function readCooldownState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return typeof j.lastAlertTs === 'number' ? j.lastAlertTs : 0;
  } catch {
    return 0;
  }
}

function writeCooldownState(ts) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ lastAlertTs: ts }, null, 2), 'utf8');
  } catch {
    /* noop */
  }
}

async function maybeTelegram(text) {
  if (!TELEGRAM_ON) return;
  const last = readCooldownState();
  if (Date.now() - last < COOLDOWN_MS) return;
  const { sendTagged } = await import('../scripts/lib/telegram.mjs');
  const ok = await sendTagged('ALERT', 'health', text);
  if (ok) writeCooldownState(Date.now());
}

async function main() {
  const now = Date.now();
  const since = now - WINDOW_MS;

  const sigTail = readTailText(SIGNAL_PATH, TAIL_BYTES);
  const mtmTail = readTailText(MTM_PATH, TAIL_BYTES);

  const sig = scanWindow(sigTail, since, 'signal_lab', signalLabHasError);
  const mtm = scanWindow(mtmTail, since, 'mtm_shadow', mtmShadowAltError);

  const total = sig.total + mtm.total;
  const errs = sig.errs + mtm.errs;
  const ratio = total > 0 ? errs / total : 0;

  const summary = {
    ts: new Date().toISOString(),
    windowMs: WINDOW_MS,
    signalLab: { path: SIGNAL_PATH, ...sig },
    mtmShadow: { path: MTM_PATH, ...mtm },
    combined: { total, errs, errRatio: +ratio.toFixed(4) },
  };

  console.log(JSON.stringify(summary));

  const alertNeeded =
    total >= MIN_EVENTS && ratio >= MAX_ERR_RATIO && (sig.errs > 0 || mtm.errs > 0);

  if (alertNeeded) {
    const msg =
      `Jupiter shadow errors (HTTP lite-api, не QuickNode)\n` +
      `Окно ${Math.round(WINDOW_MS / 60000)} мин · событий ${total}, ошибок ${errs} (${(ratio * 100).toFixed(1)}%)\n` +
      `signal-lab: ${sig.errs}/${sig.total}\n` +
      `mtm-shadow: ${mtm.errs}/${mtm.total}`;
    await maybeTelegram(msg);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), err: String(e?.message || e) }));
  process.exit(1);
});
