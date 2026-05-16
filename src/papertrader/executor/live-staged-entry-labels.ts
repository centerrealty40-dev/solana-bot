import type { PaperTraderConfig } from '../config.js';
import type { LiveStagedEntryState } from '../types.js';

function fmtUsd(n: number): string {
  return `$${n.toFixed(0)}`;
}

function fmtDropPct(v: number): string {
  return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
}

function fmtSignedPctFromFraction(triggerPct: number): string {
  const p = triggerPct * 100;
  const sign = p < 0 ? '−' : '+';
  return `${sign}${Math.abs(p).toFixed(1)}%`;
}

/** Подпись открытия (1-я нога сплита) + план оставшихся ног. */
export function liveStagedOpenLabelRuFromCfg(cfg: PaperTraderConfig): string {
  const leg1 = cfg.liveStagedEntryEntrySplitLegUsd;
  const leg2 = leg1;
  const avg1 = cfg.liveStagedEntrySecondLegUsd;
  const avg2 = cfg.liveStagedEntryThirdLegUsd;
  const d7 = cfg.liveStagedEntrySecondDropPct;
  const d14 = cfg.liveStagedEntryThirdDropPct;
  const delaySec = Math.round(cfg.liveStagedEntryEntrySplitDelayMs / 1000);
  const cd1Min = Math.round(cfg.liveStagedEntryAvgCooldownMs / 60_000);
  const cd2Min = Math.round(cfg.liveStagedEntryAvgSecondCooldownMs / 60_000);
  const up = cfg.liveStagedEntryEntrySplitMaxUpPct;
  const down = cfg.liveStagedEntryEntrySplitMaxDownPct;
  const parts: string[] = [
    `Покупка · 1-я нога сплита входа: ${fmtUsd(leg1)} по сигналу`,
    `план: 2-я нога сплита ${fmtUsd(leg2)} через ${delaySec} с (коридор +${fmtDropPct(up)}%…−${fmtDropPct(down)}% к якорю 1-й ноги, не усреднение)`,
  ];
  if (avg1 > 0 && d7 > 0) {
    parts.push(
      `1-е усреднение ${fmtUsd(avg1)} при просадке −${fmtDropPct(d7)}%…−${fmtDropPct(d14)}% от сигнала (≥${cd1Min} мин после 1-й ноги)`,
    );
  }
  if (avg2 > 0 && d14 > 0) {
    parts.push(
      `2-е усреднение ${fmtUsd(avg2)} при ≤−${fmtDropPct(d14)}% от сигнала (≥${cd2Min} мин после 1-го усреднения)`,
    );
  }
  return parts.join(' · ');
}

/** Replay / snapshot open label from persisted `liveStagedEntry` + params. */
export function liveStagedOpenLabelFromState(
  strategyId: string,
  openTrade: Record<string, unknown>,
): string | null {
  const st = openTrade.liveStagedEntry as LiveStagedEntryState | undefined;
  if (!st) return null;
  if (st.entrySplitV2 !== true) return liveStagedOpenLabelLegacy(strategyId, openTrade);
  const leg1 = Number(st.firstLegUsd ?? 0);
  if (!(leg1 > 0)) return null;
  const leg2 = Number(st.entrySplitLegUsd ?? leg1);
  const avg1 = Number(st.avgSecondLegUsd ?? st.secondLegUsd ?? 0);
  const avg2 = Number(st.avgThirdLegUsd ?? st.thirdLegUsd ?? 0);
  const d7 = Number(st.avgSecondDropPct ?? st.secondDropPct ?? 0);
  const d14 = Number(st.avgThirdDropPct ?? st.thirdDropPct ?? 0);
  const delaySec = Math.round(Number(st.entrySplitDelayMs ?? 10_000) / 1000);
  const cd1Min = Math.round(Number(st.avgFirstCooldownMs ?? 180_000) / 60_000);
  const cd2Min = Math.round(Number(st.avgSecondCooldownMs ?? 300_000) / 60_000);
  const up = Number(st.entrySplitMaxUpPct ?? 3);
  const down = Number(st.entrySplitMaxDownPct ?? 10);
  const parts: string[] = [
    `Покупка · 1-я нога сплита входа: ${fmtUsd(leg1)} по сигналу`,
    `план: 2-я нога сплита ${fmtUsd(leg2)} через ${delaySec} с (+${fmtDropPct(up)}%…−${fmtDropPct(down)}% к якорю, не усреднение)`,
  ];
  if (avg1 > 0 && d7 > 0) {
    parts.push(
      `1-е усреднение ${fmtUsd(avg1)} (−${fmtDropPct(d7)}%…−${fmtDropPct(d14)}% от сигнала, ≥${cd1Min} мин)`,
    );
  }
  if (avg2 > 0 && d14 > 0) {
    parts.push(`2-е усреднение ${fmtUsd(avg2)} (≤−${fmtDropPct(d14)}%, ≥${cd2Min} мин после 1-го)`);
  }
  return parts.join(' · ');
}

