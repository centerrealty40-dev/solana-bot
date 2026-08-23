import type { LeaderSeedHit } from './discover-extra.js';

export const LEADER_MIRROR_WALLET = '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5';

export type LeaderMirrorDecision =
  | { action: 'wait'; waitReason?: 'no_structural' | 'no_quote' | 'premium_cap' | 'green_corridor' | 'not_dip' | string }
  | {
      action: 'buy';
      quotePriceUsd: number;
      mirrorBranch?: 'green' | 'dip';
      knifeWait?: {
        enteredByDiscount: boolean;
        enteredByWindowExpiry: boolean;
        waitedMs: number;
        leaderPc5m: number;
        leaderFillPriceUsd: number;
      };
    }
  | { action: 'skip'; reason: string };

export function leaderMirrorHitKey(hit: LeaderSeedHit): string {
  return `${hit.lastSeenAtMs}:${hit.signature ?? ''}:${hit.fillPriceUsd ?? ''}`;
}

export function leaderMirrorDecisionSuppressed(args: {
  hit: LeaderSeedHit;
  hitKey: string;
  decidedAtMs: number;
  nowMs: number;
  cooldownMs: number;
}): boolean {
  return (
    leaderMirrorHitKey(args.hit) === args.hitKey &&
    args.cooldownMs > 0 &&
    args.nowMs - args.decidedAtMs < args.cooldownMs
  );
}

export function leaderMirrorQuoteMintsCap(
  activeWatchCount: number,
  configuredCap: number,
): number {
  return Math.min(32, Math.max(1, configuredCap), Math.max(1, activeWatchCount));
}

export type LeaderMirrorMetricSource = 'seed' | 'backfill';

export function leaderMirrorNeedsStructuralBackfill(
  hit: LeaderSeedHit,
  requireDipCandle = true,
): boolean {
  return (
    (requireDipCandle && (hit.pc5m == null || !Number.isFinite(hit.pc5m))) ||
    hit.liq == null ||
    !Number.isFinite(hit.liq) ||
    hit.ageHours == null ||
    !Number.isFinite(hit.ageHours) ||
    hit.mcap == null ||
    !Number.isFinite(hit.mcap)
  );
}

export type LeaderMirrorGates = {
  enabled: boolean;
  greenCopyEnabled: boolean;
  greenCorridorPct: number;
  greenCopyMaxPc5mPct: number;
  leaders: string[];
  hitMaxAgeMs: number;
  observeMs: number;
  quoteMaxAgeMs: number;
  greenImpulsePct: number;
  runUpPc5mPct: number;
  maxPremiumPct: number;
  entryGraceMs?: number;
  entryGraceMaxPremiumPct?: number;
  maxEntryPc5mPct: number;
  maxPreEntryPc5mPct: number;
  requireDeepDump: boolean;
  deepDumpPc5mPct: number;
  minLiquidityUsd: number;
  minPairAgeHours: number;
  minMcapUsd: number;
  maxOpen: number;
  maxQuoteMints: number;
  tickIntervalMs: number;
  structuralMaxMints: number;
  structuralGapMs: number;
  cooldownMs: number;
  retryWhileLeaderHolds?: boolean;
  requireDipCandle?: boolean;
  leaderFillGraceMs?: number;
  minLeaderSizeUsd?: number;
  knifeWaitEnabled: boolean;
  knifeWaitPc5mPct: number;
  knifeWaitDiscountPct: number;
  knifeWaitWindowMs: number;
};

export function leaderMirrorObservationWindowMs(gates: Pick<
  LeaderMirrorGates,
  'observeMs' | 'knifeWaitEnabled' | 'knifeWaitWindowMs' | 'tickIntervalMs'
>): number {
  return Math.max(
    gates.observeMs,
    gates.knifeWaitEnabled
      ? gates.knifeWaitWindowMs + Math.max(1, gates.tickIntervalMs)
      : 0,
  );
}

function finitePositive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function leaderMirrorWalletAllowed(
  hit: LeaderSeedHit,
  leaders: readonly string[],
): boolean {
  return hit.leader != null && leaders.includes(hit.leader);
}

