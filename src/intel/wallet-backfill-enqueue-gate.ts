/**
 * W6.12 S06 — bounded completeness: gate на enqueue в `wallet_backfill_queue`.
 * Чистая функция для unit-тестов; см. `docs/Smart Lottery V2/W6.12_S06_bounded_completeness_swap_ingest_plan_spec.md` §4.
 */

export type EnqueueGateInput = {
  pendingCount: number;
  requested: number;
  /** Если задано и `pendingCount` выше порога — блокируем enqueue, пока не задан `softCap` (см. спеку). */
  gatePendingMax: number | null;
  /** Верхняя целевая глубина `pending`; headroom = max(0, softCap - pendingCount). */
  softCap: number | null;
};

export type EnqueueGateResult = {
  effectiveN: number;
  skipped: boolean;
  reason: string;
};

export function parseOptionalPositiveIntEnv(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Возвращает число строк для INSERT enqueue и диагностическую причину.
 */
export function computeEnqueueBatchSize(input: EnqueueGateInput): EnqueueGateResult {
  const { pendingCount, requested, gatePendingMax, softCap } = input;
  const req = Math.max(0, Math.floor(requested));

  const gateOn = gatePendingMax !== null && pendingCount > gatePendingMax;

  if (gateOn && softCap === null) {
    return {
      effectiveN: 0,
      skipped: req > 0,
      reason: 'gate_pending_over_max_no_soft_cap',
    };
  }

  let n = req;
  if (softCap !== null) {
    const headroom = Math.max(0, Math.floor(softCap) - pendingCount);
    n = Math.min(n, headroom);
  }

  if (gateOn && softCap !== null && n === 0 && req > 0) {
    return {
      effectiveN: 0,
      skipped: true,
      reason: 'gate_pending_over_max_zero_headroom',
    };
  }

  if (n === 0 && req > 0) {
    return {
      effectiveN: 0,
      skipped: true,
      reason: softCap !== null ? 'soft_cap_no_headroom' : 'requested_zero',
    };
  }

  if (n === 0) {
    return { effectiveN: 0, skipped: false, reason: 'noop' };
  }

  let reason = 'ok';
  if (softCap !== null && n < req) reason = 'limited_by_soft_cap_headroom';
  if (gateOn && softCap !== null) reason = 'gate_active_limited_by_soft_cap_headroom';

  return { effectiveN: n, skipped: false, reason };
}
