/**
 * Компактный Telegram-текст для канала Dips (pullback + retrace): 4–5 строк без mint/dex/holders.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function gmgnSolTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint.trim())}`;
}

export function formatMcapUsdShort(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}k`;
  return `$${n.toFixed(0)}`;
}

export function formatTsInTz(d: Date, displayTz: string): string {
  try {
    return (
      new Intl.DateTimeFormat('ru-RU', {
        timeZone: displayTz,
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(d) + ' · МСК'
    );
  } catch {
    return d.toISOString();
  }
}

export function formatRetraceHeadlinePct(retraceFromPeakPct: number): string {
  const n = Math.abs(retraceFromPeakPct);
  if (!Number.isFinite(n)) return 'откат ?%';
  return `откат -${n.toFixed(2)}%`;
}

export function tokenHeadlinePlain(
  symbol: string | null | undefined,
  tokenName: string | null | undefined,
): string {
  const sym = (symbol ?? '').trim() || '?';
  const nameRaw = (tokenName ?? '').trim();
  if (sym !== '?' && nameRaw && nameRaw.toUpperCase() !== sym.toUpperCase()) {
    return `${sym} — ${nameRaw}`;
  }
  if (sym !== '?') return sym;
  return nameRaw || '?';
}

export function tokenHeadlineHtml(
  symbol: string | null | undefined,
  tokenName: string | null | undefined,
): string {
  const plain = tokenHeadlinePlain(symbol, tokenName);
  const sym = (symbol ?? '').trim() || '?';
  const nameRaw = (tokenName ?? '').trim();
  if (sym !== '?' && nameRaw && nameRaw.toUpperCase() !== sym.toUpperCase()) {
    return `<b>${escapeHtml(sym)}</b> — ${escapeHtml(nameRaw)}`;
  }
  return `<b>${escapeHtml(plain)}</b>`;
}

export type DipsCompactAlertInput = {
  mint: string;
  symbol: string | null | undefined;
  token_name: string | null | undefined;
  retraceFromPeakPct: number;
  peakTs: Date;
  peakMcapUsd: number | null | undefined;
  troughTs: Date;
  troughMcapUsd: number | null | undefined;
  refMcap: number;
  displayTz: string;
};

/** Компактный HTML для Telegram (канал Dips). */
export function buildDipsCompactAlertHtml(row: DipsCompactAlertInput): string {
  const mint = row.mint.trim();
  const gmgnUrl = gmgnSolTokenUrl(mint);
  const headline = tokenHeadlineHtml(row.symbol, row.token_name);
  const retraceLabel = formatRetraceHeadlinePct(row.retraceFromPeakPct);
  const refMcapStr = row.refMcap > 0 ? formatMcapUsdShort(row.refMcap) : 'n/a';
  const peakLine = `${escapeHtml(formatTsInTz(row.peakTs, row.displayTz))} · mcap ${escapeHtml(formatMcapUsdShort(row.peakMcapUsd))}`;
  const troughLine = `${escapeHtml(formatTsInTz(row.troughTs, row.displayTz))} · mcap ${escapeHtml(formatMcapUsdShort(row.troughMcapUsd))}`;

  return [
    `${headline} ${escapeHtml(retraceLabel)}`,
    `<a href="${escapeHtml(gmgnUrl)}">GMGN</a>`,
    peakLine,
    troughLine,
    `Ref mcap/fdv (текущая оценка) ≈ ${escapeHtml(refMcapStr)}`,
  ].join('\n');
}

/** Plain-text snapshot (tests / логи). */
export function buildDipsCompactAlertPlain(row: DipsCompactAlertInput): string {
  const mint = row.mint.trim();
  const gmgnUrl = gmgnSolTokenUrl(mint);
  const headline = tokenHeadlinePlain(row.symbol, row.token_name);
  const retraceLabel = formatRetraceHeadlinePct(row.retraceFromPeakPct);
  const refMcapStr = row.refMcap > 0 ? formatMcapUsdShort(row.refMcap) : 'n/a';

  return [
    `${headline} ${retraceLabel}`,
    `GMGN (${gmgnUrl})`,
    `${formatTsInTz(row.peakTs, row.displayTz)} · mcap ${formatMcapUsdShort(row.peakMcapUsd)}`,
    `${formatTsInTz(row.troughTs, row.displayTz)} · mcap ${formatMcapUsdShort(row.troughMcapUsd)}`,
    `Ref mcap/fdv (текущая оценка) ≈ ${refMcapStr}`,
  ].join('\n');
}
