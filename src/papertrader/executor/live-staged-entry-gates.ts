import type { PaperTraderConfig } from '../config.js';
import {
  cancelAllPendingEntrySplitLegs,
  entrySplitLegDoneFromState,
  entrySplitLegTsFromState,
  entrySplitLegUsdFromState,
  entrySplitTimedLegIndices,
  setEntrySplitLegDone,
  setEntrySplitLegTs,
  type EntrySplitLegIndex,
} from '../entry-split-legs.js';
import {
  applyCanonicalStagedEntrySizing,
  resolveLiveOscarEntrySplitLeg2Usd,
  resolveLiveOscarEntrySplitLeg3Usd,
  resolveLiveOscarEntrySplitLeg4Usd,
  resolveLiveOscarEntrySplitLeg5Usd,
  resolveLiveOscarEntrySplitLeg6Usd,
  resolveLiveOscarEntrySplitLeg7Usd,
  resolveLiveOscarEntrySplitLegUsd,
  resolveLiveOscarStagedAvgFirstDropPct,
  resolveLiveOscarStagedAvgLegUsd,
  resolveLiveOscarStagedAvgSecondDropPct,
  resolveLiveOscarStagedAvgSecondLegUsd,
  resolveLiveOscarStagedEntryMaxUsd,
  resolveLiveOscarTradeTierFromMcap,
} from '../live-oscar-entry-sizing.js';
import type { LiveOscarTradeTier } from '../live-oscar-mcap-tier.js';
import type { LiveStagedEntryState, OpenTrade } from '../types.js';
export function liveStagedEntrySignalTtlEnabled(
  cfg: Pick<PaperTraderConfig, 'liveStagedEntrySignalTtlMs'>,
): boolean {
  return cfg.liveStagedEntrySignalTtlMs > 0;
}

export function liveStagedEntrySignalTimeWindowOpen(
  cfg: Pick<PaperTraderConfig, 'liveStagedEntrySignalTtlMs'>,
  signalTs: number,
  nowMs: number,
): boolean {
  if (!liveStagedEntrySignalTtlEnabled(cfg)) return true;
  return nowMs <= signalTs + cfg.liveStagedEntrySignalTtlMs;
}

export function liveStagedEntrySignalTtlExpired(
  cfg: Pick<PaperTraderConfig, 'liveStagedEntrySignalTtlMs'>,
  signalTs: number,
  nowMs: number,
): boolean {
  if (!liveStagedEntrySignalTtlEnabled(cfg)) return false;
  return nowMs > signalTs + cfg.liveStagedEntrySignalTtlMs;
}

export function liveStagedEntrySignalExpiresAt(
  cfg: Pick<PaperTraderConfig, 'liveStagedEntrySignalTtlMs'>,
  signalTs: number,
): number {
  if (!liveStagedEntrySignalTtlEnabled(cfg)) return Number.MAX_SAFE_INTEGER;
  return signalTs + cfg.liveStagedEntrySignalTtlMs;
}

export type StagedEntrySignalAnchor = {
  signalTs: number;
  signalPriceUsd: number;
  signalMarketCapUsd: number | null;
  holderCount: number | null;
  expiresAt: number;
};

/** Pure plan for staged-entry anchor: fresh create, wait on existing, TTL clear, or blocked. */
export type StagedEntrySignalPlan =
  | { action: 'use_existing'; signal: StagedEntrySignalAnchor }
  | { action: 'create_new'; signal: StagedEntrySignalAnchor }
  | { action: 'ttl_expired_clear'; expired: StagedEntrySignalAnchor }
  | { action: 'blocked_no_anchor' };

