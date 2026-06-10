import type { TwapSide } from '../types.js';

export type ParsedHlOrderFill = {
  filledBase: number;
  avgPx: number;
};

export type ParsedHlOrderStatus =
  | { kind: 'filled'; fill: ParsedHlOrderFill }
  | { kind: 'error'; message: string }
  | { kind: 'resting' }
  | { kind: 'waiting' };

function num(v: string | number | undefined | null): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Parse first HL exchange order status from `@nktkas/hyperliquid` order response. */
export function parseHlOrderStatus(result: unknown): ParsedHlOrderStatus | null {
  const root = result as {
    status?: string;
    response?: { data?: { statuses?: unknown[] } };
  };
  if (root?.status !== 'ok') return null;

  const first = root.response?.data?.statuses?.[0];
  if (first == null) return null;

  if (typeof first === 'string') {
    if (first === 'waitingForFill' || first === 'waitingForTrigger') {
      return { kind: 'waiting' };
    }
    return null;
  }

  if (typeof first !== 'object') return null;

  const row = first as Record<string, unknown>;
  if (typeof row.error === 'string') {
    return { kind: 'error', message: row.error };
  }
  if (row.resting != null) {
    return { kind: 'resting' };
  }
  const filled = row.filled as { totalSz?: string | number; avgPx?: string | number } | undefined;
  if (filled != null) {
    const filledBase = num(filled.totalSz);
    const avgPx = num(filled.avgPx);
    if (filledBase > 0 && avgPx > 0) {
      return { kind: 'filled', fill: { filledBase, avgPx } };
    }
  }
  return null;
}

/** Signed szi delta → filled base size (always ≥ 0). */
export function filledBaseFromSziDelta(
  sziBefore: number,
  sziAfter: number,
  side: TwapSide,
  reduceOnly: boolean,
): number {
  if (reduceOnly) {
    return Math.max(0, Math.abs(sziBefore) - Math.abs(sziAfter));
  }
  const delta = side === 'buy' ? sziAfter - sziBefore : sziBefore - sziAfter;
  return Math.max(0, delta);
}

export type ReconciledOrderFill = {
  sizeBase: number;
  fillPx: number;
  partialFill: boolean;
};

/** Prefer exchange szi delta; fall back to HL order status fill. */
export function reconcileOrderFill(params: {
  parsed: ParsedHlOrderFill | null;
  sziBefore: number;
  sziAfter: number;
  side: TwapSide;
  reduceOnly: boolean;
  markPx: number;
  requestedBase: number;
}): ReconciledOrderFill {
  const fromExchange = filledBaseFromSziDelta(
    params.sziBefore,
    params.sziAfter,
    params.side,
    params.reduceOnly,
  );
  const fromStatus = params.parsed?.filledBase ?? 0;
  const sizeBase = fromExchange > 0 ? fromExchange : fromStatus;
  const fillPx =
    fromExchange > 0 && params.parsed && params.parsed.avgPx > 0
      ? params.parsed.avgPx
      : params.parsed?.avgPx && params.parsed.avgPx > 0
        ? params.parsed.avgPx
        : params.markPx;
  const partialFill =
    params.requestedBase > 0 && sizeBase > 0 && sizeBase < params.requestedBase * 0.95;
  return { sizeBase, fillPx, partialFill };
}

/** Minimum gross fill vs requested (default 85% — reject half-slice partials). */
export function isOpenFillAcceptable(filledNotionalUsd: number, requestedGrossUsd: number): boolean {
  if (filledNotionalUsd <= 0 || requestedGrossUsd <= 0) return false;
  const v = process.env.HL_TWAP_LIVE_OPEN_MIN_FILL_RATIO?.trim();
  const ratio =
    v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1
      ? Number(v)
      : 0.85;
  const minUsd = Math.max(requestedGrossUsd * ratio, 50);
  return filledNotionalUsd >= minUsd;
}
