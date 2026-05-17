import type { PaperTraderConfig } from '../config.js';
import type { LiveStagedEntryState, OpenTrade } from '../types.js';

/** % change from anchor: +3 max, −10 min (inclusive). */
export function entrySplitBandOk(changePctFromAnchor: number, maxUpPct: number, maxDownPct: number): boolean {
  return changePctFromAnchor <= maxUpPct && changePctFromAnchor >= -maxDownPct;
}

export function pctFromAnchor(anchorUsd: number, priceUsd: number): number | null {
  if (!(anchorUsd > 0) || !(priceUsd > 0)) return null;
  return (priceUsd / anchorUsd - 1) * 100;
}

export function signalDropPctFromState(st: LiveStagedEntryState, curMetric: number): number | null {
  if (!(st.signalPriceUsd > 0)) return null;
  return (curMetric / st.signalPriceUsd - 1) * 100;
}

/** First staged averaging (−7%): only after cooldown from split leg 1; drop strictly between −7% and −14% vs signal. */
export function stagedAvgFirstEligible(args: {
  st: LiveStagedEntryState;
  signalDropPct: number;
  nowMs: number;
}): boolean {
  const { st, signalDropPct, nowMs } = args;
  if (st.avgFirstLegDone) return false;
  const leg1Ts = st.entrySplitLeg1Ts ?? st.signalTs;
  const cd1 = st.avgFirstCooldownMs ?? 180_000;
  if (nowMs < leg1Ts + cd1) return false;
  const drop7 = st.avgSecondDropPct ?? st.secondDropPct;
  const drop14 = st.avgThirdDropPct ?? st.thirdDropPct;
  if (!(drop7 > 0)) return false;
  const lo = -drop7;
  const hi = drop14 != null && drop14 > 0 ? -drop14 : -99;
  return signalDropPct <= lo && signalDropPct > hi;
}

/** Second staged averaging (−14%): ≥5 min after first avg; drop at or below −14% vs signal. */
export function stagedAvgSecondEligible(args: {
  st: LiveStagedEntryState;
  signalDropPct: number;
  nowMs: number;
}): boolean {
  const { st, signalDropPct, nowMs } = args;
  if (!st.avgFirstLegDone || st.avgSecondLegDone) return false;
  const drop14 = st.avgThirdDropPct ?? st.thirdDropPct;
  const usd2 = st.avgThirdLegUsd ?? st.thirdLegUsd;
  if (drop14 == null || !(usd2 != null && usd2 > 0)) return false;
  const t0 = st.avgFirstLegTs;
  const cd2 = st.avgSecondCooldownMs ?? 300_000;
  if (t0 == null || nowMs < t0 + cd2) return false;
  return signalDropPct <= -drop14;
}

export function buildLiveStagedEntryState(cfg: PaperTraderConfig, signal: {
  signalTs: number;
  signalPriceUsd: number;
}): LiveStagedEntryState {
  const splitLeg = cfg.liveStagedEntryEntrySplitLegUsd;
  return {
    signalTs: signal.signalTs,
    signalPriceUsd: signal.signalPriceUsd,
    firstDropPct: cfg.liveStagedEntryFirstDropPct,
    firstLegUsd: splitLeg,
    killDropPct: cfg.liveStagedEntryKillDropPct,
    entrySplitV2: true,
    entrySplitLegUsd: splitLeg,
    entrySplitDelayMs: cfg.liveStagedEntryEntrySplitDelayMs,
    entrySplitMaxUpPct: cfg.liveStagedEntryEntrySplitMaxUpPct,
    entrySplitMaxDownPct: cfg.liveStagedEntryEntrySplitMaxDownPct,
    entrySplitLeg1Ts: signal.signalTs,
    entrySplitAnchorUsd: signal.signalPriceUsd,
    entrySplitLeg2Done: false,
    avgSecondDropPct: cfg.liveStagedEntrySecondDropPct,
    avgSecondLegUsd: cfg.liveStagedEntrySecondLegUsd,
    avgFirstCooldownMs: cfg.liveStagedEntryAvgCooldownMs,
    avgSecondCooldownMs: cfg.liveStagedEntryAvgSecondCooldownMs,
    avgFirstLegDone: false,
    avgSecondLegDone: false,
    ...(cfg.liveStagedEntryThirdLegUsd > 0
      ? {
          avgThirdDropPct: cfg.liveStagedEntryThirdDropPct,
          avgThirdLegUsd: cfg.liveStagedEntryThirdLegUsd,
        }
      : {}),
    secondDropPct: cfg.liveStagedEntrySecondDropPct,
    secondLegUsd: cfg.liveStagedEntrySecondLegUsd,
    secondLegDone: false,
    ...(cfg.liveStagedEntryThirdLegUsd > 0
      ? {
          thirdDropPct: cfg.liveStagedEntryThirdDropPct,
          thirdLegUsd: cfg.liveStagedEntryThirdLegUsd,
          thirdLegDone: false,
        }
      : {}),
  };
}

export function openNotionalUsdForStagedEntry(cfg: PaperTraderConfig): number {
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

export function stagedEntryPlanInvestedCapUsd(cfg: PaperTraderConfig): number {
  let sum = cfg.liveStagedEntryEntrySplitLegUsd * 2;
  sum += cfg.liveStagedEntrySecondLegUsd;
  if (cfg.liveStagedEntryThirdLegUsd > 0) sum += cfg.liveStagedEntryThirdLegUsd;
  return sum;
}

export function usesLegacyStagedAdds(st: LiveStagedEntryState): boolean {
  return st.entrySplitV2 !== true;
}

export function markEntrySplitLeg1Filled(st: LiveStagedEntryState, ot: OpenTrade): void {
  const leg = ot.legs[0];
  st.entrySplitLeg1Ts = leg?.ts ?? Date.now();
  st.entrySplitAnchorUsd = leg?.marketPrice ?? st.signalPriceUsd;
}

/**
 * Journal restore / PM2 reload may leave `entrySplitLeg2Done=false` while `legs[]` already
 * contains `entry_split` — prevents duplicate $500 "2-я нога" at flat price.
 */
export function reconcileEntrySplitV2FromLegs(ot: OpenTrade): void {
  const st = ot.liveStagedEntry;
  if (!st?.entrySplitV2) return;

  const splitLegs = ot.legs.filter((l) => l.reason === 'entry_split');
  if (splitLegs.length > 0) {
    st.entrySplitLeg2Done = true;
    const anchorFromOpen = ot.legs.find((l) => l.reason === 'open')?.marketPrice;
    if (!((st.entrySplitAnchorUsd ?? 0) > 0)) {
      st.entrySplitAnchorUsd = anchorFromOpen ?? st.signalPriceUsd;
    }
  }

  const avgLegs = ot.legs.filter((l) => l.reason === 'staged_avg');
  if (avgLegs.length >= 1) {
    st.avgFirstLegDone = true;
    st.avgFirstLegTs = avgLegs[0]!.ts;
    st.secondLegDone = true;
  }
  if (avgLegs.length >= 2) {
    st.avgSecondLegDone = true;
    st.thirdLegDone = true;
  }
}
