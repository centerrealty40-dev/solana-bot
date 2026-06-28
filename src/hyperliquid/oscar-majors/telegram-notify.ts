import { formatUsdCompact, formatUsdPrice } from '../twap/format-telegram.js';
import type { HlOscarMajorsConfig } from './config.js';

type MajorsTelegramConfig = {
  token: string;
  chatId: string;
};

function loadMajorsTelegram(): MajorsTelegramConfig | null {
  const token =
    process.env.HL_MAJORS_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.HL_OSCAR_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.HL_TWAP_LIVE_TRADES_TELEGRAM_BOT_TOKEN?.trim() ||
    '';
  const chatId =
    process.env.HL_MAJORS_TELEGRAM_CHAT_ID?.trim() ||
    process.env.HL_OSCAR_TELEGRAM_CHAT_ID?.trim() ||
    process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim() ||
    process.env.HL_TWAP_LIVE_TRADES_TELEGRAM_CHAT_ID?.trim() ||
    '';
  if (!token || !chatId) return null;
  return { token, chatId };
}

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function telegramEnabled(): boolean {
  return envBool('HL_MAJORS_TELEGRAM_ENABLED', true);
}

function telegramDryRun(): boolean {
  return envBool('HL_MAJORS_TELEGRAM_DRY_RUN', false);
}

function pnlSign(v: number): string {
  return v >= 0 ? '+' : '';
}

function closeReasonRu(reason: string, cfg?: HlOscarMajorsConfig): string {
  if (reason === 'KILL') return `стоп −${cfg?.positionKillDropPct ?? 15}%`;
  if (reason === 'STAGED_KILL') return `стоп −${cfg?.stagedKillDropPct ?? 10}% от сигнала`;
  if (reason === 'TIME_STOP') return 'тайм-стоп 12ч';
  if (reason === 'BREAKEVEN') return 'безубыток после trail';
  if (reason === 'TP') return 'take-profit';
  if (reason === 'TRAIL') return 'trail';
  if (reason === 'drawdown_stop') return 'drawdown stop';
  return reason;
}

async function sendMajorsTelegram(text: string): Promise<void> {
  if (!telegramEnabled()) return;
  const cfg = loadMajorsTelegram();
  if (!cfg) {
    console.warn('[hl-oscar-majors:telegram] not configured (token/chat_id missing)');
    return;
  }
  if (telegramDryRun()) {
    console.log('[hl-oscar-majors:telegram] DRY_RUN:\n', text);
    return;
  }
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.warn(
        '[hl-oscar-majors:telegram] send failed',
        res.status,
        (await res.text()).slice(0, 200),
      );
    }
  } catch (e) {
    console.warn('[hl-oscar-majors:telegram] send error', String(e));
  }
}

