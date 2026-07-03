import type { HlOscarMajorsScalpConfig } from './config.js';
import { barsForMinutes, windowHighLow, type OscarCandle } from './candles.js';

export type ScalpEntrySignal = {
  coin: string;
  barTs: number;
  signalPrice: number;
  dipPct: number;
  windowMin: number;
  posIn24hRange: number | null;
};

/** Position within 24h range: 0 = at low, 1 = at high. */
export function posIn24hRange(candles: OscarCandle[], i: number): number | null {
  const bars = barsForMinutes(1440);
  if (i < bars) return null;
  const { high, low } = windowHighLow(candles, i, bars);
  if (!(high > low)) return null;
  const price = candles[i]!.close;
  return (price - low) / (high - low);
}

export function evaluateScalpEntry(
  cfg: HlOscarMajorsScalpConfig,
  coin: string,
  candles: OscarCandle[],
): ScalpEntrySignal | null {
  if (!cfg.enabled) return null;
  if (candles.length < 2) return null;

  const i = candles.length - 1;
  const price = candles[i]!.close;
  const bars = barsForMinutes(cfg.windowMin);
  if (i < bars) return null;

  const { high } = windowHighLow(candles, i, bars);
  if (!(high > 0)) return null;

  const dipPct = (price / high - 1) * 100;
  if (dipPct > cfg.dipPct) return null;

  const rangePos = posIn24hRange(candles, i);
  if (cfg.rangeMaxPct != null && rangePos != null && rangePos > cfg.rangeMaxPct) {
    return null;
  }

  return {
    coin,
    barTs: candles[i]!.ts,
    signalPrice: price,
    dipPct,
    windowMin: cfg.windowMin,
    posIn24hRange: rangePos,
  };
}
