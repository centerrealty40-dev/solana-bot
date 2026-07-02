import { formatUsdCompact, formatUsdPrice } from '../twap/format-telegram.js';
import type { HlOscarPerpConfig } from './config.js';

type OscarTelegramConfig = {
  token: string;
  chatId: string;
};

function loadOscarTelegram(): OscarTelegramConfig | null {
  const token =
    process.env.HL_OSCAR_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.HL_TWAP_LIVE_TRADES_TELEGRAM_BOT_TOKEN?.trim() ||
    '';
  const chatId =
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
  return envBool('HL_OSCAR_TELEGRAM_ENABLED', true);
}

function telegramDryRun(): boolean {
  return envBool('HL_OSCAR_TELEGRAM_DRY_RUN', false);
}

function pnlSign(v: number): string {
  return v >= 0 ? '+' : '';
}

function closeReasonRu(reason: string, cfg?: HlOscarPerpConfig): string {
  if (reason === 'KILL') return `стоп −${cfg?.positionKillDropPct ?? 45}%`;
  if (reason === 'STAGED_KILL') return `стоп −${cfg?.stagedKillDropPct ?? 45}% от сигнала`;
  if (reason === 'TIME_STOP') {
    const h = cfg?.timeStopHours ?? 0;
    return h > 0 ? `тайм-стоп ${h}ч` : 'тайм-стоп';
  }
  if (reason === 'BREAKEVEN') return 'безубыток после trail';
  if (reason === 'TP') return 'take-profit';
  if (reason === 'TRAIL') return 'trail';
  if (reason === 'drawdown_stop') return 'drawdown stop';
  return reason;
}

async function sendOscarTelegram(text: string): Promise<void> {
  if (!telegramEnabled()) return;
  const cfg = loadOscarTelegram();
  if (!cfg) {
    console.warn('[hl-oscar-perp:telegram] not configured (token/chat_id missing)');
    return;
  }
  if (telegramDryRun()) {
    console.log('[hl-oscar-perp:telegram] DRY_RUN:\n', text);
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
        '[hl-oscar-perp:telegram] send failed',
        res.status,
        (await res.text()).slice(0, 200),
      );
    }
  } catch (e) {
    console.warn('[hl-oscar-perp:telegram] send error', String(e));
  }
}

export async function assertOscarTelegramBot(): Promise<void> {
  if (telegramDryRun() || !telegramEnabled()) return;
  const cfg = loadOscarTelegram();
  if (!cfg) return;
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/getMe`);
  const body = (await res.json()) as { ok?: boolean; description?: string };
  if (!body.ok) {
    console.error(
      '[hl-oscar-perp:telegram] Invalid bot token (getMe failed):',
      body.description ?? res.status,
    );
    process.exit(1);
  }
}

function formatTpRungsPct(tpRungs: number[]): string {
  return tpRungs.map((r) => `+${Math.round(r * 1000) / 10}%`).join(' / ');
}

export async function notifyOscarStartup(cfg: HlOscarPerpConfig, mode: string): Promise<void> {
  if (cfg.mode !== 'live') return;
  const impulseLine =
    cfg.dipMinImpulsePct > 0
      ? ` · импульс ≥${cfg.dipMinImpulsePct}%`
      : ' · импульс выкл';
  const vetoLine = [
    cfg.recoveryVetoEnabled ? `recovery veto ≥${cfg.recoveryVetoMaxBouncePct}%` : null,
    cfg.localHighVetoEnabled ? `local-high ≤${cfg.localHighVetoMaxDistancePct}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const entryLine = cfg.stagedEntryEnabled
    ? `Staged: $${cfg.leg1GrossUsd}+$${cfg.leg2GrossUsd}+$${cfg.leg3GrossUsd} @ dip −${Math.abs(cfg.dipMinDropPct)}%${impulseLine} / leg2 −${cfg.leg2DropPct}% / leg3 −${cfg.leg3DropPct}% от сигнала`
    : `Single entry $${cfg.positionNotionalUsd} gross`;
  await sendOscarTelegram(
    [
      '🟢 HL Oscar — бот запущен',
      `Режим: ${mode} · ${cfg.leverage}x · $${cfg.positionNotionalUsd} gross ($${cfg.positionMarginUsd} margin)/позиция`,
      entryLine,
      `TP ${formatTpRungsPct(cfg.tpRungs)} · trail arm +${Math.round(cfg.trailArmFrac * 1000) / 10}% · kill −${cfg.positionKillDropPct}%`,
      `Макс открытых: ${cfg.maxOpenPositions} · тайм-стоп ${cfg.timeStopHours > 0 ? `${cfg.timeStopHours}ч` : 'выкл'}${vetoLine ? ` · ${vetoLine}` : ''}`,
    ].join('\n'),
  );
}

