/**
 * Wait-dip entry: on a main-band signal, park instead of buying; enter only
 * after price dumps another `waitDipPct` from the signal mark (default −7%).
 *
 * 48h CF: wait −7% then MFE-bank beat immediate hard TP/SL by ~$3k on $100/coin.
 */

import type { MildDipCandidateMetrics } from './gates.js';

export type WaitDipWatchEntry = {
  detectedAtMs: number;
  /** First qualifying signal mark — wait target is anchored here (never walks). */
  signalPriceUsd: number;
  /** Extra dump from signal, negative percent (e.g. −7). */
  waitDipPct: number;
  symbol: string;
  originalDipSource: string;
  metrics: MildDipCandidateMetrics;
  lastPriceUsd: number;
  lastAtMs: number;
  troughPriceUsd: number;
  troughAtMs: number;
};

export type WaitDipGates = {
  enabled: boolean;
  /** Extra dump from signal required before buy (negative, e.g. −7). */
  waitDipPct: number;
  /** Expire watch if never filled. */
  maxWatchMs: number;
};

export type WaitDipReadyVerdict = {
  ready: boolean;
  expire: boolean;
  dumpFromSignalPct: number | null;
  targetPriceUsd: number | null;
  reasons: string[];
};

/** Sources that park under wait-dip (not knife / mild_stabilize / already waiting). */
export function waitDipAppliesToSource(dipSource: string | null | undefined): boolean {
  return (
    dipSource === 'dex' ||
    dipSource === 'stream' ||
    dipSource === 'dex+stream' ||
    dipSource === 'h1_red_shallow' ||
    dipSource === 'flat_micro_dip'
  );
}

export function waitDipTargetPriceUsd(
  signalPriceUsd: number,
  waitDipPct: number,
): number | null {
  if (!(signalPriceUsd > 0) || !Number.isFinite(waitDipPct) || !(waitDipPct < 0)) {
    return null;
  }
  return signalPriceUsd * (1 + waitDipPct / 100);
}

/**
 * Create or refresh a wait-dip watch. Never moves signalPrice / detectedAt —
 * otherwise the −7% target would chase the blade forever.
 */
export function upsertWaitDipWatch(
  prev: WaitDipWatchEntry | undefined,
  obs: {
    nowMs: number;
    priceUsd: number;
    signalPriceUsd: number;
    waitDipPct: number;
    symbol: string;
    originalDipSource: string;
    metrics: MildDipCandidateMetrics;
  },
): WaitDipWatchEntry {
  if (!prev) {
    return {
      detectedAtMs: obs.nowMs,
      signalPriceUsd: obs.signalPriceUsd,
      waitDipPct: obs.waitDipPct,
      symbol: obs.symbol,
      originalDipSource: obs.originalDipSource,
      metrics: obs.metrics,
      lastPriceUsd: obs.priceUsd,
      lastAtMs: obs.nowMs,
      troughPriceUsd: obs.priceUsd,
      troughAtMs: obs.nowMs,
    };
  }
  const next: WaitDipWatchEntry = {
    ...prev,
    lastPriceUsd: obs.priceUsd,
    lastAtMs: obs.nowMs,
  };
  if (obs.priceUsd < prev.troughPriceUsd) {
    next.troughPriceUsd = obs.priceUsd;
    next.troughAtMs = obs.nowMs;
  }
  return next;
}

export function evaluateWaitDipReady(
  watch: WaitDipWatchEntry,
  gates: WaitDipGates,
  nowMs: number,
  freshPriceUsd?: number | null,
): WaitDipReadyVerdict {
  const reasons: string[] = [];
  if (!gates.enabled) {
    return {
      ready: false,
      expire: true,
      dumpFromSignalPct: null,
      targetPriceUsd: null,
      reasons: ['wait_dip_disabled'],
    };
  }
  const age = nowMs - watch.detectedAtMs;
  if (gates.maxWatchMs > 0 && age > gates.maxWatchMs) {
    return {
      ready: false,
      expire: true,
      dumpFromSignalPct: null,
      targetPriceUsd: waitDipTargetPriceUsd(watch.signalPriceUsd, gates.waitDipPct),
      reasons: [`wait_dip_expired_age=${Math.round(age / 1000)}s`],
    };
  }
  const px =
    freshPriceUsd != null && freshPriceUsd > 0 ? freshPriceUsd : watch.lastPriceUsd;
  const target = waitDipTargetPriceUsd(watch.signalPriceUsd, gates.waitDipPct);
  if (!(px > 0) || target == null) {
    reasons.push('wait_dip_missing_price');
    return {
      ready: false,
      expire: false,
      dumpFromSignalPct: null,
      targetPriceUsd: target,
      reasons,
    };
  }
  const dumpFromSignalPct = (px / watch.signalPriceUsd - 1) * 100;
  if (px <= target + 1e-15) {
    return {
      ready: true,
      expire: false,
      dumpFromSignalPct,
      targetPriceUsd: target,
      reasons: [],
    };
  }
  reasons.push(
    `wait_dip_need=${gates.waitDipPct}% have=${dumpFromSignalPct.toFixed(2)}%`,
  );
  return {
    ready: false,
    expire: false,
    dumpFromSignalPct,
    targetPriceUsd: target,
    reasons,
  };
}

export function priorityMintsFromWaitDipWatch(
  waitDipWatch: Record<string, WaitDipWatchEntry> | undefined,
): string[] {
  if (!waitDipWatch) return [];
  return Object.keys(waitDipWatch).filter((m) => m.length >= 32);
}
