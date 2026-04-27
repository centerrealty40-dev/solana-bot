/**
 * Единый Telegram-sender с тегами `[CATEGORY][SUBTAG]`, cooldown по тегу и
 * тихими часами для не-`ALERT` категорий.
 *
 * Категории: HEALTH | REPORT | ADVICE | ALERT.
 *   HEALTH/REPORT/ADVICE подчиняются TELEGRAM_QUIET_FROM..TO (часы UTC).
 *   ALERT всегда проходит.
 *
 * Cooldown: env `TELEGRAM_COOLDOWN_<CATEGORY>_<SUBTAG>_MS` (uppercase, dot→_) — ms.
 *   Пример: TELEGRAM_COOLDOWN_REPORT_STRATEGIES_MS=3600000
 *   Состояние: data/telegram-cooldown.json
 *
 * Чанкинг: > 3800 символов → разбивка по `\n`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { child } from '../logger.js';

const log = child('telegram-sender');

export type TelegramCategory = 'HEALTH' | 'REPORT' | 'ADVICE' | 'ALERT';

interface CooldownState {
  [tagKey: string]: number;
}

function statePath(): string {
  return process.env.TELEGRAM_COOLDOWN_PATH || path.join('data', 'telegram-cooldown.json');
}

function readState(): CooldownState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as CooldownState;
  } catch {
    return {};
  }
}

function writeState(s: CooldownState): void {
  const p = statePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function inQuietHours(): boolean {
  const from = Number(process.env.TELEGRAM_QUIET_FROM ?? -1);
  const to = Number(process.env.TELEGRAM_QUIET_TO ?? -1);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return false;
  const h = new Date().getUTCHours();
  if (from === to) return false;
  if (from < to) return h >= from && h < to;
  return h >= from || h < to;
}

function cooldownMs(category: TelegramCategory, subtag: string): number {
  const key = `TELEGRAM_COOLDOWN_${category}_${subtag.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MS`;
  const v = Number(process.env[key] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function chunk(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
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

interface SendOpts {
  parseMode?: 'Markdown' | 'HTML';
  disablePreview?: boolean;
}

/**
 * Отправить сообщение с тегом. Возвращает `true` если хотя бы один чанк ушёл.
 */
export async function sendTagged(
  category: TelegramCategory,
  subtag: string,
  text: string,
  opts: SendOpts = {},
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    log.warn('TELEGRAM_BOT_TOKEN/CHAT_ID missing; sendTagged skipped');
    return false;
  }
  const tag = `[${category}][${subtag}]`;
  const tagKey = `${category}.${subtag}`.toLowerCase();

  if (category !== 'ALERT' && inQuietHours()) {
    log.debug({ tag }, 'suppressed by quiet hours');
    return false;
  }

  const cd = cooldownMs(category, subtag);
  if (cd > 0) {
    const st = readState();
    const last = st[tagKey] ?? 0;
    if (Date.now() - last < cd) {
      log.debug({ tag, cd }, 'suppressed by cooldown');
      return false;
    }
    st[tagKey] = Date.now();
    writeState(st);
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const fullText = `${tag} ${text}`;
  const parts = chunk(fullText);
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
      else log.warn({ status: r.status }, 'telegram non-2xx');
      await new Promise((res) => setTimeout(res, 150));
    } catch (e) {
      log.warn({ err: String(e) }, 'telegram send failed');
    }
  }
  return ok;
}
