import type { HlOscarPerpConfig } from './config.js';
import { barsForMinutes, windowHighLow, type OscarCandle } from './candles.js';

export type OscarEntrySignal = {
  coin: string;
  barTs: number;
  signalPrice: number;
  dipPct: number;
  impulsePct: number;
  windowMin: number;
};

export function evaluateOscarEntry(
  cfg: HlOscarPerpConfig,
  coin: string,
  candles: OscarCandle[],
): OscarEntrySignal | null {
  if (candles.length < 2) return null;
  const i = candles.length - 1;
  const price = candles[i]!.close;
  const maxWinBars = barsForMinutes(Math.max(...cfg.dipLookbackWindowsMin));
  if (i < maxWinBars) return null;

  let passWindow: number | null = null;
  let dipPct: number | null = null;
  let impulsePct: number | null = null;

  for (const wMin of cfg.dipLookbackWindowsMin) {
    const bars = barsForMinutes(wMin);
    const { high, low } = windowHighLow(candles, i, bars);
    if (!(high > 0) || !(low > 0)) continue;
    const d = (price / high - 1) * 100;
    const imp = (high / low - 1) * 100;
    if (d > cfg.dipMinDropPct) continue;
    if (d < cfg.dipMaxDropPct) continue;
    if (imp < cfg.dipMinImpulsePct) continue;
    passWindow = wMin;
    dipPct = d;
    impulsePct = imp;
    break;
  }
  if (passWindow == null || dipPct == null || impulsePct == null) return null;

  return {
    coin,
    barTs: candles[i]!.ts,
    signalPrice: price,
    dipPct,
    impulsePct,
    windowMin: passWindow,
  };
}

export function cooldownBlocksEntry(
  lastEntryBarTs: number | undefined,
  currentBarTs: number,
  cooldownMin: number,
): boolean {
  if (lastEntryBarTs == null) return false;
  const cooldownMs = cooldownMin * 60_000;
  return currentBarTs - lastEntryBarTs < cooldownMs;
}
