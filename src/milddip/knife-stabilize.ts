/**
 * Deep-knife wait branch: when drawdown is in (−50, −20], do not buy the
 * falling blade. Watch ~2 minutes; enter only if the knife stabilizes near
 * the trough or starts a controlled bounce.
 */

export type KnifeWatchEntry = {
  detectedAtMs: number;
  /** Most-negative dip % observed while watching (e.g. −35). */
  knifeDipPct: number;
  peakPriceUsd: number;
  troughPriceUsd: number;
  troughAtMs: number;
  lastPriceUsd: number;
  lastAtMs: number;
  /** Set once when we first emit knife_ready (journal de-dupe). */
  readyNotifiedAtMs?: number;
};

export function knifeStabilizeDeepEntryGates(args: {
  deepEntryEnabled: boolean;
  entryMinDipPct: number;
  entryMaxDipPct: number;
  knifeMinDipPct: number;
  knifeMaxDipPct: number;
}): { minDipPct: number; maxDipPct: number } {
  if (!args.deepEntryEnabled) {
    return { minDipPct: args.entryMinDipPct, maxDipPct: args.entryMaxDipPct };
  }
  return {
    minDipPct: Math.min(args.knifeMinDipPct, args.entryMinDipPct),
    maxDipPct: Math.max(args.knifeMaxDipPct, args.entryMaxDipPct),
  };
}

export function knifeStabilizeMaxPc1hPct(args: {
  deepEntryEnabled: boolean;
  knifeMaxPc1hPct: number;
  entryOwnMaxPc1hPct: number;
}): number {
  return args.deepEntryEnabled && args.knifeMaxPc1hPct >= 0
    ? args.knifeMaxPc1hPct
    : args.entryOwnMaxPc1hPct;
}

export function knifeStabilizeBypassesTurnDump(args: {
  deepEntryEnabled: boolean;
  dipSource: string;
}): boolean {
  return args.deepEntryEnabled && args.dipSource === 'knife_stabilize';
}

export type KnifeStabilizeGates = {
  enabled: boolean;
  /** Inclusive-ish deep bound — e.g. −50 ⇒ dip must be > −50. */
  minDipPct: number;
  /** Shallow bound of the knife — e.g. −20 ⇒ dip must be ≤ −20. */
  maxDipPct: number;
  /** Minimum watch time before a buy is allowed. */
  waitMs: number;
  /** Expire the watch if never ready. */
  maxWatchMs: number;
  /** No new trough for this long ⇒ quiet / stabilizing. */
  quietMs: number;
  /** Holding within this % of trough counts as stabilize (after quiet). */
  stabilizeBandPct: number;
  /** Minimum bounce % off trough to count as “starts bouncing”. */
  minBouncePct: number;
  /** Max bounce % off trough — beyond this the entry is chased. */
  maxBouncePct: number;
};

export type KnifeReadyVerdict = {
  ready: boolean;
  /** Drop watch (chased / expired / too deep). */
  expire: boolean;
  mode: 'bounce' | 'stabilize' | null;
  bouncePct: number | null;
  reasons: string[];
};

export function isKnifeDipPct(
  dipPct: number | null | undefined,
  gates: Pick<KnifeStabilizeGates, 'minDipPct' | 'maxDipPct'>,
): boolean {
  if (dipPct == null || !Number.isFinite(dipPct)) return false;
  return dipPct > gates.minDipPct && dipPct <= gates.maxDipPct;
}

export function bounceFromTroughPct(
  priceUsd: number,
  troughPriceUsd: number,
): number | null {
  if (!(priceUsd > 0) || !(troughPriceUsd > 0)) return null;
  return (priceUsd / troughPriceUsd - 1) * 100;
}

/**
 * Create or refresh a knife watch from a fresh observation.
 * Deepens trough / knifeDip as the blade continues; never resets detectedAt.
 */
export function upsertKnifeWatch(
  prev: KnifeWatchEntry | undefined,
  obs: {
    nowMs: number;
    priceUsd: number;
    dipPct: number;
    peakPriceUsd: number | null;
  },
): KnifeWatchEntry {
  const peak =
    obs.peakPriceUsd != null && obs.peakPriceUsd > 0
      ? obs.peakPriceUsd
      : Math.max(obs.priceUsd, prev?.peakPriceUsd ?? obs.priceUsd);

  if (!prev) {
    return {
      detectedAtMs: obs.nowMs,
      knifeDipPct: obs.dipPct,
      peakPriceUsd: peak,
      troughPriceUsd: obs.priceUsd,
      troughAtMs: obs.nowMs,
      lastPriceUsd: obs.priceUsd,
      lastAtMs: obs.nowMs,
    };
  }

  const next: KnifeWatchEntry = {
    ...prev,
    peakPriceUsd: Math.max(prev.peakPriceUsd, peak),
    lastPriceUsd: obs.priceUsd,
    lastAtMs: obs.nowMs,
    knifeDipPct: Math.min(prev.knifeDipPct, obs.dipPct),
  };

  if (obs.priceUsd < prev.troughPriceUsd) {
    next.troughPriceUsd = obs.priceUsd;
    next.troughAtMs = obs.nowMs;
  }
  return next;
}

