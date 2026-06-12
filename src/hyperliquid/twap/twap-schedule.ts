import type { NormalizedTwapSignal } from './types.js';
import {
  shouldUseMicroExecution,
  twapExitAdaptiveThresholdMinutes,
  twapExitEarlyMinutesForDuration,
  twapHoldToEndEnabled,
} from './twap-duration.js';

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
  /** Бумага/live: выход при ETA последнего цикла (hold-to-end) или раньше (legacy). */
  paperCloseAtMs: number;
  /** Minutes before TWAP end (standard lane exit timer). */
  exitEarlyMinutes: number;
  /** Short TWAP (<15m): instant exit aligned to whale slice before last. */
  shortTwapLane: boolean;
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
  /** Enter as soon as TWAP starts (not after first 30s slice). */
  const paperOpenAtMs = twapStartMs;
  const shortLane = shouldUseMicroExecution(minutes);
  const holdToEnd = twapHoldToEndEnabled();
  const exitEarlyMinutes = holdToEnd ? 0 : shortLane ? 0 : twapExitEarlyMinutesForDuration(minutes);
  const exitEarlyMs = exitEarlyMinutes * 60_000;
  const paperCloseAtMs = holdToEnd
    ? lastCycleEtaMs
    : shortLane
      ? Math.max(
          paperOpenAtMs + sliceMs,
          twapStartMs + Math.max(1, cycleCount - 1) * sliceMs,
        )
      : Math.max(paperOpenAtMs + sliceMs, lastCycleEtaMs - exitEarlyMs);

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
    exitEarlyMinutes,
    shortTwapLane: shortLane,
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

  const mins = Math.max(1, Math.round(sig.minutes));
  const exitNote = twapHoldToEndEnabled()
    ? `выход при ETA последнего цикла ${formatMoscowDateTime(schedule.paperCloseAtMs)}`
    : schedule.shortTwapLane
      ? `instant выход перед последним слайсом ${formatMoscowDateTime(schedule.paperCloseAtMs)}`
      : mins > twapExitAdaptiveThresholdMinutes()
        ? `выход после ${Math.round(((mins - schedule.exitEarlyMinutes) / mins) * 100)}% TWAP (−${schedule.exitEarlyMinutes}m) ${formatMoscowDateTime(schedule.paperCloseAtMs)}`
        : `выход −${schedule.exitEarlyMinutes}m ${formatMoscowDateTime(schedule.paperCloseAtMs)}`;

  return [
    `Первый цикл (МСК): ${formatMoscowDateTime(schedule.firstCycleOpenMs)}`,
    `ETA последнего цикла (МСК): ${formatMoscowDateTime(schedule.lastCycleEtaMs)}`,
    schedule.shortTwapLane
      ? `Live/paper (short TWAP): вход ${formatMoscowDateTime(schedule.paperOpenAtMs)} · ${exitNote}`
      : `Live/paper: вход при старте TWAP ${formatMoscowDateTime(schedule.paperOpenAtMs)} · ${exitNote}`,
    `Циклов: ${schedule.cycleCount} (${intervalNote})`,
    `За цикл: ${formatTokenAmount(schedule.sizePerCycle)} ${sig.displaySymbol}${perCycleUsd}`,
  ];
}
