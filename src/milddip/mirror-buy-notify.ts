import { fetch } from 'undici';
import type { MildDipConfig } from './config.js';
import type { MildDipState } from './state.js';
import { appendMildDipJournal, saveMildDipState } from './state.js';

export type MirrorBuyNotifyKind = 'success' | 'attempt';

export function mirrorBuyCompletionSpentUsd(args: {
  positionSizeUsd: number;
  configuredLegs: number;
  filledLegs: number;
  windowExpired?: boolean;
}): number | null {
  const legs = Math.max(1, Math.min(2, Math.floor(args.configuredLegs)));
  if (legs <= 1 || args.filledLegs >= legs || args.windowExpired === true) {
    return args.positionSizeUsd;
  }
  return null;
}

function isUsableSymbol(symbol: string | null | undefined): symbol is string {
  const normalized = symbol?.trim().toLowerCase() ?? '';
  return normalized !== '' && !['unknown', '?', 'n/a'].includes(normalized);
}

export function mirrorBuyShortMint(mint: string): string {
  return `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

export function resolveMirrorBuySymbol(
  symbol: string | null | undefined,
  fallbackSymbol: string | null | undefined,
  mint: string,
): string {
  if (isUsableSymbol(symbol)) return symbol.trim();
  if (isUsableSymbol(fallbackSymbol)) return fallbackSymbol.trim();
  return mirrorBuyShortMint(mint);
}

function displayName(
  symbol: string | null | undefined,
  fallbackSymbol: string | null | undefined,
  mint: string,
): string {
  return resolveMirrorBuySymbol(symbol, fallbackSymbol, mint);
}

export function mirrorBuyGmgnUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint)}`;
}

export function formatMirrorBuySuccess(args: {
  mint: string;
  symbol?: string | null;
  fallbackSymbol?: string | null;
  spentUsd: number;
}): string {
  return `Купил ${displayName(args.symbol, args.fallbackSymbol, args.mint)} на $${args.spentUsd.toFixed(2)}\n` +
    `<a href="${mirrorBuyGmgnUrl(args.mint)}">GMGN</a>\n` +
    `<code>${args.mint}</code>`;
}

export function formatMirrorBuyAttempt(args: {
  mint: string;
  symbol?: string | null;
  fallbackSymbol?: string | null;
  reason: string;
}): string {
  return `Была попытка купить ${displayName(args.symbol, args.fallbackSymbol, args.mint)} — ${args.reason}\n` +
    `<a href="${mirrorBuyGmgnUrl(args.mint)}">GMGN</a>\n` +
    `<code>${args.mint}</code>`;
}

export async function sendMirrorBuyNotification(args: {
  token: string;
  chatId: string;
  text: string;
}): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${args.token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: args.chatId,
        text: args.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`telegram_send_failed:${response.status}`);
  }
}

export async function notifyMirrorBuyAttemptOnce(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  mint: string;
  symbol?: string | null;
  reason: string;
}): Promise<void> {
  if (!args.cfg.leaderMirror.notifyBuyEnabled) return;
  const marks = (args.state.mirrorBuyNotify ??= {});
  const mark = (marks[args.mint] ??= {});
  if (mark.attemptAtMs != null) return;
  const nowMs = Date.now();
  const pending = mark.attemptPending;
  mark.attemptPending = {
    firstFailAtMs: pending?.firstFailAtMs ?? nowMs,
    lastFailAtMs: nowMs,
    reason: args.reason,
    symbol: args.symbol ?? null,
  };
  saveMildDipState(args.cfg.statePath, args.state);
}

async function sendMirrorBuyAttempt(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  mint: string;
  symbol?: string | null;
  reason: string;
}): Promise<void> {
  const fallbackSymbol = args.state.open[args.mint]?.symbol;
  const token =
    args.cfg.leaderMirror.notifyBotToken.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    '';
  const chat =
    args.cfg.leaderMirror.notifyChatId.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    '';
  if (!token || !chat) {
    appendMildDipJournal(args.cfg.journalPath, {
      kind: 'mirror_buy_notify_skipped',
      mint: args.mint,
      symbol: resolveMirrorBuySymbol(args.symbol, fallbackSymbol, args.mint),
      notification: 'attempt',
      reason: 'missing_telegram_config',
    });
    return;
  }
  try {
    await sendMirrorBuyNotification({
      token,
      chatId: chat,
      text: formatMirrorBuyAttempt({
        ...args,
        fallbackSymbol,
      }),
    });
  } catch (err) {
    appendMildDipJournal(args.cfg.journalPath, {
      kind: 'mirror_buy_notify_error',
      mint: args.mint,
      symbol: resolveMirrorBuySymbol(args.symbol, fallbackSymbol, args.mint),
      notification: 'attempt',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function flushMirrorBuyAttemptNotifications(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  nowMs: number;
}): Promise<void> {
  if (!args.cfg.leaderMirror.notifyBuyEnabled) return;
  const marks = args.state.mirrorBuyNotify;
  if (!marks) return;
  for (const [mint, mark] of Object.entries(marks)) {
    const pending = mark.attemptPending;
    if (!pending) continue;
    if (mark.buyAtMs != null || args.state.open[mint]) {
      delete mark.attemptPending;
      appendMildDipJournal(args.cfg.journalPath, {
        kind: 'mirror_buy_attempt_notify_dropped',
        mint,
        reason: 'bought',
      });
      saveMildDipState(args.cfg.statePath, args.state);
      continue;
    }
    if (
      args.nowMs - pending.firstFailAtMs <
      args.cfg.leaderMirror.notifyAttemptDelayMs
    ) {
      continue;
    }
    delete mark.attemptPending;
    mark.attemptAtMs ??= args.nowMs;
    saveMildDipState(args.cfg.statePath, args.state);
    await sendMirrorBuyAttempt({
      cfg: args.cfg,
      state: args.state,
      mint,
      symbol: pending.symbol,
      reason: pending.reason,
    });
  }
}

export async function notifyMirrorBuySuccessOnce(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  mint: string;
  symbol?: string | null;
  spentUsd: number;
}): Promise<void> {
  if (!args.cfg.leaderMirror.notifyBuyEnabled) return;
  const marks = (args.state.mirrorBuyNotify ??= {});
  const mark = (marks[args.mint] ??= {});
  if (mark.buyAtMs != null) return;
  mark.buyAtMs = Date.now();
  saveMildDipState(args.cfg.statePath, args.state);
  const fallbackSymbol = args.state.open[args.mint]?.symbol;
  const token =
    args.cfg.leaderMirror.notifyBotToken.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    '';
  const chat =
    args.cfg.leaderMirror.notifyChatId.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    '';
  if (!token || !chat) {
    appendMildDipJournal(args.cfg.journalPath, {
      kind: 'mirror_buy_notify_skipped',
      mint: args.mint,
      symbol: resolveMirrorBuySymbol(args.symbol, fallbackSymbol, args.mint),
      notification: 'success',
      reason: 'missing_telegram_config',
    });
    return;
  }
  try {
    await sendMirrorBuyNotification({
      token,
      chatId: chat,
      text: formatMirrorBuySuccess({
        ...args,
        fallbackSymbol,
      }),
    });
  } catch (err) {
    appendMildDipJournal(args.cfg.journalPath, {
      kind: 'mirror_buy_notify_error',
      mint: args.mint,
      symbol: resolveMirrorBuySymbol(args.symbol, fallbackSymbol, args.mint),
      notification: 'success',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
