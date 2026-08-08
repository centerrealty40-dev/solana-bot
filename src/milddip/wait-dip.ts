/**
 * Wait-dip entry: on a qualifying signal, park instead of buying; enter only
 * after price dumps another `waitDipPct` from the signal mark (default −7%).
 *
 * 48h CF: wait −7% then MFE-bank ~+$3k on $100/coin. Branch CF: applying the
 * same wait to `knife_stabilize` / `mild_stabilize` beat main-band-only by
 * ~+$350 on the book (stabilize immediate was a weak exclusion).
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

/**
 * Sources that park under wait-dip.
 * All live entry branches wait; only `wait_dip` itself is excluded (already parked).
 */
export function waitDipAppliesToSource(dipSource: string | null | undefined): boolean {
  if (!dipSource || dipSource === 'wait_dip') return false;
  return (
    dipSource === 'dex' ||
    dipSource === 'stream' ||
    dipSource === 'dex+stream' ||
    dipSource === 'h1_red_shallow' ||
    dipSource === 'flat_micro_dip' ||
    dipSource === 'knife_stabilize' ||
    dipSource === 'mild_stabilize'
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
 * Hard ceiling for send/fill: signal × (1 + (waitDipPct + overshoot)/100).
 * Example: wait −7%, overshoot +2pp → max price = signal × 0.95 (fill dump ≤ −5%).
 */
export function waitDipMaxPriceUsd(
  signalPriceUsd: number,
  waitDipPct: number,
  maxOvershootPct: number,
): number | null {
  if (!(signalPriceUsd > 0) || !Number.isFinite(waitDipPct) || !(waitDipPct < 0)) {
    return null;
  }
  const overshoot = Number.isFinite(maxOvershootPct) ? Math.max(0, maxOvershootPct) : 0;
  const maxDumpPct = waitDipPct + overshoot;
  // Still require a dump (never allow buy above signal via overshoot alone).
  if (!(maxDumpPct < 0)) return signalPriceUsd * (1 + waitDipPct / 100);
  return signalPriceUsd * (1 + maxDumpPct / 100);
}

export function dumpFromSignalPct(
  priceUsd: number,
  signalPriceUsd: number,
): number | null {
  if (!(priceUsd > 0) || !(signalPriceUsd > 0)) return null;
  return (priceUsd / signalPriceUsd - 1) * 100;
}

/**
 * Pre-send gate for wait_dip: keep the −7% edge after mark→quote drift.
 * Anchors to the original park signal (not the ready mark).
 */
export function evaluateWaitDipPreBuy(args: {
  signalPriceUsd: number;
  readyMarkPriceUsd: number;
  freshPriceUsd: number | null;
  waitDipPct: number;
  /** Percentage points of dump edge we may give up vs waitDipPct (default 2). */
  maxOvershootPct: number;
  /** Extra chase vs ready mark only (default 3). */
  maxChaseFromReadyPct: number;
}): {
  pass: boolean;
  reasons: string[];
  dumpFromSignalPct: number | null;
  maxPriceUsd: number | null;
} {
  const {
    signalPriceUsd,
    readyMarkPriceUsd,
    freshPriceUsd,
    waitDipPct,
    maxOvershootPct,
    maxChaseFromReadyPct,
  } = args;
  const reasons: string[] = [];
  if (freshPriceUsd == null || !(freshPriceUsd > 0)) {
    return {
      pass: false,
      reasons: ['wait_dip_prebuy_missing_price'],
      dumpFromSignalPct: null,
      maxPriceUsd: null,
    };
  }
  const maxPriceUsd = waitDipMaxPriceUsd(signalPriceUsd, waitDipPct, maxOvershootPct);
  const dumpPct = dumpFromSignalPct(freshPriceUsd, signalPriceUsd);
  if (maxPriceUsd == null || dumpPct == null) {
    return {
      pass: false,
      reasons: ['wait_dip_prebuy_bad_signal'],
      dumpFromSignalPct: dumpPct,
      maxPriceUsd,
    };
  }
  if (freshPriceUsd > maxPriceUsd + 1e-15) {
    reasons.push(
      `wait_dip_ceiling=${dumpPct.toFixed(2)}%>max=${(waitDipPct + Math.max(0, maxOvershootPct)).toFixed(2)}%` +
        `_px=${freshPriceUsd}>max=${maxPriceUsd}`,
    );
  }
  if (
    maxChaseFromReadyPct > 0 &&
    readyMarkPriceUsd > 0 &&
    freshPriceUsd > readyMarkPriceUsd * (1 + maxChaseFromReadyPct / 100) + 1e-15
  ) {
    const chasePct = (freshPriceUsd / readyMarkPriceUsd - 1) * 100;
    reasons.push(
      `wait_dip_chase_ready=${chasePct.toFixed(2)}%>max=${maxChaseFromReadyPct}`,
    );
  }
  return {
    pass: reasons.length === 0,
    reasons,
    dumpFromSignalPct: dumpPct,
    maxPriceUsd,
  };
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
