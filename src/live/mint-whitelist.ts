/**
 * Live Oscar — mint allowlist file (one base58 mint per line, `#` comments).
 * Reloads when mtime changes.
 *
 * При ручном удалении mint из whitelist добавьте его в постоянный denylist
 * (`live-oscar-permanent-denylist.seed.txt` в Git или локальный `…denylist.txt` на VPS),
 * иначе только автоматическое удаление по consec-loss допишет локальный denylist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sendTagged, type TelegramCategory } from '../core/telegram/sender.js';
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import {
  appendMintToPermanentDenylistLocal,
} from './mint-permanent-denylist.js';
import { isLiveBuyDiscoveryTelegramSuppressed } from './wallet-buy-affordability.js';

const log = child('live-mint-whitelist');

/** Карточка токена на gmgn.ai (Solana). Отдельной строкой в тексте — клиент Telegram делает URL кликабельным без parse_mode. */
function gmgnSolTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint.trim())}`;
}

function fmtMcUsdPlain(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function whitelistAlertTextMiss(sym: string, mint: string, marketCapUsd: number | null | undefined): string {
  const url = gmgnSolTokenUrl(mint);
  const mc = fmtMcUsdPlain(marketCapUsd);
  return (
    `Кандидат прошёл гейты, но mint не в whitelist — покупка пропущена.\n` +
    `symbol: ${sym}\n` +
    `mint: ${mint}\n` +
    `market_cap (snapshot): ${mc}\n` +
    `GMGN: ${url}`
  );
}

function whitelistAlertTextDrop(sym: string, mint: string, threshold: number): string {
  const url = gmgnSolTokenUrl(mint);
  return (
    `Монета удалена из whitelist после ${threshold} подряд убыточных сделок (live).\n` +
    `symbol: ${sym}\n` +
    `mint: ${mint}\n` +
    `GMGN: ${url}`
  );
}

let cachedAbsPath = '';
let cachedMtimeMs = 0;
let cachedSet = new Set<string>();

const lastTelegramByMint = new Map<string, number>();
/** Сериализует параллельные вызовы по одному mint, пока `sendTagged` в полёте (иначе два тика — два TG). */
const inFlightWhitelistMissByMint = new Set<string>();

function whitelistSkipTelegramCategory(): TelegramCategory {
  const s = process.env.LIVE_MINT_WHITELIST_TELEGRAM_CATEGORY?.trim().toUpperCase();
  if (s === 'ALERT' || s === 'REPORT' || s === 'ADVICE' || s === 'HEALTH') return s;
  return 'ADVICE';
}

/** Отдельный бот/чат только для `live_whitelist_miss` и `live_whitelist_consec_loss_drop`. Chat по умолчанию — `TELEGRAM_CHAT_ID`. */
function whitelistAlertsTelegramOpts(): {
  telegramBotToken?: string;
  telegramChatId?: string;
  skipQuietHours: boolean;
} {
  const telegramBotToken = process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim();
  const o: {
    telegramBotToken?: string;
    telegramChatId?: string;
    skipQuietHours: boolean;
  } = { skipQuietHours: true };
  if (telegramBotToken) o.telegramBotToken = telegramBotToken;
  if (telegramChatId) o.telegramChatId = telegramChatId;
  return o;
}

export function resolveLiveMintWhitelistPath(raw: string): string {
  const t = raw.trim();
  if (!t) return path.resolve(process.cwd(), 'data/live/live-oscar-mint-whitelist.txt');
  return path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
}

function parseWhitelistBody(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const cut = line.split('#')[0]?.trim();
    if (!cut) continue;
    out.add(cut);
  }
  return out;
}

/** Cleared in tests if needed. */
export function clearLiveMintWhitelistCache(): void {
  cachedAbsPath = '';
  cachedMtimeMs = 0;
  cachedSet = new Set();
  lastTelegramByMint.clear();
  inFlightWhitelistMissByMint.clear();
}

export function loadLiveMintWhitelistSet(absPath: string): Set<string> {
  const st = fs.statSync(absPath);
  if (cachedAbsPath === absPath && cachedMtimeMs === st.mtimeMs) return cachedSet;
  const body = fs.readFileSync(absPath, 'utf8');
  cachedAbsPath = absPath;
  cachedMtimeMs = st.mtimeMs;
  cachedSet = parseWhitelistBody(body);
  log.info({ path: absPath, count: cachedSet.size }, 'live mint whitelist loaded');
  return cachedSet;
}

export function isMintOnLiveWhitelist(relOrAbsPath: string, mint: string): boolean {
  const abs = resolveLiveMintWhitelistPath(relOrAbsPath);
  const set = loadLiveMintWhitelistSet(abs);
  return set.has(mint.trim());
}

export function notifyLiveMintWhitelistSkip(
  symbol: string,
  mint: string,
  cooldownMs: number,
  marketCapUsd?: number | null,
): void {
  if (isLiveBuyDiscoveryTelegramSuppressed()) return;
  const key = mint.trim();
  if (!key) return;
  const sym = symbol.trim() || '?';
  void (async () => {
    const now = Date.now();
    if (cooldownMs > 0) {
      const last = lastTelegramByMint.get(key) ?? 0;
      if (now - last < cooldownMs) return;
      if (inFlightWhitelistMissByMint.has(key)) return;
      inFlightWhitelistMissByMint.add(key);
    }
    try {
      const ok = await sendTagged(
        whitelistSkipTelegramCategory(),
        'live_whitelist_miss',
        whitelistAlertTextMiss(sym, key, marketCapUsd),
        whitelistAlertsTelegramOpts(),
      );
      log.info({ mint: key, symbol: sym, ok }, 'live_whitelist_miss telegram');
      if (cooldownMs > 0 && ok) lastTelegramByMint.set(key, Date.now());
    } catch (e) {
      log.warn({ err: String(e), mint: key }, 'live_whitelist_miss telegram failed');
    } finally {
      if (cooldownMs > 0) inFlightWhitelistMissByMint.delete(key);
    }
  })().catch((e) => log.warn({ err: String(e), mint: key }, 'live_whitelist_miss telegram failed'));
}

/** Сколько подряд убыточных **полных** закрытий live по mint → удаление из whitelist. `0` = выкл. */
function consecLossRemoveThreshold(): number {
  const s = process.env.LIVE_MINT_WHITELIST_REMOVE_AFTER_CONSEC_LOSSES?.trim();
  if (s === '0' || s === '') return 0;
  if (s == null || s === undefined) return 2;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : 2;
}

function whitelistConsecLossStreakPath(): string {
  const raw = process.env.LIVE_MINT_WHITELIST_LOSS_STREAK_PATH?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return path.resolve(process.cwd(), 'data/live/live-oscar-whitelist-consec-loss.json');
}

function readConsecLossStreaks(): Record<string, number> {
  const p = whitelistConsecLossStreakPath();
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { streaks?: unknown };
    const st = j.streaks;
    if (!st || typeof st !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(st)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k.trim()] = Math.floor(n);
    }
    return out;
  } catch {
    return {};
  }
}

function writeConsecLossStreaks(streaks: Record<string, number>): void {
  const p = whitelistConsecLossStreakPath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ streaks }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

/** Удалить строку с mint из файла whitelist (комментарии на строке сохраняются для остальных). */
function removeMintLinesFromWhitelistFile(absWhitelistPath: string, mint: string): boolean {
  const key = mint.trim();
  if (!key || !fs.existsSync(absWhitelistPath)) return false;
  const body = fs.readFileSync(absWhitelistPath, 'utf8');
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let removed = false;
  for (const line of lines) {
    const cut = line.split('#')[0]?.trim() ?? '';
    if (cut === key) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (!removed) return false;
  const newBody = out.join('\n').replace(/\n*$/, '\n');
  const tmp = `${absWhitelistPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, newBody, 'utf8');
  fs.renameSync(tmp, absWhitelistPath);
  clearLiveMintWhitelistCache();
  log.info({ path: absWhitelistPath, mint: key }, 'live mint removed from whitelist file (consec losses)');
  return true;
}

