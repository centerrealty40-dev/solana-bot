import { gmgnMintHrefHtml } from '../papertrader/discovery/near-ready-dip-watch.js';

export type KnifeDumpSnapshot = {
  preDumpHigh: number;
  dumpLow: number;
  dumpPct: number;
  sellUsd: number;
  signature: string;
  source: string;
};

export function escapeKnifeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function shortKnifeMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

export function fmtKnifePrice(p: number): string {
  if (!(p > 0)) return '0';
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

export function fmtKnifeUsd(v: number): string {
  if (!Number.isFinite(v)) return '?';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${Math.round(v)}`;
  if (abs >= 100) return `$${v.toFixed(0)}`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(3)}`;
}

const CLOSE_REASON_RU: Record<string, string> = {
  kill: 'стоп-килл (−50%)',
  ladder_complete: 'лестница TP (все руны)',
  trail: 'трейлинг-стоп',
  timeout: 'таймаут удержания',
};

export function knifeCloseReasonRu(reason: string): string {
  return CLOSE_REASON_RU[reason] ?? reason;
}

function header(mode: 'shadow' | 'live', title: string): string {
  const tag = mode === 'shadow' ? 'knife_shadow' : 'knife_live';
  return `<b>[REPORT][${tag}]</b>\n<b>${escapeKnifeHtml(title)}</b>`;
}

function mintBlock(mint: string): string {
  return (
    `Mint: <code>${escapeKnifeHtml(shortKnifeMint(mint))}</code>\n` +
    `Адрес: ${gmgnMintHrefHtml(mint, mint)}`
  );
}

export function buildKnifeDumpTelegram(args: {
  mode: 'shadow' | 'live';
  mint: string;
  dump: KnifeDumpSnapshot;
  priceUsd: number;
  maxEntryAfterDumpSec: number;
  maxBouncePct: number;
}): string {
  const { mode, mint, dump, priceUsd, maxEntryAfterDumpSec, maxBouncePct } = args;
  const lines = [
    header(mode, '🐋 WHALE DUMP — детект'),
    mintBlock(mint),
    `Крупный sell: <b>${fmtKnifeUsd(dump.sellUsd)}</b> · dump <b>−${dump.dumpPct.toFixed(1)}%</b>`,
    `High до дампа: <b>${fmtKnifePrice(dump.preDumpHigh)}</b> → low <b>${fmtKnifePrice(dump.dumpLow)}</b>`,
    `Цена свапа: <b>${fmtKnifePrice(priceUsd)}</b> · источник: <code>${escapeKnifeHtml(dump.source)}</code>`,
    `Окно входа: <b>${maxEntryAfterDumpSec}с</b> · допустимый отскок от дна: ≤<b>${maxBouncePct}%</b>`,
    `Sig: <code>${escapeKnifeHtml(dump.signature.slice(0, 12))}…</code>`,
    mode === 'shadow' ? `Режим: <b>shadow</b> — реальной сделки нет, только журнал.` : '',
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

export function buildKnifeEntryTelegram(args: {
  mode: 'shadow' | 'live';
  mint: string;
  legUsd: number;
  priceUsd: number;
  dump: KnifeDumpSnapshot;
  bouncePct: number;
  entryDelayMs: number;
}): string {
  const { mode, mint, legUsd, priceUsd, dump, bouncePct, entryDelayMs } = args;
  const lines = [
    header(mode, '🔪 ВХОД leg1 — whale-dump dip'),
    mintBlock(mint),
    `Нога: <b>${fmtKnifeUsd(legUsd)}</b> @ <b>${fmtKnifePrice(priceUsd)}</b>`,
    `Триггер: sell <b>${fmtKnifeUsd(dump.sellUsd)}</b>, dump <b>−${dump.dumpPct.toFixed(1)}%</b> от high ${fmtKnifePrice(dump.preDumpHigh)}`,
    `Задержка после dump: <b>${(entryDelayMs / 1000).toFixed(1)}с</b> · отскок от дна: <b>${bouncePct.toFixed(1)}%</b>`,
    mode === 'shadow' ? `Режим: <b>shadow</b> — симуляция, не покупаем на кошельке.` : '',
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

export function buildKnifeAvgTelegram(args: {
  mode: 'shadow' | 'live';
  mint: string;
  legUsd: number;
  priceUsd: number;
  dropFromLeg1Pct: number;
  avgEntry: number;
}): string {
  const { mode, mint, legUsd, priceUsd, dropFromLeg1Pct, avgEntry } = args;
  const lines = [
    header(mode, '↓ УСРЕДНЕНИЕ leg2'),
    mintBlock(mint),
    `Нога: <b>${fmtKnifeUsd(legUsd)}</b> @ <b>${fmtKnifePrice(priceUsd)}</b>`,
    `Просадка от leg1: <b>−${dropFromLeg1Pct.toFixed(1)}%</b> · новый avg: <b>${fmtKnifePrice(avgEntry)}</b>`,
    mode === 'shadow' ? `Режим: <b>shadow</b>.` : '',
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

export function buildKnifeCloseTelegram(args: {
  mode: 'shadow' | 'live';
  mint: string;
  reason: string;
  legs: number;
  avgEntry: number;
  investedUsd: number;
  realizedUsd: number;
  pnlPct: number;
}): string {
  const { mode, mint, reason, legs, avgEntry, investedUsd, realizedUsd, pnlPct } = args;
  const pnlSign = pnlPct >= 0 ? '+' : '';
  const usdSign = realizedUsd >= 0 ? '+' : '';
  const lines = [
    header(mode, '✅ ЗАКРЫТИЕ'),
    mintBlock(mint),
    `Причина: <b>${escapeKnifeHtml(knifeCloseReasonRu(reason))}</b>`,
    `Вложено: <b>${fmtKnifeUsd(investedUsd)}</b> · ног: <b>${legs}</b> · avg entry: <b>${fmtKnifePrice(avgEntry)}</b>`,
    `PnL (shadow): <b>${pnlSign}${pnlPct.toFixed(1)}%</b> (${usdSign}${fmtKnifeUsd(realizedUsd)})`,
    mode === 'shadow' ? `Режим: <b>shadow</b> — смотри цену на GMGN, сравни с журналом.` : '',
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

export function buildKnifeSummaryTelegram(args: {
  mode: 'shadow' | 'live';
  watched: number;
  open: number;
  pendingDumps: number;
  realizedUsd: number;
  periodDeltaUsd: number;
}): string {
  const { mode, watched, open, pendingDumps, realizedUsd, periodDeltaUsd } = args;
  const deltaSign = periodDeltaUsd >= 0 ? '+' : '';
  const realizedSign = realizedUsd >= 0 ? '+' : '';
  const lines = [
    header(mode, '📊 СВОДКА knife-catcher'),
    `Слежу: <b>${watched}</b> mint · открыто: <b>${open}</b> · pending dump: <b>${pendingDumps}</b>`,
    `Реализ. PnL (shadow): <b>${realizedSign}${fmtKnifeUsd(realizedUsd)}</b> (за период ${deltaSign}${fmtKnifeUsd(periodDeltaUsd)})`,
    `Стратегия: whale-dump → вход ≤50с · цены: Jupiter + swap (валидированный)`,
    mode === 'shadow' ? `Режим: <b>shadow</b> — все цифры симуляция.` : '',
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}