export async function notifyOscarOpen(params: {
  cfg: HlOscarPerpConfig;
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
    params.cfg.dipMinImpulsePct > 0 && impulsePct > 0
      ? ` · импульс +${impulsePct.toFixed(1)}%`
      : '';
  await sendOscarTelegram(
    [
      `🟢 Открыли ${sym} LONG · Oscar dip-buy`,
      `Leg1 ${formatUsdCompact(grossUsd)} @ ${formatUsdPrice(fillPx)}`,
      `Дип ${dipPct.toFixed(1)}%${impLine} · окно ${windowMin}m`,
    ].join('\n'),
  );
}

export async function notifyOscarAddLeg(params: {
  cfg: HlOscarPerpConfig;
  sym: string;
  legIndex: 2 | 3;
  fillPx: number;
  grossUsd: number;
  avgEntryPx: number;
}): Promise<void> {
  if (params.cfg.mode !== 'live') return;
  const { sym, legIndex, fillPx, grossUsd, avgEntryPx } = params;
  await sendOscarTelegram(
    `➕ ${sym} LONG · leg${legIndex} ${formatUsdCompact(grossUsd)} @ ${formatUsdPrice(fillPx)} · avg ${formatUsdPrice(avgEntryPx)}`,
  );
}

export async function notifyOscarPartialExit(params: {
  cfg: HlOscarPerpConfig;
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
  await sendOscarTelegram(
    [
      `${emoji} ${sym} LONG · ${reasonRu}${levelNote}`,
      `Продали ${(fraction * 100).toFixed(0)}% @ ${formatUsdPrice(fillPx)} · PnL ${pnlSign(pnlUsd)}$${pnlUsd.toFixed(2)}`,
      `Остаток ${(remainingFraction * 100).toFixed(0)}%`,
    ].join('\n'),
  );
}

export async function notifyOscarClose(params: {
  cfg: HlOscarPerpConfig;
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
  await sendOscarTelegram(
    [
      `🔴 Закрыли ${sym} LONG · ${reasonRu}`,
      `PnL ${pnlSign(pnlUsd)}$${pnlUsd.toFixed(2)} (${pnlSign(pnlPct)}${pnlPct.toFixed(2)}%) @ ${formatUsdPrice(exitPx)}`,
      `Удержание ${holdHours.toFixed(1)}ч`,
    ].join('\n'),
  );
}

export async function notifyOscarDrawdownHalt(params: {
  peakUsd: number;
  equityUsd: number;
  drawdownUsd: number;
  thresholdUsd: number;
}): Promise<void> {
  const { peakUsd, equityUsd, drawdownUsd, thresholdUsd } = params;
  const stopLevel = peakUsd - thresholdUsd;
  await sendOscarTelegram(
    [
      '🛑 HL Oscar STOP — торговля остановлена',
      `Просадка $${drawdownUsd.toFixed(2)} ≥ $${thresholdUsd.toFixed(0)} (trailing peak)`,
      `Peak $${peakUsd.toFixed(2)} → equity $${equityUsd.toFixed(2)} (stop $${stopLevel.toFixed(2)})`,
      'Новые входы заблокированы до HL_OSCAR_DRAWDOWN_CLEAR_HALT=1 + restart.',
    ].join('\n'),
  );
}

/** Send a one-off test ping (CLI or deploy verification). */
export async function notifyOscarTelegramTest(): Promise<boolean> {
  const cfg = loadOscarTelegram();
  if (!cfg) {
    console.warn('[hl-oscar-perp:telegram] test skipped — not configured');
    return false;
  }
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: '✅ HL Oscar Telegram test — Neural Chain News RU',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.warn('[hl-oscar-perp:telegram] test send failed', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    console.log('[hl-oscar-perp:telegram] test sent');
    return true;
  } catch (e) {
    console.warn('[hl-oscar-perp:telegram] test error', String(e));
    return false;
  }
}
