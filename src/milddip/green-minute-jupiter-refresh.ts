/**
 * Bounded Jupiter quote feed for GREEN minute-tape candidates.
 *
 * This is deliberately separate from the open-position mark refresh: GREEN
 * candidates are short-lived, capped, and write a distinct ring source.
 */
import { getSolUsd } from '../papertrader/pricing.js';
import { jupiterQuoteSellPriceUsd } from '../papertrader/pricing/price-verify.js';
import { mildDipPriceRing } from './price-ring.js';

type QuoteFn = (args: {
  mint: string;
  snapshotPriceUsd: number;
  tokenDecimals: number;
  probeUsd: number;
  slippageBps: number;
}) => Promise<number | null>;

type ActiveCandidate = {
  lastCandidateAtMs: number;
  lastAttemptAtMs: number;
  minGapMs: number;
  priority: number;
  snapshotPriceUsd: number;
  probeUsd: number;
  slippageBps: number;
  tokenDecimals: number;
  quote?: QuoteFn;
  source: 'green_jupiter' | 'leader_mirror_jupiter';
};

export type GreenMinuteJupiterStats = {
  activeMints: number;
  inFlight: number;
  quoteAttempts: number;
  quoteSuccesses: number;
  quoteErrors: number;
  capRejected: number;
};

const active = new Map<string, ActiveCandidate>();
const inFlight = new Set<string>();
const lastAttemptBySourceMint = new Map<string, number>();
const stats: GreenMinuteJupiterStats = {
  activeMints: 0,
  inFlight: 0,
  quoteAttempts: 0,
  quoteSuccesses: 0,
  quoteErrors: 0,
  capRejected: 0,
};

export function __resetGreenMinuteJupiterRefreshForTests(): void {
  active.clear();
  inFlight.clear();
  lastAttemptBySourceMint.clear();
  stats.activeMints = 0;
  stats.inFlight = 0;
  stats.quoteAttempts = 0;
  stats.quoteSuccesses = 0;
  stats.quoteErrors = 0;
  stats.capRejected = 0;
}

export function greenMinuteJupiterStats(
  nowMs = Date.now(),
  ttlMs = 600_000,
  source?: ActiveCandidate['source'],
): GreenMinuteJupiterStats {
  prune(nowMs, ttlMs, source);
  return {
    ...stats,
    activeMints: source
      ? [...active.values()].filter((candidate) => candidate.source === source).length
      : active.size,
    inFlight: inFlight.size,
  };
}

function prune(nowMs: number, ttlMs: number, source?: ActiveCandidate['source']): void {
  for (const [mint, candidate] of active) {
    if (source && candidate.source !== source) continue;
    if (nowMs - candidate.lastCandidateAtMs > Math.max(0, ttlMs)) {
      active.delete(mint);
    }
  }
  const memoryTtlMs = Math.max(30_000, ttlMs);
  for (const [key, lastAttemptAtMs] of lastAttemptBySourceMint) {
    if (nowMs - lastAttemptAtMs > memoryTtlMs) {
      lastAttemptBySourceMint.delete(key);
    }
  }
  stats.activeMints = active.size;
  stats.inFlight = inFlight.size;
}

async function defaultQuote(args: {
  mint: string;
  snapshotPriceUsd: number;
  tokenDecimals: number;
  probeUsd: number;
  slippageBps: number;
}): Promise<number | null> {
  const solUsd = getSolUsd();
  if (!(solUsd > 0)) return null;
  const verdict = await jupiterQuoteSellPriceUsd({
    mint: args.mint,
    tokenDecimals: args.tokenDecimals,
    usdNotional: args.probeUsd,
    solUsd,
    snapshotPriceUsd: args.snapshotPriceUsd,
    slippageBps: args.slippageBps,
    timeoutMs: 4_000,
  });
  return verdict.kind === 'ok' && verdict.jupiterPriceUsd > 0
    ? verdict.jupiterPriceUsd
    : null;
}

export async function fetchGreenMinuteJupiterQuote(args: {
  mint: string;
  snapshotPriceUsd: number;
  probeUsd: number;
  slippageBps: number;
  tokenDecimals?: number;
}): Promise<number | null> {
  return defaultQuote({
    mint: args.mint,
    snapshotPriceUsd: args.snapshotPriceUsd,
    probeUsd: args.probeUsd,
    slippageBps: args.slippageBps,
    tokenDecimals: args.tokenDecimals ?? mildDipPriceRing.mintDecimals(args.mint) ?? 6,
  });
}

/**
 * Register a currently evaluated GREEN candidate and, when due, start one
 * bounded quote. The caller invokes this on fast-path evaluation ticks.
 */