export function planLiveStagedEntrySignalResolution(args: {
  existing: StagedEntrySignalAnchor | undefined;
  now: number;
  currentPriceUsd: number;
  marketCapUsd: number | null;
  holderCount: number | null;
  reanchorBlocked: boolean;
  cfg: Pick<PaperTraderConfig, 'liveStagedEntrySignalTtlMs'>;
}): StagedEntrySignalPlan {
  const { existing, now, reanchorBlocked, cfg } = args;

  if (existing && existing.expiresAt <= now) {
    if (reanchorBlocked) {
      return { action: 'use_existing', signal: existing };
    }
    return { action: 'ttl_expired_clear', expired: existing };
  }

  if (!existing) {
    if (reanchorBlocked) return { action: 'blocked_no_anchor' };
    const signal: StagedEntrySignalAnchor = {
      signalTs: now,
      signalPriceUsd: args.currentPriceUsd,
      signalMarketCapUsd: args.marketCapUsd,
      holderCount: args.holderCount,
      expiresAt: liveStagedEntrySignalExpiresAt(cfg, now),
    };
    return { action: 'create_new', signal };
  }

  return { action: 'use_existing', signal: existing };
}

/** % change from anchor: +3 max, −10 min (inclusive). */
export function entrySplitBandOk(changePctFromAnchor: number, maxUpPct: number, maxDownPct: number): boolean {
  return changePctFromAnchor <= maxUpPct && changePctFromAnchor >= -maxDownPct;
}

/** Leg-2 entry split: dip-at-signal mode or timed delay+corridor from signal anchor. */
export function entrySplitLeg2Eligible(args: {
  st: LiveStagedEntryState;
  signalDropPct: number | null;
  nowMs: number;
  entrySplitPx: number;
  anchorUsd: number;
}): { ok: boolean; triggerPct: number } {
  return entrySplitTimedLegEligible({
    ...args,
    legIndex: 2,
  });
}

/** Leg-3 timed entry split (backward-compat wrapper). */
export function entrySplitLeg3Eligible(args: {
  st: LiveStagedEntryState;
  signalDropPct: number | null;
  nowMs: number;
  entrySplitPx: number;
  anchorUsd: number;
}): { ok: boolean; triggerPct: number } {
  return entrySplitTimedLegEligible({ ...args, legIndex: 3 });
}

/** Timed entry split legs 2–7: `(legIndex−1)` × delay from leg-1, corridor vs signal anchor. */
export function entrySplitTimedLegEligible(args: {
  st: LiveStagedEntryState;
  signalDropPct: number | null;
  nowMs: number;
  entrySplitPx: number;
  anchorUsd: number;
  legIndex: EntrySplitLegIndex;
}): { ok: boolean; triggerPct: number } {
  const { st, signalDropPct, nowMs, entrySplitPx, anchorUsd, legIndex } = args;
  if (legIndex < 2 || legIndex > 7) return { ok: false, triggerPct: 0 };
  const targetDrop = st.entrySplitTargetDropPct ?? 0;
  if (targetDrop > 0) {
    if (legIndex !== 2) return { ok: false, triggerPct: 0 };
    if (signalDropPct == null) return { ok: false, triggerPct: 0 };
    if (signalDropPct <= -targetDrop) return { ok: true, triggerPct: signalDropPct / 100 };
    return { ok: false, triggerPct: 0 };
  }
  const leg1Ts = st.entrySplitLeg1Ts ?? st.signalTs;
  const delay = st.entrySplitDelayMs ?? 10_000;
  const prevLegIndex = (legIndex - 1) as EntrySplitLegIndex;
  const prevTs = entrySplitLegTsFromState(st, prevLegIndex) ?? leg1Ts + (legIndex - 2) * delay;
  const readyTs = prevTs + delay;
  if (nowMs < readyTs) return { ok: false, triggerPct: 0 };
  const ch = pctFromAnchor(anchorUsd, entrySplitPx);
  const maxUp = st.entrySplitMaxUpPct ?? 3;
  const maxDown = st.entrySplitMaxDownPct ?? 5;
  if (ch != null && entrySplitBandOk(ch, maxUp, maxDown)) return { ok: true, triggerPct: ch / 100 };
  return { ok: false, triggerPct: 0 };
}

