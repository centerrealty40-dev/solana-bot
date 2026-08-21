import type { LeaderSeedHit } from './discover-extra.js';

export const LEADER_MIRROR_WALLET = '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5';

export type LeaderMirrorDecision =
  | { action: 'wait'; waitReason?: 'no_structural' | 'no_quote' | 'premium_cap' | 'green_corridor' | 'not_dip' | string }
  | { action: 'buy'; quotePriceUsd: number; mirrorBranch?: 'green' | 'dip' }
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
  return Math.min(8, Math.max(1, configuredCap), Math.max(1, activeWatchCount));
}

export type LeaderMirrorMetricSource = 'seed' | 'backfill';

export function leaderMirrorNeedsStructuralBackfill(hit: LeaderSeedHit): boolean {
  return (
    hit.pc5m == null ||
    !Number.isFinite(hit.pc5m) ||
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
};

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
  nowMs: number;
  watchStartedAtMs: number;
  gates: LeaderMirrorGates;
}): LeaderMirrorDecision {
  const { hit, gates, nowMs } = args;
  const pc5m = typeof hit.pc5m === 'number' && Number.isFinite(hit.pc5m) ? hit.pc5m : null;
  const liq = typeof hit.liq === 'number' && Number.isFinite(hit.liq) ? hit.liq : null;
  const ageHours = typeof hit.ageHours === 'number' && Number.isFinite(hit.ageHours) ? hit.ageHours : null;
  const mcap = typeof hit.mcap === 'number' && Number.isFinite(hit.mcap) ? hit.mcap : null;
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
  if (
    !finitePositive(hit.fillPriceUsd) ||
    pc5m == null ||
    liq == null ||
    ageHours == null ||
    mcap == null
  ) {
    return soft('leader_mirror_no_data', 'no_structural', true);
  }
  const greenCandidate = pc5m > gates.maxPreEntryPc5mPct;
  if (gates.greenCopyEnabled && greenCandidate) {
    if (pc5m >= gates.greenCopyMaxPc5mPct) {
      return { action: 'skip', reason: 'leader_mirror_green_blowoff' };
    }
  } else {
    if (gates.requireDeepDump && pc5m > gates.deepDumpPc5mPct) {
      return softQuality('leader_mirror_deep_dump_required');
    }
    if (pc5m >= gates.runUpPc5mPct) {
      return softQuality('leader_mirror_run_up');
    }
    if (pc5m > gates.maxPreEntryPc5mPct) {
      return softQuality('leader_mirror_pre_entry_floor');
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
  if (gates.greenCopyEnabled && greenCandidate) {
    if (quoteGainPct > gates.greenCorridorPct) {
      return soft('leader_mirror_green_corridor', 'green_corridor', true);
    }
    return { action: 'buy', quotePriceUsd: quotePrice, mirrorBranch: 'green' };
  }
  if (quoteGainPct >= gates.greenImpulsePct) {
    return gates.retryWhileLeaderHolds
      ? { action: 'wait', waitReason: 'premium_cap' }
      : { action: 'skip', reason: 'leader_mirror_green_impulse' };
  }
  if (quoteGainPct > gates.maxPremiumPct) {
    return soft('leader_mirror_premium_cap', 'premium_cap', true);
  }
  return { action: 'buy', quotePriceUsd: quotePrice };
}