export function requestGreenMinuteJupiterRefresh(args: {
  mint: string;
  nowMs: number;
  snapshotPriceUsd: number;
  enabled: boolean;
  minGapMs: number;
  ttlMs: number;
  maxMints: number;
  maxInFlight: number;
  priority?: number;
  probeUsd: number;
  slippageBps: number;
  tokenDecimals?: number;
  quote?: QuoteFn;
  source?: 'green_jupiter' | 'leader_mirror_jupiter';
}): boolean {
  if (!args.enabled || !args.mint || args.mint.length < 32) return false;
  if (!(args.snapshotPriceUsd > 0)) return false;
  prune(args.nowMs, args.ttlMs, args.source ?? 'green_jupiter');
  let candidate = active.get(args.mint);
  if (!candidate) {
    if (args.maxMints > 0 && active.size >= Math.floor(args.maxMints)) {
      const replaceable = [...active.entries()]
        .filter(
          ([mint, incumbent]) =>
            !inFlight.has(mint) && incumbent.source === (args.source ?? 'green_jupiter'),
        )
        .sort(
          ([, a], [, b]) =>
            a.priority - b.priority || a.lastCandidateAtMs - b.lastCandidateAtMs,
        )[0];
      if (
        !replaceable ||
        args.priority == null ||
        args.priority <= replaceable[1].priority
      ) {
        stats.capRejected += 1;
        return false;
      }
      active.delete(replaceable[0]);
    }
    candidate = {
      lastCandidateAtMs: args.nowMs,
      lastAttemptAtMs:
        lastAttemptBySourceMint.get(
          `${args.source ?? 'green_jupiter'}:${args.mint}`,
        ) ?? 0,
      minGapMs: Math.max(0, args.minGapMs),
      priority: args.priority ?? 0,
      snapshotPriceUsd: args.snapshotPriceUsd,
      probeUsd: args.probeUsd,
      slippageBps: args.slippageBps,
      tokenDecimals: args.tokenDecimals ?? mildDipPriceRing.mintDecimals(args.mint) ?? 6,
      quote: args.quote,
      source: args.source ?? 'green_jupiter',
    };
    active.set(args.mint, candidate);
  } else {
    candidate.lastCandidateAtMs = args.nowMs;
  }
  candidate.snapshotPriceUsd = args.snapshotPriceUsd;
  candidate.minGapMs = Math.max(0, args.minGapMs);
  candidate.priority = args.priority ?? candidate.priority;
  candidate.probeUsd = args.probeUsd;
  candidate.slippageBps = args.slippageBps;
  candidate.tokenDecimals =
    args.tokenDecimals ?? mildDipPriceRing.mintDecimals(args.mint) ?? candidate.tokenDecimals;
  candidate.quote = args.quote;
  candidate.source = args.source ?? candidate.source;
  stats.activeMints = active.size;

  return startQuote(args.mint, candidate, candidate.minGapMs, args.maxInFlight, args.nowMs);
}

export function tickGreenMinuteJupiterRefresh(args: {
  nowMs: number;
  enabled: boolean;
  minGapMs: number;
  ttlMs: number;
  maxInFlight: number;
  graceMs: number;
}): void {
  if (!args.enabled) return;
  prune(args.nowMs, args.ttlMs);
  for (const [mint, candidate] of active) {
    if (args.nowMs - candidate.lastCandidateAtMs > Math.max(0, args.graceMs)) continue;
    startQuote(mint, candidate, candidate.minGapMs, args.maxInFlight, args.nowMs);
  }
}

export function releaseGreenMinuteJupiterRefresh(args: {
  source: ActiveCandidate['source'];
  keepMints: ReadonlySet<string>;
}): void {
  for (const [mint, candidate] of active) {
    if (candidate.source !== args.source || args.keepMints.has(mint)) continue;
    if (!inFlight.has(mint)) active.delete(mint);
  }
  stats.activeMints = active.size;
}

function startQuote(
  mint: string,
  candidate: ActiveCandidate,
  minGapMs: number,
  maxInFlight: number,
  nowMs: number,
): boolean {
  const minGap = Math.max(0, minGapMs);
  if (
    inFlight.has(mint) ||
    inFlight.size >= Math.max(1, Math.floor(maxInFlight)) ||
    nowMs - candidate.lastAttemptAtMs < minGap
  ) {
    return false;
  }
  candidate.lastAttemptAtMs = nowMs;
  lastAttemptBySourceMint.set(`${candidate.source}:${mint}`, nowMs);
  inFlight.add(mint);
  stats.inFlight = inFlight.size;
  stats.quoteAttempts += 1;
  const quote = candidate.quote ?? defaultQuote;
  void quote({
    mint,
    snapshotPriceUsd: candidate.snapshotPriceUsd,
    tokenDecimals: candidate.tokenDecimals,
    probeUsd: candidate.probeUsd,
    slippageBps: candidate.slippageBps,
  })
    .then((priceUsd) => {
      if (!(priceUsd != null && priceUsd > 0)) {
        stats.quoteErrors += 1;
        return;
      }
      stats.quoteSuccesses += 1;
      mildDipPriceRing.note(mint, priceUsd, {
        tsMs: Date.now(),
        source: candidate.source,
      });
    })
    .catch(() => {
      stats.quoteErrors += 1;
    })
    .finally(() => {
      inFlight.delete(mint);
      stats.inFlight = inFlight.size;
    });
  return true;
}
