/**
 * 1.11.231 — adaptive Jupiter priority fee при congestion.
 *
 * Когда сеть забита, sendTransaction → confirm цикл начинает фейлиться `confirm_timeout` (tx не
 * подтвердился за `LIVE_CONFIRM_TIMEOUT_MS`). Если такие фейлы идут подряд, поднимаем
 * `liveJupiterPriorityMaxLamports` × `boostFactor` и держим повышенным `holdMs` минут.
 * После — обратно. Это **mutex-free** in-memory state в одном процессе.
 *
 * Жизненный цикл:
 *   - `recordSendOutcome({kind:'confirm_timeout'})` инкрементит rolling-counter в `windowMs`-окне;
 *   - при достижении `windowMs` штук подряд `confirm_timeout` → boost.
 *   - `recordSendOutcome({kind:'success'})` обнуляет счётчик confirm_timeout (resilient).
 *   - boost истекает по таймеру (`holdMs`) → пишем JSONL `live_priority_fee_boost_expired`.
 *
 * Параметры:
 *   - `LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED` (default 0)
 *   - `LIVE_ADAPTIVE_PRIORITY_FEE_THRESHOLD` (default 5) — сколько confirm_timeout подряд за window
 *   - `LIVE_ADAPTIVE_PRIORITY_FEE_WINDOW_MS` (default 600_000 = 10 мин)
 *   - `LIVE_ADAPTIVE_PRIORITY_FEE_BOOST_FACTOR` (default 2.5)
 *   - `LIVE_ADAPTIVE_PRIORITY_FEE_HOLD_MS` (default 1_800_000 = 30 мин)
 */

import { appendLiveJsonlEvent } from './store-jsonl.js';
import { child } from '../core/logger.js';

const log = child('adaptive-priority-fee');

export interface AdaptivePriorityFeeConfig {
  enabled: boolean;
  /** Сколько подряд confirm_timeout за window → boost. */
  threshold: number;
  /** Rolling window для подсчёта confirm_timeout. */
  windowMs: number;
  /** Множитель для priority fee при boost. */
  boostFactor: number;
  /** Сколько времени держать boost после активации. */
  holdMs: number;
}

let cfg: AdaptivePriorityFeeConfig = {
  enabled: false,
  threshold: 5,
  windowMs: 10 * 60 * 1000,
  boostFactor: 2.5,
  holdMs: 30 * 60 * 1000,
};

/** Timestamps of recent confirm_timeout events (rolling window). */
const recentTimeouts: number[] = [];
/** Boost-state: 0 = no boost, > 0 = `Date.now()`-ts когда boost истечёт. */
let boostUntilMs = 0;

export function configureAdaptivePriorityFee(c: AdaptivePriorityFeeConfig): void {
  cfg = { ...c };
}

export function isAdaptivePriorityFeeEnabled(): boolean {
  return cfg.enabled;
}

/** Очистить устаревшие entries из `recentTimeouts`. */
function pruneWindow(now: number): void {
  const cutoff = now - cfg.windowMs;
  while (recentTimeouts.length > 0 && recentTimeouts[0]! < cutoff) {
    recentTimeouts.shift();
  }
}

export function recordSendOutcome(args: {
  kind: 'success' | 'confirm_timeout' | 'send_failed' | 'sim_err';
}): void {
  if (!cfg.enabled) return;
  const now = Date.now();
  if (args.kind === 'success') {
    /** При успехе сразу обнуляем — это сигнал, что сеть отошла. */
    if (recentTimeouts.length > 0) recentTimeouts.length = 0;
    return;
  }
  if (args.kind !== 'confirm_timeout') return;
  recentTimeouts.push(now);
  pruneWindow(now);
  if (recentTimeouts.length >= cfg.threshold && boostUntilMs <= now) {
    boostUntilMs = now + cfg.holdMs;
    log.warn(
      {
        timeoutsInWindow: recentTimeouts.length,
        threshold: cfg.threshold,
        windowMs: cfg.windowMs,
        boostFactor: cfg.boostFactor,
        boostUntilMs: new Date(boostUntilMs).toISOString(),
      },
      'adaptive priority fee BOOST armed',
    );
    appendLiveJsonlEvent({
      kind: 'live_priority_fee_boost',
      timeoutsInWindow: recentTimeouts.length,
      threshold: cfg.threshold,
      windowMs: cfg.windowMs,
      boostFactor: cfg.boostFactor,
      holdMs: cfg.holdMs,
      boostUntilMs,
    });
  }
}

/**
 * Возвращает «эффективный» `priorityMaxLamports`: если boost активен — base × boostFactor (округлено).
 * Иначе — base.
 *
 * Также авто-истекает boost при first invocation после `boostUntilMs`.
 */
export function adaptivePriorityMaxLamports(baseLamports: number): number {
  if (!cfg.enabled) return baseLamports;
  const now = Date.now();
  if (boostUntilMs > 0 && now >= boostUntilMs) {
    log.info({ boostFor: 'expired' }, 'adaptive priority fee boost EXPIRED');
    appendLiveJsonlEvent({
      kind: 'live_priority_fee_boost_expired',
      boostUntilMs,
      nowMs: now,
    });
    boostUntilMs = 0;
    recentTimeouts.length = 0;
  }
  if (boostUntilMs <= 0 || boostUntilMs <= now) return baseLamports;
  /** Boost активен. */
  const boosted = Math.max(baseLamports, Math.floor(baseLamports * cfg.boostFactor));
  /** Hard cap чтобы не уйти в космос: max 50M lamports (= 0.05 SOL). */
  return Math.min(boosted, 50_000_000);
}

/** Тест-helper: вернуть snapshot internal state. */
export function _adaptivePriorityFeeSnapshotForTests(): {
  cfg: AdaptivePriorityFeeConfig;
  recentTimeouts: number[];
  boostUntilMs: number;
} {
  return {
    cfg: { ...cfg },
    recentTimeouts: [...recentTimeouts],
    boostUntilMs,
  };
}

/** Тест-helper: сбросить. */
export function _resetAdaptivePriorityFeeForTests(): void {
  cfg = {
    enabled: false,
    threshold: 5,
    windowMs: 10 * 60 * 1000,
    boostFactor: 2.5,
    holdMs: 30 * 60 * 1000,
  };
  recentTimeouts.length = 0;
  boostUntilMs = 0;
}
