import type { EvalDecision } from '../discovery/dip-clones.js';

/** Candidate passed pre-holder gates; holder count could not be resolved (warn or block). */
export function shouldNotifyHoldersUnknown(d: EvalDecision): boolean {
  return d.holdersMeta?.holders_unknown_after_cheap_pass === true;
}

export function buildHoldersUnknownTelegramText(args: {
  d: EvalDecision;
  escapeHtml: (s: string) => string;
  mintHrefHtml: (mint: string, label: string) => string;
  fmtUsd: (n: number | null | undefined) => string;
}): string {
  const { d, escapeHtml, mintHrefHtml, fmtUsd } = args;
  const symbol = d.symbol?.trim() || '?';
  const hm = d.holdersMeta;
  const holderReasons = d.reasons.filter((r) => r.startsWith('holders_unknown:'));
  const blocked = !d.pass;
  const statusLine = blocked
    ? `Статус: кандидат прошёл все пороги, кроме одного — <b>не удалось получить количество холдеров</b>.\n` +
      `Покупка <b>заблокирована</b> (holders_on_fail=block).\n`
    : `Статус: холдеры live не получены — <b>покупка разрешена</b> (holders_on_fail=warn).\n`;
  const title = blocked
    ? `<b>Live — пропуск покупки: неизвестно число холдеров</b>\n`
    : `<b>Live — холдеры неизвестны, покупка идёт</b>\n`;
  return (
    title +
    `Монета: <b>${escapeHtml(symbol)}</b>\n` +
    `Адрес: ${mintHrefHtml(d.mint, d.mint)}\n` +
    statusLine +
    `Причина: <code>${escapeHtml(holderReasons.join('; ') || hm?.holders_fail_reason || 'holders_unknown')}</code>\n` +
    `DB holders: <b>${escapeHtml(String(hm?.holders_db ?? 'n/a'))}</b>\n` +
    `Vol1h: <b>${escapeHtml(fmtUsd(d.features.vol1h_usd))}</b>, ` +
    `Vol5m: <b>${escapeHtml(fmtUsd(d.features.vol5m_usd))}</b>\n` +
    `Mcap: <b>${escapeHtml(fmtUsd(d.features.market_cap_usd))}</b>, ` +
    `Liq: <b>${escapeHtml(fmtUsd(d.features.liq_usd))}</b>`
  );
}

/** @deprecated use shouldNotifyHoldersUnknown */
export function shouldNotifyHoldersUnknownBlock(d: EvalDecision): boolean {
  return shouldNotifyHoldersUnknown(d) && !d.pass;
}