function whitelistDropTelegramCategory(): TelegramCategory {
  const s = process.env.LIVE_MINT_WHITELIST_DROP_TELEGRAM_CATEGORY?.trim().toUpperCase();
  if (s === 'ALERT' || s === 'REPORT' || s === 'ADVICE' || s === 'HEALTH') return s;
  return 'ALERT';
}

/**
 * После полного закрытия live-oscar: учёт подряд убыточных сделок по mint в whitelist;
 * при достижении порога — удаление mint из файла и Telegram.
 */
export function onLiveOscarFullCloseUpdateWhitelistLossStreak(args: {
  liveOscarCfg: LiveOscarConfig | undefined;
  strategyId: string;
  mint: string;
  symbol: string;
  netPnlUsd: number;
}): void {
  const { liveOscarCfg, strategyId, mint, symbol, netPnlUsd } = args;
  const key = mint.trim();
  if (!key || !liveOscarCfg) return;
  if (strategyId !== 'live-oscar' || liveOscarCfg.executionMode !== 'live') return;
  if (!liveOscarCfg.liveMintWhitelistEnabled) return;

  const threshold = consecLossRemoveThreshold();
  if (threshold < 1) return;

  const wlPath = resolveLiveMintWhitelistPath(liveOscarCfg.liveMintWhitelistPath);
  if (!isMintOnLiveWhitelist(liveOscarCfg.liveMintWhitelistPath, key)) {
    const streaks = readConsecLossStreaks();
    if (streaks[key] != null) {
      delete streaks[key];
      writeConsecLossStreaks(streaks);
    }
    return;
  }

  const streaks = readConsecLossStreaks();
  const prev = streaks[key] ?? 0;

  if (!(netPnlUsd < 0)) {
    streaks[key] = 0;
    writeConsecLossStreaks(streaks);
    return;
  }

  const next = prev + 1;
  streaks[key] = next;
  writeConsecLossStreaks(streaks);

  if (next < threshold) {
    log.info({ mint: key, streak: next, threshold }, 'live whitelist consec loss streak');
    return;
  }

  const sym = symbol?.trim() || '?';
  const removed = removeMintLinesFromWhitelistFile(wlPath, key);
  delete streaks[key];
  writeConsecLossStreaks(streaks);

  if (removed) {
    appendMintToPermanentDenylistLocal(liveOscarCfg, key, 'whitelist_consec_loss', { symbol: sym });
  }

  if (!removed) {
    log.warn({ mint: key }, 'live whitelist consec loss threshold reached but mint not in file');
    return;
  }

  void (async () => {
    const ok = await sendTagged(
      whitelistDropTelegramCategory(),
      'live_whitelist_consec_loss_drop',
      whitelistAlertTextDrop(sym, key, threshold),
      whitelistAlertsTelegramOpts(),
    );
    log.info({ mint: key, symbol: sym, ok }, 'live_whitelist_consec_loss_drop telegram');
  })().catch((e) => log.warn({ err: String(e), mint: key }, 'live_whitelist_consec_loss_drop telegram failed'));
}

