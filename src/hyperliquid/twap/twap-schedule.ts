import type { NormalizedTwapSignal } from './types.js';

/** Hyperliquid TWAP: child order every 30s over `minutes` (see HL docs). */
export const HL_TWAP_SLICE_INTERVAL_SEC = 30;

export type TwapSchedule = {
  cycleCount: number;
  sliceIntervalSec: number;
  sizePerCycle: number;
  notionalPerCycleUsd: number;
  firstCycleOpenMs: number;
  lastCycleEtaMs: number;
  randomize: boolean;
};

export function computeTwapSchedule(sig: Pick<
  NormalizedTwapSignal,
  'size' | 'minutes' | 'randomize' | 'midPx' | 'startedAtMs'
>): TwapSchedule {
  const minutes = Math.max(1, Math.round(sig.minutes));
  const cycleCount = minutes * (60 / HL_TWAP_SLICE_INTERVAL_SEC);
  const sizePerCycle = sig.size / cycleCount;
  const notionalPerCycleUsd = sig.midPx > 0 ? sizePerCycle * sig.midPx : 0;
  const firstCycleOpenMs = sig.startedAtMs;
  const lastCycleEtaMs = sig.startedAtMs + minutes * 60_000;

  return {
    cycleCount,
    sliceIntervalSec: HL_TWAP_SLICE_INTERVAL_SEC,
    sizePerCycle,
    notionalPerCycleUsd,
    firstCycleOpenMs,
    lastCycleEtaMs,
    randomize: sig.randomize,
  };
}

const DEFAULT_DISPLAY_TZ = 'Europe/Moscow';

export function formatMoscowDateTime(
  ms: number,
  tz = process.env.HL_TWAP_DISPLAY_TZ?.trim() || DEFAULT_DISPLAY_TZ,
): string {
  if (!Number.isFinite(ms)) return '?';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

export function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4).replace(/\.?0+$/, '');
  return n.toFixed(6).replace(/\.?0+$/, '');
}

export function formatTwapScheduleLines(
  sig: Pick<NormalizedTwapSignal, 'displaySymbol' | 'size' | 'minutes' | 'randomize' | 'midPx' | 'startedAtMs'>,
  schedule: TwapSchedule,
  fmtUsd: (v: number) => string,
): string[] {
  const intervalNote = schedule.randomize
    ? `шаг ~${schedule.sliceIntervalSec} сек, рандом`
    : `шаг ~${schedule.sliceIntervalSec} сек`;
  const perCycleUsd =
    schedule.notionalPerCycleUsd > 0 ? ` (${fmtUsd(schedule.notionalPerCycleUsd)})` : '';

  return [
    `Первый цикл (МСК): ${formatMoscowDateTime(schedule.firstCycleOpenMs)}`,
    `ETA последнего цикла (МСК): ${formatMoscowDateTime(schedule.lastCycleEtaMs)}`,
    `Циклов: ${schedule.cycleCount} (${intervalNote})`,
    `За цикл: ${formatTokenAmount(schedule.sizePerCycle)} ${sig.displaySymbol}${perCycleUsd}`,
  ];
}