export function evaluateLeaderMirrorObservation(args: {
  hit: LeaderSeedHit;
  quotePriceUsd?: number | null;
  quoteTsMs?: number | null;
  leaderBuyTsMs?: number | null;
  nowMs: number;
  watchStartedAtMs: number;
  gates: LeaderMirrorGates;
}): LeaderMirrorDecision {
  const { hit, gates, nowMs } = args;
  const pc5m = typeof hit.pc5m === 'number' && Number.isFinite(hit.pc5m) ? hit.pc5m : null;
  const liq = typeof hit.liq === 'number' && Number.isFinite(hit.liq) ? hit.liq : null;
  const ageHours = typeof hit.ageHours === 'number' && Number.isFinite(hit.ageHours) ? hit.ageHours : null;
  const mcap = typeof hit.mcap === 'number' && Number.isFinite(hit.mcap) ? hit.mcap : null;
  const requireDipCandle = gates.requireDipCandle !== false;
  const leaderFillGraceMs = Math.max(0, gates.leaderFillGraceMs ?? 60_000);
  const entryGraceMs = Math.max(0, gates.entryGraceMs ?? 60_000);
  const entryGraceMaxPremiumPct = gates.entryGraceMaxPremiumPct ?? 1;
  const soft = (reason: string, waitReason: 'no_structural' | 'no_quote' | 'premium_cap' | 'green_corridor', transient = false): LeaderMirrorDecision =>
    gates.retryWhileLeaderHolds
      ? { action: 'wait', waitReason }
      : transient && nowMs - args.watchStartedAtMs < gates.observeMs
        ? { action: 'wait', waitReason }
        : { action: 'skip', reason };
  const softQuality = (reason: string, waitReason: 'not_dip' = 'not_dip'): LeaderMirrorDecision =>
    gates.retryWhileLeaderHolds
      ? { action: 'wait', waitReason }
      : { action: 'skip', reason };
  if (!gates.enabled) return { action: 'skip', reason: 'leader_mirror_disabled' };
  if (!leaderMirrorWalletAllowed(hit, gates.leaders)) {
    return { action: 'skip', reason: 'leader_mirror_wallet' };
  }
  if (hit.isAdd === true) return { action: 'skip', reason: 'leader_mirror_add' };
  if (!finitePositive(hit.fillPriceUsd)) {
    const blockTimeMs =
      typeof hit.blockTime === 'number' && Number.isFinite(hit.blockTime) && hit.blockTime > 0
        ? hit.blockTime * 1000
        : null;
    if (blockTimeMs != null && nowMs - blockTimeMs < leaderFillGraceMs) {
      return { action: 'wait', waitReason: 'no_structural' };
    }
    return { action: 'skip', reason: 'leader_mirror_no_leader_fill' };
  }
  if (
    (gates.minLeaderSizeUsd ?? 0) > 0 &&
    hit.sizeUsd != null &&
    Number.isFinite(hit.sizeUsd) &&
    hit.sizeUsd < gates.minLeaderSizeUsd!
  ) {
    return { action: 'skip', reason: 'leader_mirror_leader_size_floor' };
  }
  if (liq == null || ageHours == null || mcap == null) {
    return soft('leader_mirror_no_data', 'no_structural', true);
  }
  if (pc5m != null && pc5m > gates.maxEntryPc5mPct) {
    return { action: 'skip', reason: 'leader_mirror_green_direction' };
  }
  const greenCandidate = pc5m != null && pc5m > gates.maxPreEntryPc5mPct;
  if (requireDipCandle && pc5m != null) {
    if (gates.greenCopyEnabled && greenCandidate) {
      if (pc5m! >= gates.greenCopyMaxPc5mPct) {
        return { action: 'skip', reason: 'leader_mirror_green_blowoff' };
      }
    } else {
      if (gates.requireDeepDump && pc5m! > gates.deepDumpPc5mPct) {
        return softQuality('leader_mirror_deep_dump_required');
      }
      if (pc5m! >= gates.runUpPc5mPct) {
        return softQuality('leader_mirror_run_up');
      }
      if (pc5m! > gates.maxPreEntryPc5mPct) {
        return softQuality('leader_mirror_pre_entry_floor');
      }
    }
  }
  if (liq < gates.minLiquidityUsd) {
    return { action: 'skip', reason: 'leader_mirror_liquidity_floor' };
  }
  if (ageHours < gates.minPairAgeHours) {
    return { action: 'skip', reason: 'leader_mirror_pair_age_floor' };
  }
  if (mcap < gates.minMcapUsd) {
    return { action: 'skip', reason: 'leader_mirror_mcap_floor' };
  }
  if (
    args.quotePriceUsd == null ||
    !finitePositive(args.quotePriceUsd) ||
    args.quoteTsMs == null ||
    !Number.isFinite(args.quoteTsMs) ||
    gates.quoteMaxAgeMs <= 0 ||
    nowMs - args.quoteTsMs > gates.quoteMaxAgeMs
  ) {
    return soft('leader_mirror_no_data', 'no_quote', true);
  }

  const leaderPrice = hit.fillPriceUsd;
  const quotePrice = args.quotePriceUsd;
  const quoteGainPct = (quotePrice / leaderPrice - 1) * 100;
  const leaderAgeMs =
    (args.leaderBuyTsMs != null && Number.isFinite(args.leaderBuyTsMs)
      ? args.leaderBuyTsMs
      : hit.blockTime != null && Number.isFinite(hit.blockTime) && hit.blockTime > 0
        ? hit.blockTime * 1000
        : null) != null
      ? nowMs -
        (args.leaderBuyTsMs != null && Number.isFinite(args.leaderBuyTsMs)
          ? args.leaderBuyTsMs
          : hit.blockTime! * 1000)
      : null;
  const knifeWaitActive =
    gates.knifeWaitEnabled &&
    pc5m != null &&
    (pc5m <= gates.knifeWaitPc5mPct || pc5m >= 0) &&
    leaderAgeMs != null &&
    leaderAgeMs >= 0 &&
    leaderAgeMs < gates.knifeWaitWindowMs;
  const knifeWaitPassed =
    knifeWaitActive && quoteGainPct <= -Math.abs(gates.knifeWaitDiscountPct);
  const knifeWaitMetadata =
    knifeWaitPassed && pc5m != null && leaderAgeMs != null
      ? {
          enteredByDiscount: true,
          enteredByWindowExpiry: false,
          waitedMs: Math.max(0, leaderAgeMs),
          leaderPc5m: pc5m,
          leaderFillPriceUsd: leaderPrice,
        }
      : undefined;
  if (knifeWaitActive && !knifeWaitPassed && quoteGainPct > -Math.abs(gates.knifeWaitDiscountPct)) {
    return { action: 'wait', waitReason: 'knife_discount' };
  }
  const knifeWaitExpired =
    gates.knifeWaitEnabled &&
    pc5m != null &&
    (pc5m <= gates.knifeWaitPc5mPct || pc5m >= 0) &&
    leaderAgeMs != null &&
    leaderAgeMs >= gates.knifeWaitWindowMs;
  const expiredKnifeWaitMetadata =
    knifeWaitExpired && leaderAgeMs != null
      ? {
          enteredByDiscount: false,
          enteredByWindowExpiry: true,
          waitedMs: Math.max(0, leaderAgeMs),
          leaderPc5m: pc5m!,
          leaderFillPriceUsd: leaderPrice,
        }
      : knifeWaitMetadata;
  const entryGraceActive =
    leaderAgeMs != null && leaderAgeMs >= 0 && leaderAgeMs <= entryGraceMs;
  const maxPremiumPct = entryGraceActive
    ? entryGraceMaxPremiumPct
    : gates.maxPremiumPct;
  if (requireDipCandle && gates.greenCopyEnabled && greenCandidate) {
    if (quoteGainPct > gates.greenCorridorPct) {
      return soft('leader_mirror_green_corridor', 'green_corridor', true);
    }
    return {
      action: 'buy',
      quotePriceUsd: quotePrice,
      mirrorBranch: 'green',
      ...(expiredKnifeWaitMetadata ? { knifeWait: expiredKnifeWaitMetadata } : {}),
    };
  }
  if (requireDipCandle && quoteGainPct >= gates.greenImpulsePct) {
    return gates.retryWhileLeaderHolds
      ? { action: 'wait', waitReason: 'premium_cap' }
      : { action: 'skip', reason: 'leader_mirror_green_impulse' };
  }
  if (quoteGainPct > maxPremiumPct) {
    return soft('leader_mirror_premium_cap', 'premium_cap', true);
  }
  return {
    action: 'buy',
    quotePriceUsd: quotePrice,
    ...(expiredKnifeWaitMetadata ? { knifeWait: expiredKnifeWaitMetadata } : {}),
  };
}
