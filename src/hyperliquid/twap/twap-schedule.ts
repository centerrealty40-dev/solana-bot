import type { NormalizedTwapSignal } from './types.js';

/** Hyperliquid TWAP: child order every 30s over `minutes` (see HL docs). */
export const HL_TWAP_SLICE_INTERVAL_SEC = 30;

export type TwapSchedule = {
  cycleCount: number;
  sliceIntervalSec: number;
  sizePerCycle: number;
  notionalPerCycleUsd: number;
  /** TWAP L1 / alert time (≈ старт). */
  twapStartMs: number;
  /** Первый 30s-слайс (МСК в алерте). */
  firstCycleOpenMs: number;
  /** ETA конца TWAP. */
  lastCycleEtaMs: number;
  /** Бумага: вход после 1-го цикла. */
  paperOpenAtMs: number;
  /** Бумага: выход перед последним циклом. */
  paperCloseAtMs: number;
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
  const twapStartMs = sig.startedAtMs;
  const sliceMs = HL_TWAP_SLICE_INTERVAL_SEC * 1000;
  const firstCycleOpenMs = twapStartMs + sliceMs;
  const lastCycleEtaMs = twapStartMs + minutes * 60_000;
  const paperOpenAtMs = firstCycleOpenMs;
  const paperCloseAtMs = Math.max(paperOpenAtMs + sliceMs, lastCycleEtaMs - sliceMs);

  return {
    cycleCount,
    sliceIntervalSec: HL_TWAP_SLICE_INTERVAL_SEC,
    sizePerCycle,
    notionalPerCycleUsd,
    twapStartMs,
    firstCycleOpenMs,
    lastCycleEtaMs,
    paperOpenAtMs,
    paperCloseAtMs,
    randomize: sig.randomize,
  };
}

const DEFAULT_DISPLAY_TZ = 'Europe/Moscow';

/** ISO для таймлайна дашборда — не бросает RangeError на битых ts из журнала. */
export function timelineIso(ms: unknown, fallbackMs = 0): string {
  const n = Number(ms);
  const use = Number.isFinite(n) ? n : fallbackMs;
  const d = new Date(use);
  if (Number.isNaN(d.getTime())) return new Date(fallbackMs).toISOString();
  return d.toISOString();
}

export function formatMoscowDateTime(
  ms: number,
  tz = process.env.HL_TWAP_DISPLAY_TZ?.trim() || DEFAULT_DISPLAY_TZ,
): string {
  if (!Number.isFinite(ms)) return '?';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '?';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
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
    `Бумага: вход ${formatMoscowDateTime(schedule.paperOpenAtMs)} · выход ${formatMoscowDateTime(schedule.paperCloseAtMs)}`,
    `Циклов: ${schedule.cycleCount} (${intervalNote})`,
    `За цикл: ${formatTokenAmount(schedule.sizePerCycle)} ${sig.displaySymbol}${perCycleUsd}`,
  ];
}
