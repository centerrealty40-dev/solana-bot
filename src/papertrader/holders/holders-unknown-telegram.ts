import type { EvalDecision } from '../discovery/dip-clones.js';

/** Candidate passed all pre-holder gates but buy was skipped because holder count is unknown. */
export function shouldNotifyHoldersUnknownBlock(d: EvalDecision): boolean {
  if (d.pass) return false;
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
  return (
    `<b>Live — пропуск покупки: неизвестно число холдеров</b>\n` +
    `Монета: <b>${escapeHtml(symbol)}</b>\n` +
    `Адрес: ${mintHrefHtml(d.mint, d.mint)}\n` +
    `Статус: кандидат прошёл все пороги, кроме одного — <b>не удалось получить количество холдеров</b>.\n` +
    `Покупка заблокирована (holders_on_fail=block).\n` +
    `Причина: <code>${escapeHtml(holderReasons.join('; ') || hm?.holders_fail_reason || 'holders_unknown')}</code>\n` +
    `DB holders: <b>${escapeHtml(String(hm?.holders_db ?? 'n/a'))}</b>\n` +
    `Vol1h: <b>${escapeHtml(fmtUsd(d.features.vol1h_usd))}</b>, ` +
    `Vol5m: <b>${escapeHtml(fmtUsd(d.features.vol5m_usd))}</b>\n` +
    `Mcap: <b>${escapeHtml(fmtUsd(d.features.market_cap_usd))}</b>, ` +
    `Liq: <b>${escapeHtml(fmtUsd(d.features.liq_usd))}</b>`
  );
}
