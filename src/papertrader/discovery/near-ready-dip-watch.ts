/**
 * Классификация mint после discovery: «качество/ликвидность/холдеры ок, но нет подходящего дипа»
 * — чтобы показывать в heartbeat Telegram без шума cand/eval/gate_skip.
 */

function gmgnSolTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint.trim())}`;
}

/** Жёсткий отсев по причине — не «ждём дип», а проблема качества/риска/кулдауна. */
function isHardQualityOrRiskBlock(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.startsWith('liq<') ||
    r.startsWith('vol5m<') ||
    r.startsWith('buys5m<') ||
    r.startsWith('sells5m<') ||
    r.startsWith('bs<') ||
    r.includes('vol1h') ||
    r.includes('vol5m_spike') ||
    r.startsWith('token_age<') ||
    r.includes('holders<') ||
    r.includes('holders_unknown') ||
    r.includes('creator_dump') ||
    r.includes('dca_aggressive') ||
    r.includes('no_whale_trigger') ||
    r.includes('cooldown') ||
    r.includes('post_exit') ||
    r.includes('reentry_price') ||
    r.includes('budget_per_tick')
  );
}

/** Признак «узел решения — не хватает просадки / импульса / recovery veto». */
function hasDipWaitSignal(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.startsWith('dip_') ||
    r.startsWith('recovery_veto_') ||
    r.startsWith('impulse<') ||
    r.includes('dip_not_deep') ||
    r.includes('dip_too_deep')
  );
}

/**
 * `pass: false`, но без отсечек по ликвидности/объёмам/холдерам/китам/кулдаунам —
 * только логика дипа (ещё не «сломался» рынок под наш вход).
 */
export function isAwaitingDipQualityHold(reasons: string[]): boolean {
  if (reasons.length === 0) return false;
  if (reasons.some(isHardQualityOrRiskBlock)) return false;
  return reasons.some(hasDipWaitSignal);
}

export function gmgnMintHrefHtml(mint: string, label?: string): string {
  const m = mint.trim();
  const url = gmgnSolTokenUrl(m);
  const lab = (label ?? m).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<a href="${url}">${lab}</a>`;
}
