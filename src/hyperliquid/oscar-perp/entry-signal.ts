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

export type OscarRecoveryVetoResult = {
  reasons: string[];
  bounces: Record<number, number>;
};

export type OscarLocalHighVetoResult = {
  reasons: string[];
  distanceFromHighPct: Record<number, number>;
};

export function evaluateRecoveryVeto(
  cfg: HlOscarPerpConfig,
  candles: OscarCandle[],
  i: number,
  price: number,
  dipLookbackUsedMin: number,
): OscarRecoveryVetoResult {
  const bounces: Record<number, number> = {};
  if (!cfg.recoveryVetoEnabled || cfg.recoveryVetoWindowsMin.length === 0) {
    return { reasons: [], bounces };
  }

  const reasons: string[] = [];
  const thr = cfg.recoveryVetoMaxBouncePct;

  for (const wMin of cfg.recoveryVetoWindowsMin) {
    if (wMin >= dipLookbackUsedMin) continue;
    const bars = barsForMinutes(wMin);
    const { low } = windowHighLow(candles, i, bars);
    if (!(low > 0)) continue;
    const bounce = (price / low - 1) * 100;
    bounces[wMin] = +bounce.toFixed(2);
    if (bounce >= thr) {
      reasons.push(`recovery_veto_${wMin}m_bounce${bounces[wMin]!.toFixed(1)}>=${thr}%`);
    }
  }

  return { reasons, bounces };
}

export function evaluateLocalHighVeto(
  cfg: HlOscarPerpConfig,
  candles: OscarCandle[],
  i: number,
  price: number,
): OscarLocalHighVetoResult {
  const distanceFromHighPct: Record<number, number> = {};
  if (!cfg.localHighVetoEnabled || cfg.localHighVetoWindowsMin.length === 0) {
    return { reasons: [], distanceFromHighPct };
  }
  if (!(price > 0)) {
    return { reasons: [], distanceFromHighPct };
  }

  const reasons: string[] = [];
  const thr = cfg.localHighVetoMaxDistancePct;

  for (const wMin of cfg.localHighVetoWindowsMin) {
    const bars = barsForMinutes(wMin);
    const { high } = windowHighLow(candles, i, bars);
    if (!(high > 0)) continue;
    const distance = Math.max(0, (high / price - 1) * 100);
    distanceFromHighPct[wMin] = +distance.toFixed(2);
    if (distance <= thr) {
      reasons.push(
        `local_high_veto_${wMin}m_dist${distanceFromHighPct[wMin]!.toFixed(1)}<=${thr}%`,
      );
    }
  }

  return { reasons, distanceFromHighPct };
}

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

  const recovery = evaluateRecoveryVeto(cfg, candles, i, price, passWindow);
  if (recovery.reasons.length > 0) return null;

  const localHigh = evaluateLocalHighVeto(cfg, candles, i, price);
  if (localHigh.reasons.length > 0) return null;

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
