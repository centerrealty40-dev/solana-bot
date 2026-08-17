import type { LeaderSeedHit } from './discover-extra.js';

export const LEADER_MIRROR_WALLET = '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5';

export type LeaderMirrorDecision =
  | { action: 'wait' }
  | { action: 'buy'; quotePriceUsd: number }
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

export type LeaderMirrorGates = {
  enabled: boolean;
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
  cooldownMs: number;
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
    return { action: 'skip', reason: 'leader_mirror_no_data' };
  }
  if (gates.requireDeepDump && pc5m > gates.deepDumpPc5mPct) {
    return { action: 'skip', reason: 'leader_mirror_deep_dump_required' };
  }
  if (pc5m >= gates.runUpPc5mPct) {
    return { action: 'skip', reason: 'leader_mirror_run_up' };
  }
  if (pc5m > gates.maxPreEntryPc5mPct) {
    return { action: 'skip', reason: 'leader_mirror_pre_entry_floor' };
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
    return nowMs - args.watchStartedAtMs < gates.observeMs
      ? { action: 'wait' }
      : { action: 'skip', reason: 'leader_mirror_no_data' };
  }

  const leaderPrice = hit.fillPriceUsd;
  const quotePrice = args.quotePriceUsd;
  const quoteGainPct = (quotePrice / leaderPrice - 1) * 100;
  if (quoteGainPct >= gates.greenImpulsePct) {
    return { action: 'skip', reason: 'leader_mirror_green_impulse' };
  }
  if (quoteGainPct > gates.maxPremiumPct) {
    return nowMs - args.watchStartedAtMs < gates.observeMs
      ? { action: 'wait' }
      : { action: 'skip', reason: 'leader_mirror_premium_cap' };
  }
  return { action: 'buy', quotePriceUsd: quotePrice };
}