export async function assertMajorsTelegramBot(): Promise<void> {
  if (telegramDryRun() || !telegramEnabled()) return;
  const cfg = loadMajorsTelegram();
  if (!cfg) return;
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/getMe`);
  const body = (await res.json()) as { ok?: boolean; description?: string };
  if (!body.ok) {
    console.error(
      '[hl-oscar-majors:telegram] Invalid bot token (getMe failed):',
      body.description ?? res.status,
    );
    process.exit(1);
  }
}

export async function notifyMajorsStartup(cfg: HlOscarMajorsConfig, mode: string): Promise<void> {
  if (cfg.mode !== 'live') return;
  const entryLine = cfg.stagedEntryEnabled
    ? `Staged: $${cfg.leg1GrossUsd}+$${cfg.leg2GrossUsd}+$${cfg.leg3GrossUsd} @ dip −${Math.abs(cfg.dipMinDropPct)}%`
    : `Single entry $${cfg.positionNotionalUsd} gross · Mode A knife`;
  await sendMajorsTelegram(
    [
      '🟢 HL Oscar Majors — бот запущен',
      `Режим: ${mode} · ${cfg.leverage}x · $${cfg.positionNotionalUsd} gross ($${cfg.positionMarginUsd} margin)/позиция`,
      entryLine,
      `Whitelist: ${cfg.whitelist.join(',')} · макс открытых ${cfg.maxOpenPositions} · тайм-стоп ${cfg.timeStopHours}ч`,
    ].join('\n'),
  );
}

export async function notifyMajorsOpen(params: {
  cfg: HlOscarMajorsConfig;
  sym: string;
  legIndex: 1;
  fillPx: number;
  grossUsd: number;
  dipPct: number;
  impulsePct: number;
  windowMin: number;
}): Promise<void> {
  if (params.cfg.mode !== 'live') return;
  const { sym, fillPx, grossUsd, dipPct, impulsePct, windowMin } = params;
  const impLine =
    impulsePct > 0 ? ` · импульс +${impulsePct.toFixed(1)}%` : '';
  await sendMajorsTelegram(
    [
      `🟢 Открыли ${sym} LONG · Oscar Majors knife`,
      `Leg1 ${formatUsdCompact(grossUsd)} @ ${formatUsdPrice(fillPx)}`,
      `Дип ${dipPct.toFixed(1)}%${impLine} · окно ${windowMin}m`,
    ].join('\n'),
  );
}

export async function notifyMajorsAddLeg(params: {
  cfg: HlOscarMajorsConfig;
  sym: string;
  legIndex: 2 | 3;
  fillPx: number;
  grossUsd: number;
  avgEntryPx: number;
}): Promise<void> {
  if (params.cfg.mode !== 'live') return;
  const { sym, legIndex, fillPx, grossUsd, avgEntryPx } = params;
  await sendMajorsTelegram(
    `➕ ${sym} LONG · leg${legIndex} ${formatUsdCompact(grossUsd)} @ ${formatUsdPrice(fillPx)} · avg ${formatUsdPrice(avgEntryPx)}`,
  );
}

export async function notifyMajorsPartialExit(params: {
  cfg: HlOscarMajorsConfig;
  sym: string;
  reason: string;
  fillPx: number;
  pnlUsd: number;
  fraction: number;
  remainingFraction: number;
  level?: number;
}): Promise<void> {
  if (params.cfg.mode !== 'live') return;
  const { sym, reason, fillPx, pnlUsd, fraction, remainingFraction, level } = params;
  const reasonRu = closeReasonRu(reason, params.cfg);
  const levelNote = level != null ? ` · rung ${level}` : '';
  const emoji = reason === 'TRAIL' ? '📉' : '💰';
  await sendMajorsTelegram(
    [
      `${emoji} ${sym} LONG · ${reasonRu}${levelNote}`,
      `Продали ${(fraction * 100).toFixed(0)}% @ ${formatUsdPrice(fillPx)} · PnL ${pnlSign(pnlUsd)}$${pnlUsd.toFixed(2)}`,
      `Остаток ${(remainingFraction * 100).toFixed(0)}%`,
    ].join('\n'),
  );
}

export async function notifyMajorsClose(params: {
  cfg: HlOscarMajorsConfig;
  sym: string;
  reason: string;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  holdHours: number;
}): Promise<void> {
  if (params.cfg.mode !== 'live') return;
  const { sym, reason, exitPx, pnlUsd, pnlPct, holdHours } = params;
  const reasonRu = closeReasonRu(reason, params.cfg);
  await sendMajorsTelegram(
    [
      `🔴 Закрыли ${sym} LONG · ${reasonRu}`,
      `PnL ${pnlSign(pnlUsd)}$${pnlUsd.toFixed(2)} (${pnlSign(pnlPct)}${pnlPct.toFixed(2)}%) @ ${formatUsdPrice(exitPx)}`,
      `Удержание ${holdHours.toFixed(1)}ч`,
    ].join('\n'),
  );
}

export async function notifyMajorsDrawdownHalt(params: {
  peakUsd: number;
  equityUsd: number;
  drawdownUsd: number;
  thresholdUsd: number;
}): Promise<void> {
  const { peakUsd, equityUsd, drawdownUsd, thresholdUsd } = params;
  const stopLevel = peakUsd - thresholdUsd;
  await sendMajorsTelegram(
    [
      '🛑 HL Oscar Majors STOP — торговля остановлена',
      `Просадка $${drawdownUsd.toFixed(2)} ≥ $${thresholdUsd.toFixed(0)} (trailing peak)`,
      `Peak $${peakUsd.toFixed(2)} → equity $${equityUsd.toFixed(2)} (stop $${stopLevel.toFixed(2)})`,
      'Новые входы заблокированы до HL_MAJORS_DRAWDOWN_CLEAR_HALT=1 + restart.',
    ].join('\n'),
  );
}

export async function notifyMajorsTelegramTest(): Promise<boolean> {
  const cfg = loadMajorsTelegram();
  if (!cfg) {
    console.warn('[hl-oscar-majors:telegram] test skipped — not configured');
    return false;
  }
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: '✅ HL Oscar Majors Telegram test — Neural Chain News RU',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.warn('[hl-oscar-majors:telegram] test send failed', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    console.log('[hl-oscar-majors:telegram] test sent');
    return true;
  } catch (e) {
    console.warn('[hl-oscar-majors:telegram] test error', String(e));
    return false;
  }
}