function liveStagedOpenLabelLegacy(strategyId: string, e: Record<string, unknown>): string | null {
  const st = e.liveStagedEntry as LiveStagedEntryState | undefined;
  if (!st) return null;
  const legs = Array.isArray(e.legs) ? (e.legs as Record<string, unknown>[]) : [];
  const firstLegUsd = Number(st.firstLegUsd ?? legs[0]?.sizeUsd ?? 0);
  if (!(firstLegUsd > 0)) return null;
  const firstDropPct = Number(st.firstDropPct ?? 0);
  const name = strategyId === 'live-oscar-risky' ? 'Первая нога Risky' : 'Первая нога';
  const trigger = firstDropPct <= 0 ? 'по сигналу' : `на −${fmtDropPct(firstDropPct)}% от сигнала`;
  const params = e.liveStagedEntryParams as Record<string, unknown> | undefined;
  const planParts: string[] = [];
  const secondUsd = Number(params?.secondLegUsd ?? st.secondLegUsd ?? 0);
  const secondDrop = Number(params?.secondDropPct ?? st.secondDropPct ?? 0);
  if (secondUsd > 0 && secondDrop > 0) planParts.push(`+$${secondUsd.toFixed(0)}/−${secondDrop}%`);
  const thirdUsd = Number(params?.thirdLegUsd ?? st.thirdLegUsd ?? 0);
  const thirdDrop = Number(params?.thirdDropPct ?? st.thirdDropPct ?? 0);
  if (thirdUsd > 0 && thirdDrop > 0) planParts.push(`+$${thirdUsd.toFixed(0)}/−${thirdDrop}%`);
  const killDrop = Number(params?.killDropPct ?? st.killDropPct ?? 0);
  const killSuffix = killDrop > 0 ? ` · kill −${killDrop}% от сигнала` : '';
  const planSuffix = planParts.length > 0 ? ` · план DCA: ${planParts.join(', ')}` : '';
  return `${name}: ${fmtUsd(firstLegUsd)} ${trigger}${planSuffix}${killSuffix}`;
}

export function entrySplitLeg2TimelineLabel(usd: number, changePctFromAnchor: number): string {
  const sign = changePctFromAnchor >= 0 ? '+' : '−';
  return `Покупка · 2-я нога сплита входа: ${fmtUsd(usd)} · цена ${sign}${Math.abs(changePctFromAnchor).toFixed(2)}% к якорю 1-й ноги (не усреднение)`;
}

export function stagedAvgTimelineLabel(args: {
  which: 1 | 2;
  usd: number;
  signalDropPct: number;
  drop7: number;
  drop14: number;
}): string {
  const { which, usd, signalDropPct, drop7, drop14 } = args;
  const dropStr = signalDropPct.toFixed(2);
  if (which === 1) {
    return `Усреднение · 1-е: ${fmtUsd(usd)} при ${dropStr}% от сигнала (зона −${fmtDropPct(drop7)}%…−${fmtDropPct(drop14)}%, не сплит)`;
  }
  return `Усреднение · 2-е: ${fmtUsd(usd)} при ${dropStr}% от сигнала (≤ −${fmtDropPct(drop14)}%, не сплит)`;
}

/** Label for live_position_dca replay when `timelineLabelRu` missing on row. */
export function legTimelineLabelFromLeg(
  leg: Record<string, unknown>,
  openTrade?: Record<string, unknown>,
): string | null {
  const reason = String(leg.reason ?? '');
  const usd = Number(leg.sizeUsd ?? 0);
  const trig = Number(leg.triggerPct ?? 0);
  if (reason === 'entry_split' && usd > 0) {
    const ch = trig * 100;
    return entrySplitLeg2TimelineLabel(usd, ch);
  }
  if (reason === 'staged_avg' && usd > 0) {
    const st = openTrade?.liveStagedEntry as LiveStagedEntryState | undefined;
    const drop7 = Number(st?.avgSecondDropPct ?? st?.secondDropPct ?? 7);
    const drop14 = Number(st?.avgThirdDropPct ?? st?.thirdDropPct ?? 14);
    const legs = Array.isArray(openTrade?.legs) ? (openTrade!.legs as Record<string, unknown>[]) : [];
    const stagedAvgLegs = legs.filter((l) => String(l.reason ?? '') === 'staged_avg');
    const which: 1 | 2 = stagedAvgLegs.length <= 1 ? 1 : 2;
    const signalDropPct = trig * 100;
    return stagedAvgTimelineLabel({ which, usd, signalDropPct, drop7, drop14 });
  }
  if (reason === 'dca' || reason === 'dca_add') {
    return `DCA · ${fmtUsd(usd)} · уровень ${fmtSignedPctFromFraction(trig)} (от первой ноги)`;
  }
  return null;
}

export function liveOscarEntryContextNoteV2(): string {
  return (
    'Live Oscar (сплит + staged-усреднение): 1-я нога сплита покупается по сигналу; 2-я нога сплита — отдельная покупка через 10 с в коридоре цены к якорю 1-й ноги (не усреднение). ' +
    '1-е и 2-е усреднение — только при просадке от сигнала (−7%…−14% и ≤−14%) с паузами 3 и 5 мин. ' +
    'Выход: TP-сетка, TRAIL ladder_retrace, kill −20% к средней, slip 0.5% + retry ×10.'
  );
}

export function liveOscarEntryContextNoteLegacy(): string {
  return (
    'Live Oscar (legacy staged): первая нога по сигналу + DCA-доливки от сигнала; выход TP-сетка, TRAIL, kill −20% к средней.'
  );
}
