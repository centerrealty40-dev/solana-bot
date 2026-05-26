/**
 * Зеркало `src/core/telegram/sender.ts` для .mjs / .cjs скриптов.
 * Те же теги, тихие часы, cooldown, общий state-файл.
 */
import fs from 'node:fs';
import path from 'node:path';

const OPERATOR_TELEGRAM_CHAT_ID = '-1003878024799';

function resolveOperatorChatId(explicit) {
  return (
    explicit?.trim() ||
    process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    OPERATOR_TELEGRAM_CHAT_ID
  );
}

function resolveOperatorBotToken() {
  const chat = resolveOperatorChatId();
  const wl = process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim();
  const main = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (chat === OPERATOR_TELEGRAM_CHAT_ID || chat === process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim()) {
    return wl || main || '';
  }
  return main || wl || '';
}

function statePath() {
  return process.env.TELEGRAM_COOLDOWN_PATH || path.join('data', 'telegram-cooldown.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(s) {
  const p = statePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function inQuietHours() {
  const from = Number(process.env.TELEGRAM_QUIET_FROM ?? -1);
  const to = Number(process.env.TELEGRAM_QUIET_TO ?? -1);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return false;
  const h = new Date().getUTCHours();
  if (from === to) return false;
  if (from < to) return h >= from && h < to;
  return h >= from || h < to;
}

function cooldownMs(category, subtag) {
  const key = `TELEGRAM_COOLDOWN_${category}_${String(subtag).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MS`;
  const v = Number(process.env[key] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function chunk(text, max = 3800) {
  if (text.length <= max) return [text];
  const out = [];
  let s = text;
  while (s.length > max) {
    const idx = s.lastIndexOf('\n', max);
    const at = idx > 500 ? idx : max;
    out.push(s.slice(0, at));
    s = s.slice(at).trimStart();
  }
  if (s) out.push(s);
  return out;
}

export async function sendTagged(category, subtag, text, opts = {}) {
  const token = opts.telegramBotToken?.trim() || resolveOperatorBotToken();
  const chat = opts.telegramChatId?.trim() || resolveOperatorChatId();
  if (!token || !chat) return false;
  const tag = `[${category}][${subtag}]`;
  const tagKey = `${category}.${subtag}`.toLowerCase();

  if (category !== 'ALERT' && inQuietHours()) return false;

  const cd = cooldownMs(category, subtag);
  if (cd > 0) {
    const st = readState();
    const last = st[tagKey] ?? 0;
    if (Date.now() - last < cd) return false;
    st[tagKey] = Date.now();
    writeState(st);
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const parts = chunk(`${tag} ${text}`);
  let ok = false;
  for (const p of parts) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text: p,
          parse_mode: opts.parseMode,
          disable_web_page_preview: opts.disablePreview ?? true,
        }),
      });
      if (r.ok) ok = true;
      await new Promise((res) => setTimeout(res, 150));
    } catch {
      /* ignore */
    }
  }
  return ok;
}
