import type { HlTwapLiveConfig } from './config.js';
import { HL_TWAP_SLICE_INTERVAL_SEC } from '../twap-schedule.js';
import type { TwapSide } from '../types.js';

export type ChunkedExitConfig = {
  /** 0 or 1 → instant flatten (legacy). */
  sliceCount: number;
  sliceIntervalMs: number;
};

/** Long exits use fewer slices (sim: ~+$43 vs 10× on long book); shorts keep full whale-aligned ladder. */
export function exitSliceCountForSide(side: TwapSide, cfg: HlTwapLiveConfig): number {
  return side === 'buy' ? cfg.exitSlicesLong : cfg.exitSlicesShort;
}

export function loadChunkedExitConfig(cfg: HlTwapLiveConfig, side?: TwapSide): ChunkedExitConfig {
  const sliceCount = side != null ? exitSliceCountForSide(side, cfg) : cfg.exitSlicesShort;
  return {
    sliceCount,
    sliceIntervalMs: cfg.exitSliceIntervalMs,
  };
}

export function chunkedExitEnabled(exit: ChunkedExitConfig): boolean {
  return exit.sliceCount > 1;
}

/** HL TWAP child order boundary: twapStart + n×interval (n ≥ 1). */
export function whaleSliceBoundaryMs(
  twapStartMs: number,
  whaleSliceIndex: number,
  intervalMs: number,
): number {
  return twapStartMs + whaleSliceIndex * intervalMs;
}

/**
 * First whale 30s-cycle index (1-based) at or after `afterMs`.
 * Matches `firstCycleOpenMs = twapStart + interval` in twap-schedule.
 */
export function firstWhaleSliceIndexAtOrAfter(
  twapStartMs: number,
  afterMs: number,
  intervalMs: number,
): number {
  const firstCycle = twapStartMs + intervalMs;
  if (afterMs <= firstCycle) return 1;
  const elapsed = afterMs - twapStartMs;
  return Math.max(1, Math.ceil(elapsed / intervalMs));
}

/** Our exit slice `sliceIndex` (0-based) aligned to whale TWAP ticks. */
export function whaleAlignedExitAtMs(
  twapStartMs: number,
  firstWhaleSliceIndex: number,
  sliceIndex: number,
  intervalMs: number,
): number {
  return whaleSliceBoundaryMs(twapStartMs, firstWhaleSliceIndex + sliceIndex, intervalMs);
}

/** Legacy: wall-clock from exit start (fallback when twapStartMs missing). */
export function scheduledSliceAtMs(startedAtMs: number, sliceIndex: number, intervalMs: number): number {
  return startedAtMs + sliceIndex * intervalMs;
}

export type ExitScheduleAnchor = {
  twapStartMs?: number;
  firstWhaleSliceIndex?: number;
  startedAtMs: number;
  sliceIntervalMs: number;
};

export function exitSliceDueAtMs(anchor: ExitScheduleAnchor, sliceIndex: number): number {
  if (anchor.twapStartMs != null && anchor.firstWhaleSliceIndex != null) {
    return whaleAlignedExitAtMs(
      anchor.twapStartMs,
      anchor.firstWhaleSliceIndex,
      sliceIndex,
      anchor.sliceIntervalMs,
    );
  }
  return scheduledSliceAtMs(anchor.startedAtMs, sliceIndex, anchor.sliceIntervalMs);
}

/** Next slice index to send, or null if done / not yet due. */
export function nextDueSliceIndex(
  anchor: ExitScheduleAnchor,
  slicesSent: number,
  sliceCount: number,
  nowMs: number,
): number | null {
  if (slicesSent >= sliceCount) return null;
  const dueAt = exitSliceDueAtMs(anchor, slicesSent);
  if (nowMs < dueAt) return null;
  return slicesSent;
}

/** Base size for this slice: equal fractions of current position. */
export function sliceTargetBase(absPositionBase: number, slicesSent: number, sliceCount: number): number {
  if (absPositionBase <= 0 || sliceCount <= 0) return 0;
  const remaining = sliceCount - slicesSent;
  if (remaining <= 0) return absPositionBase;
  return absPositionBase / remaining;
}

export function vwapExitPx(fills: Array<{ fillPx: number; sizeBase: number }>): number {
  let num = 0;
  let den = 0;
  for (const f of fills) {
    if (f.sizeBase <= 0) continue;
    num += f.fillPx * f.sizeBase;
    den += f.sizeBase;
  }
  return den > 0 ? num / den : 0;
}

export function defaultExitSliceIntervalMs(): number {
  const raw = process.env.HL_TWAP_LIVE_EXIT_SLICE_INTERVAL_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1000) return Math.round(n);
  }
  const sec = Number(process.env.HL_TWAP_LIVE_EXIT_SLICE_INTERVAL_SEC?.trim());
  if (Number.isFinite(sec) && sec >= 1) return Math.round(sec * 1000);
  return HL_TWAP_SLICE_INTERVAL_SEC * 1000;
}

/** Total wall-clock span for N whale-aligned slices. */
export function exitWindowMs(sliceCount: number, intervalMs: number): number {
  if (sliceCount <= 1) return 0;
  return (sliceCount - 1) * intervalMs;
}

export function buildExitScheduleAnchor(
  twapStartMs: number,
  triggerMs: number,
  startedAtMs: number,
  intervalMs: number,
): ExitScheduleAnchor {
  return {
    twapStartMs,
    firstWhaleSliceIndex: firstWhaleSliceIndexAtOrAfter(twapStartMs, triggerMs, intervalMs),
    startedAtMs,
    sliceIntervalMs: intervalMs,
  };
}

/**
 * Whale-aligned exit anchor for chunked close.
 * Timer exits (started at/after liveCloseAtMs) align to the scheduled close tick;
 * early exits (whale ended, impact lost, …) anchor to actual start — not future liveCloseAtMs.
 */
export function exitScheduleTriggerMs(startedAtMs: number, liveCloseAtMs: number): number {
  if (startedAtMs >= liveCloseAtMs) {
    return Math.max(startedAtMs, liveCloseAtMs);
  }
  return startedAtMs;
}

/** Drop whale alignment when first slice would fire far after exit actually started (journal repair). */
export function resolveExitScheduleAnchor(pending: {
  twapStartMs?: number;
  firstWhaleSliceIndex?: number;
  startedAtMs: number;
  sliceIntervalMs: number;
  slicesSent: number;
}): ExitScheduleAnchor {
  const full: ExitScheduleAnchor = {
    twapStartMs: pending.twapStartMs,
    firstWhaleSliceIndex: pending.firstWhaleSliceIndex,
    startedAtMs: pending.startedAtMs,
    sliceIntervalMs: pending.sliceIntervalMs,
  };
  if (
    pending.slicesSent === 0 &&
    pending.twapStartMs != null &&
    pending.firstWhaleSliceIndex != null
  ) {
    const dueAt = exitSliceDueAtMs(full, 0);
    if (dueAt > pending.startedAtMs + pending.sliceIntervalMs * 2) {
      return {
        startedAtMs: pending.startedAtMs,
        sliceIntervalMs: pending.sliceIntervalMs,
      };
    }
  }
  return full;
}
