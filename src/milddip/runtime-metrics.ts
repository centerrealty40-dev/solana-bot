/**
 * Process-lifetime counters for reconnect / enrich / tick RCA.
 * Exposed via ops heartbeat (vol-green) — do not treat every WS open as Helius reconnect.
 */
export type MildDipRuntimeMetrics = {
  processStartCount: number;
  wsOpenCount: number;
  wsClose1006Count: number;
  wsCloseOtherCount: number;
  wsReconnectBackoffCount: number;
  enrichOverBudgetCount: number;
  tickErrorCount: number;
  tickErrorsByCode: Record<string, number>;
  lastWsCloseCode: number | null;
  lastWsCloseAtMs: number | null;
  lastEnrichOverBudgetAtMs: number | null;
  lastTickErrorAtMs: number | null;
  lastTickErrorCode: string | null;
};

const metrics: MildDipRuntimeMetrics = {
  processStartCount: 0,
  wsOpenCount: 0,
  wsClose1006Count: 0,
  wsCloseOtherCount: 0,
  wsReconnectBackoffCount: 0,
  enrichOverBudgetCount: 0,
  tickErrorCount: 0,
  tickErrorsByCode: {},
  lastWsCloseCode: null,
  lastWsCloseAtMs: null,
  lastEnrichOverBudgetAtMs: null,
  lastTickErrorAtMs: null,
  lastTickErrorCode: null,
};

export function mildDipRuntimeMetrics(): MildDipRuntimeMetrics {
  return {
    ...metrics,
    tickErrorsByCode: { ...metrics.tickErrorsByCode },
  };
}

export function bumpProcessStart(): void {
  metrics.processStartCount += 1;
}

export function bumpWsOpen(): void {
  metrics.wsOpenCount += 1;
}

export function bumpWsClosed(code: number): void {
  metrics.lastWsCloseCode = code;
  metrics.lastWsCloseAtMs = Date.now();
  if (code === 1006) metrics.wsClose1006Count += 1;
  else metrics.wsCloseOtherCount += 1;
}

export function bumpWsReconnectBackoff(): void {
  metrics.wsReconnectBackoffCount += 1;
}

export function bumpEnrichOverBudget(): void {
  metrics.enrichOverBudgetCount += 1;
  metrics.lastEnrichOverBudgetAtMs = Date.now();
}

export function bumpTickError(err: unknown): void {
  metrics.tickErrorCount += 1;
  metrics.lastTickErrorAtMs = Date.now();
  let code = 'unknown';
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string' && c.trim()) code = c.trim().slice(0, 80);
  } else if (err instanceof Error) {
    const m = err.message.match(/Cannot find package[^']*'([^']+)'/);
    if (m?.[1]) code = `MODULE_NOT_FOUND:${m[1].split('/').slice(-2).join('/')}`;
    else if (err.message.includes('undici')) code = 'MODULE_NOT_FOUND:undici';
    else code = err.name || 'Error';
  }
  metrics.lastTickErrorCode = code;
  metrics.tickErrorsByCode[code] = (metrics.tickErrorsByCode[code] ?? 0) + 1;
}
