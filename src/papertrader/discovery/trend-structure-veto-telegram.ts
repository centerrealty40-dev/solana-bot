import type { EvalDecision } from './dip-clones.js';

/** True when trend-structure veto is the sole blocker (dip/snapshot/global gates already passed). */
export function isOnlyTrendVetoReasons(reasons: string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => r.startsWith('trend_veto_'));
}

export function shouldNotifyTrendStructureVeto(d: EvalDecision): boolean {
  if (d.pass) return false;
  if (!d.features.trend_structure_veto?.vetoed) return false;
  return isOnlyTrendVetoReasons(d.reasons);
}

function fmtPctRatio(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtSlopePct(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(1)}%`;
}

export function buildTrendStructureVetoTelegramText(args: {
  d: EvalDecision;
  escapeHtml: (s: string) => string;
  mintHrefHtml: (mint: string, label: string) => string;
  fmtUsd: (n: number | null | undefined) => string;
}): string {
  const { d, escapeHtml, mintHrefHtml, fmtUsd } = args;
  const symbol = d.symbol?.trim() || '?';
  const tv = d.features.trend_structure_veto;
  const vetoReasons = d.reasons.filter((r) => r.startsWith('trend_veto_'));
  return (
    `<b>Live Oscar — trend veto (протухший раннер)</b>\n` +
    `Монета: <b>${escapeHtml(symbol)}</b>\n` +
    `Адрес: ${mintHrefHtml(d.mint, d.mint)}\n` +
    `Статус: кандидат <b>готов к покупке</b> (dip и все пороги пройдены), но вход заблокирован trend-structure veto.\n` +
    `Причины: <code>${escapeHtml(vetoReasons.join('; '))}</code>\n` +
    `Px / high ${tv?.lookbackDays ?? 14}d: <b>${escapeHtml(fmtPctRatio(tv?.pxVsHighLookback))}</b>, ` +
    `дней с пика: <b>${escapeHtml(tv?.daysSinceHighBreak == null ? 'n/a' : tv.daysSinceHighBreak.toFixed(1))}</b>\n` +
    `Slope 7d: <b>${escapeHtml(fmtSlopePct(tv?.slope7dPct))}</b>, ` +
    `slope 3d: <b>${escapeHtml(fmtSlopePct(tv?.slope3dPct))}</b>\n` +
    `Price: <b>${escapeHtml(fmtUsd(d.features.price_usd))}</b>, ` +
    `Mcap: <b>${escapeHtml(fmtUsd(d.features.market_cap_usd))}</b>\n` +
    `Dip: <b>${escapeHtml(d.features.dip_pct == null ? 'n/a' : `${d.features.dip_pct.toFixed(2)}%`)}</b> ` +
    `(${escapeHtml(String(d.features.dip_lookback_min ?? 'n/a'))}m)`
  );
}
