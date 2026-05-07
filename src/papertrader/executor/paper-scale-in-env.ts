/**
 * Параметры второй ноги scale-in для чистого paper (без `loadLiveOscarConfig`).
 * Читает те же `LIVE_ENTRY_SCALE_IN_*`, что и live-oscar.
 */
function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

export type PaperOscarScaleInEnv = {
  enabled: boolean;
  delayMs: number;
  corridorUpPct: number;
  corridorDownPct: number;
  maxSwapAttempts: number;
  retryBackoffMs: number;
};

export function readPaperOscarScaleInEnv(): PaperOscarScaleInEnv {
  const symCorridorPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_PCT?.trim();
    if (!s) return 3;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.1 ? Math.min(n, 50) : 3;
  })();
  const corridorUpPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT?.trim();
    if (!s) return symCorridorPct;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.01 ? Math.min(n, 50) : symCorridorPct;
  })();
  const corridorDownPct = (() => {
    const s = process.env.LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT?.trim();
    if (!s) return symCorridorPct;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0.01 ? Math.min(n, 50) : symCorridorPct;
  })();

  return {
    enabled: envBool(process.env.LIVE_ENTRY_SCALE_IN_ENABLED, false),
    delayMs: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_DELAY_MS?.trim();
      if (!s) return 30_000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 1000 ? Math.min(n, 600_000) : 30_000;
    })(),
    corridorUpPct,
    corridorDownPct,
    maxSwapAttempts: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS?.trim();
      if (!s) return 5;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : 5;
    })(),
    retryBackoffMs: (() => {
      const s = process.env.LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS?.trim();
      if (!s) return 2000;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 200 ? Math.min(n, 120_000) : 2000;
    })(),
  };
}