export function evaluateKnifeStabilizeReady(
  watch: KnifeWatchEntry,
  gates: KnifeStabilizeGates,
  nowMs: number,
  freshPriceUsd?: number | null,
): KnifeReadyVerdict {
  const reasons: string[] = [];
  if (!gates.enabled) {
    return { ready: false, expire: true, mode: null, bouncePct: null, reasons: ['knife_disabled'] };
  }

  const price =
    freshPriceUsd != null && freshPriceUsd > 0 ? freshPriceUsd : watch.lastPriceUsd;
  const ageMs = nowMs - watch.detectedAtMs;
  const quietAgeMs = nowMs - watch.troughAtMs;
  const bouncePct = bounceFromTroughPct(price, watch.troughPriceUsd);

  if (!(ageMs >= 0)) {
    reasons.push('knife_clock_skew');
    return { ready: false, expire: true, mode: null, bouncePct, reasons };
  }

  if (ageMs > gates.maxWatchMs) {
    reasons.push(`knife_watch_expired_age=${ageMs}ms`);
    return { ready: false, expire: true, mode: null, bouncePct, reasons };
  }

  // Still too deep vs configured knife floor (likely rug / cascading).
  if (watch.knifeDipPct <= gates.minDipPct) {
    reasons.push(`knife_too_deep=${watch.knifeDipPct.toFixed(2)}`);
    return { ready: false, expire: true, mode: null, bouncePct, reasons };
  }

  if (bouncePct != null && bouncePct > gates.maxBouncePct) {
    reasons.push(
      `knife_chase=${bouncePct.toFixed(2)}%>max=${gates.maxBouncePct}_from_trough=${watch.troughPriceUsd}`,
    );
    return { ready: false, expire: true, mode: null, bouncePct, reasons };
  }

  if (ageMs < gates.waitMs) {
    reasons.push(`knife_wait=${ageMs}ms<${gates.waitMs}`);
    return { ready: false, expire: false, mode: null, bouncePct, reasons };
  }

  if (bouncePct == null) {
    reasons.push('knife_missing_bounce');
    return { ready: false, expire: false, mode: null, bouncePct, reasons };
  }

  // Bounce path: after the wait, a controlled lift off the trough is enough
  // (does not require a quiet trough — price already left the blade).
  if (bouncePct >= gates.minBouncePct && bouncePct <= gates.maxBouncePct) {
    return {
      ready: true,
      expire: false,
      mode: 'bounce',
      bouncePct,
      reasons: [
        `knife_bounce=${bouncePct.toFixed(2)}%_in_[${gates.minBouncePct},${gates.maxBouncePct}]`,
      ],
    };
  }

  // Stabilize path: holding the low with no new trough for quietMs.
  if (quietAgeMs < gates.quietMs) {
    reasons.push(`knife_still_falling_quiet=${quietAgeMs}ms<${gates.quietMs}`);
    return { ready: false, expire: false, mode: null, bouncePct, reasons };
  }

  if (bouncePct >= 0 && bouncePct <= gates.stabilizeBandPct) {
    return {
      ready: true,
      expire: false,
      mode: 'stabilize',
      bouncePct,
      reasons: [
        `knife_stabilize=${bouncePct.toFixed(2)}%<=${gates.stabilizeBandPct}_quiet=${quietAgeMs}ms`,
      ],
    };
  }

  reasons.push(
    `knife_not_ready_bounce=${bouncePct.toFixed(2)}%_band=${gates.stabilizeBandPct}_minBounce=${gates.minBouncePct}`,
  );
  return { ready: false, expire: false, mode: null, bouncePct, reasons };
}

/** Pre-send check for knife_stabilize entries (no main pc5m band). */
export function evaluateKnifeStabilizePreBuy(args: {
  signalPriceUsd: number;
  freshPriceUsd: number | null;
  troughPriceUsd: number | null;
  maxChasePct: number;
  maxBouncePct: number;
}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const { signalPriceUsd, freshPriceUsd, troughPriceUsd, maxChasePct, maxBouncePct } = args;

  if (freshPriceUsd == null || !(freshPriceUsd > 0)) {
    reasons.push('knife_prebuy_missing_price');
    return { pass: false, reasons };
  }

  if (maxChasePct > 0 && signalPriceUsd > 0) {
    const chasePct = (freshPriceUsd / signalPriceUsd - 1) * 100;
    if (chasePct > maxChasePct) {
      reasons.push(`knife_prebuy_chase=${chasePct.toFixed(2)}%>max=${maxChasePct}`);
    }
  }

  if (maxBouncePct > 0 && troughPriceUsd != null && troughPriceUsd > 0) {
    const bouncePct = (freshPriceUsd / troughPriceUsd - 1) * 100;
    if (bouncePct > maxBouncePct) {
      reasons.push(
        `knife_prebuy_bounce=${bouncePct.toFixed(2)}%>max=${maxBouncePct}_from_trough=${troughPriceUsd}`,
      );
    }
  }

  return { pass: reasons.length === 0, reasons };
}