/** Denylist only when net PnL ≤ −this USD (e.g. −$151). Smaller losses keep trading. Env: `LIVE_NEGATIVE_TRADE_DENY_MIN_LOSS_USD`. */
export function negativeTradeDenyMinLossUsd(): number {
  const s = process.env.LIVE_NEGATIVE_TRADE_DENY_MIN_LOSS_USD?.trim();
  if (s == null || s === '') return 150;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 150;
}

function negativeTradeDenyTelegramEnabled(): boolean {
  const s = process.env.LIVE_NEGATIVE_TRADE_DENY_TELEGRAM_ENABLED?.trim();
  if (s === '0' || s === 'false') return false;
  return true;
}

/**
 * После убыточного полного закрытия live-oscar с net PnL ≤ −`negativeTradeDenyMinLossUsd()` (дефолт $150):
 * mint в локальный permanent denylist (не зависит от whitelist). Telegram — перед записью в файл.
 */
export function onLiveOscarFullCloseNegativeTradeDenylist(args: {
  liveOscarCfg: LiveOscarConfig | undefined;
  strategyId: string;
  mint: string;
  symbol: string;
  netPnlUsd: number;
}): void {
  const { liveOscarCfg, strategyId, mint, symbol, netPnlUsd } = args;
  const key = mint.trim();
  if (!key || !liveOscarCfg) return;
  if (strategyId !== 'live-oscar' || liveOscarCfg.executionMode !== 'live') return;
  if (!liveOscarCfg.liveNegativeTradeDenyEnabled) {
    log.debug({ mint: key, netPnlUsd }, 'live negative trade denylist disabled (stub preserved)');
    return;
  }
  const minLossUsd = negativeTradeDenyMinLossUsd();
  if (!(netPnlUsd < 0) || netPnlUsd > -minLossUsd) {
    if (netPnlUsd < 0) {
      log.info(
        { mint: key, netPnlUsd, minLossUsd },
        'live negative trade denylist: loss below threshold, keep trading',
      );
    }
    return;
  }

  const sym = symbol?.trim() || '?';
  const added = appendMintToPermanentDenylistLocal(
    liveOscarCfg,
    key,
    `negative_trade net=${netPnlUsd.toFixed(2)}`,
    { symbol: sym, skipListChangeTelegram: !negativeTradeDenyTelegramEnabled() },
  );
  if (!added) {
    log.info({ mint: key }, 'live negative trade denylist: already listed');
  }
}

/** Только для тестов / ручного сброса счётчиков. */
export function clearWhitelistConsecutiveLossStreaksForTests(): void {
  try {
    fs.unlinkSync(whitelistConsecLossStreakPath());
  } catch {
    /* noop */
  }
}