/** Stop pending entry-split legs after TP-ladder partial or first staged avg fill. */
export function entrySplitCorridorBlocked(ot: OpenTrade): boolean {
  if (ot.partialSells.some((p) => p.reason === 'TP_LADDER')) return true;
  const st = ot.liveStagedEntry;
  if (!st) return false;
  return st.avgFirstLegDone === true || ot.legs.some((l) => l.reason === 'staged_avg');
}

export function cancelPendingEntrySplitLegs(st: LiveStagedEntryState): void {
  cancelAllPendingEntrySplitLegs(st);
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

export function stagedAveragingConfigured(st: LiveStagedEntryState): boolean {
  return (
    (st.avgSecondLegUsd ?? st.secondLegUsd) > 0 || ((st.avgThirdLegUsd ?? st.thirdLegUsd ?? 0) > 0)
  );
}

/** Incomplete entry-split or staged-averaging legs on an open trade. */
export function liveStagedEntryHasPendingLegs(st: LiveStagedEntryState): boolean {
  if (st.entrySplitV2) {
    for (const legIndex of entrySplitTimedLegIndices()) {
      const legUsd = entrySplitLegUsdFromState(st, legIndex);
      if (legUsd > 0 && !entrySplitLegDoneFromState(st, legIndex)) return true;
    }
    if (!stagedAveragingConfigured(st)) return false;
    const avg1Usd = st.avgSecondLegUsd ?? st.secondLegUsd;
    const avg2Usd = st.avgThirdLegUsd ?? st.thirdLegUsd ?? 0;
    if (avg1Usd > 0 && !st.avgFirstLegDone) return true;
    if (avg2Usd > 0 && !st.avgSecondLegDone) return true;
    return false;
  }
  const hasThird = (st.thirdLegUsd ?? 0) > 0;
  const thirdDone = hasThird ? st.thirdLegDone === true : true;
  return !st.secondLegDone || !thirdDone;
}

/** On open position: do not TTL-clear `liveStagedEntry` while staged legs remain. */
export function liveStagedEntryTtlPreservesPlan(st: LiveStagedEntryState): boolean {
  return liveStagedEntryHasPendingLegs(st);
}

export function liveStagedEntryAddWindowOpen(args: {
  cfg: Pick<PaperTraderConfig, 'liveStagedEntrySignalTtlMs'>;
  st: LiveStagedEntryState;
  signalTs: number;
  nowMs: number;
}): boolean {
  if (liveStagedEntryHasPendingLegs(args.st)) return true;
  return liveStagedEntrySignalTimeWindowOpen(args.cfg, args.signalTs, args.nowMs);
}

export function buildLiveStagedEntryState(
  cfg: PaperTraderConfig,
  signal: {
    signalTs: number;
    signalPriceUsd: number;
  },
  options?: {
    firstMintProbe?: boolean;
    firstMintKillDropPct?: number;
    marketCapUsd?: number | null;
  },
): LiveStagedEntryState {
  const firstMintProbe = options?.firstMintProbe === true;
  const mcap = options?.marketCapUsd;
  const tier = resolveLiveOscarTradeTierFromMcap(cfg, mcap);
  const splitLeg = resolveLiveOscarEntrySplitLegUsd(cfg, tier, mcap);
  const splitLeg2 = resolveLiveOscarEntrySplitLeg2Usd(cfg, tier, mcap);
  const splitLeg3 = resolveLiveOscarEntrySplitLeg3Usd(cfg, tier, mcap);
  const splitLeg4 = resolveLiveOscarEntrySplitLeg4Usd(cfg, tier, mcap);
  const splitLeg5 = resolveLiveOscarEntrySplitLeg5Usd(cfg, tier, mcap);
  const splitLeg6 = resolveLiveOscarEntrySplitLeg6Usd(cfg, tier, mcap);
  const splitLeg7 = resolveLiveOscarEntrySplitLeg7Usd(cfg, tier, mcap);
  const killDropPct = firstMintProbe
    ? Math.min(50, Math.max(1, options?.firstMintKillDropPct ?? 7))
    : cfg.liveStagedEntryKillDropPct;
  const avgSecondUsd = firstMintProbe ? 0 : resolveLiveOscarStagedAvgLegUsd(cfg, tier, mcap);
  const avgThirdUsd = firstMintProbe ? 0 : resolveLiveOscarStagedAvgSecondLegUsd(cfg, tier, mcap);
  const avgSecondDrop = firstMintProbe ? 0 : resolveLiveOscarStagedAvgFirstDropPct(cfg, tier, mcap);
  const avgThirdDrop = firstMintProbe ? 0 : resolveLiveOscarStagedAvgSecondDropPct(cfg, tier, mcap);
  const st: LiveStagedEntryState = {
    signalTs: signal.signalTs,
    signalPriceUsd: signal.signalPriceUsd,
    firstDropPct: cfg.liveStagedEntryFirstDropPct,
    firstLegUsd: splitLeg,
    killDropPct,
    ...(firstMintProbe ? { mintFirstProbe: true } : {}),
    entrySplitV2: true,
    entrySplitLegUsd: splitLeg,
    entrySplitLeg2Usd: splitLeg2,
    entrySplitLeg3Usd: splitLeg3,
    entrySplitLeg4Usd: splitLeg4,
    entrySplitLeg5Usd: splitLeg5,
    entrySplitLeg6Usd: splitLeg6,
    entrySplitLeg7Usd: splitLeg7,
    entrySplitDelayMs: cfg.liveStagedEntryEntrySplitDelayMs,
    entrySplitMaxUpPct: cfg.liveStagedEntryEntrySplitMaxUpPct,
    entrySplitMaxDownPct: cfg.liveStagedEntryEntrySplitMaxDownPct,
    entrySplitTargetDropPct: cfg.liveStagedEntryEntrySplitTargetDropPct,
    entrySplitLeg1Ts: signal.signalTs,
    entrySplitAnchorUsd: signal.signalPriceUsd,
    entrySplitLeg2Done: splitLeg2 <= 0,
    entrySplitLeg3Done: splitLeg3 <= 0,
    entrySplitLeg4Done: splitLeg4 <= 0,
    entrySplitLeg5Done: splitLeg5 <= 0,
    entrySplitLeg6Done: splitLeg6 <= 0,
    entrySplitLeg7Done: splitLeg7 <= 0,
    avgSecondDropPct: avgSecondDrop,
    avgSecondLegUsd: avgSecondUsd,
    avgFirstCooldownMs: cfg.liveStagedEntryAvgCooldownMs,
    avgSecondCooldownMs: cfg.liveStagedEntryAvgSecondCooldownMs,
    avgFirstLegDone: false,
    avgSecondLegDone: false,
    ...(avgThirdUsd > 0
      ? {
          avgThirdDropPct: avgThirdDrop,
          avgThirdLegUsd: avgThirdUsd,
        }
      : {}),
    secondDropPct: avgSecondDrop,
    secondLegUsd: avgSecondUsd,
    secondLegDone: false,
    ...(avgThirdUsd > 0
      ? {
          thirdDropPct: avgThirdDrop,
          thirdLegUsd: avgThirdUsd,
          thirdLegDone: false,
        }
      : {}),
  };
  applyCanonicalStagedEntrySizing(cfg, st, tier, mcap);
  return st;
}

export function openNotionalUsdForStagedEntry(cfg: PaperTraderConfig): number {
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

export function stagedEntryPlanInvestedCapUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  return resolveLiveOscarStagedEntryMaxUsd(cfg, tier, marketCapUsd);
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
  for (let i = 0; i < entrySplitTimedLegIndices().length; i++) {
    const legIndex = entrySplitTimedLegIndices()[i]!;
    const legUsd = entrySplitLegUsdFromState(st, legIndex);
    if (legUsd <= 0) {
      setEntrySplitLegDone(st, legIndex, true);
    } else if (splitLegs.length >= i + 1) {
      setEntrySplitLegDone(st, legIndex, true);
      setEntrySplitLegTs(st, legIndex, splitLegs[i]!.ts);
    }
  }
  if (splitLegs.length > 0) {
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
