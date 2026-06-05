import type { HypurrscanTwapRow, NormalizedTwapSignal, TwapSide } from './types.js';

export type TwapWatchState = {
  /** Open alert already sent to Telegram (required before end/cancel alert). */
  openedNotifiedHashes: Set<string>;
  /** @deprecated HL_TWAP_BUY_ONLY=1: buy OPEN уже слали по киту+монете. */
  buyNotifiedByWhaleCoin: Set<string>;
  /** Seen opens: seeded or new this session — suppress duplicate NEW only. */
  seenOpenHashes: Set<string>;
  /** Active TWAP hashes (no ended yet). */
  activeByHash: Map<string, NormalizedTwapSignal>;
  /** Ended notifications already sent. */
  endedAnnounced: Set<string>;
};

export function whaleCoinKey(sig: Pick<NormalizedTwapSignal, 'user' | 'coin'>): string {
  return `${sig.user.toLowerCase()}:${sig.coin}`;
}

export function createTwapWatchState(): TwapWatchState {
  return {
    openedNotifiedHashes: new Set(),
    buyNotifiedByWhaleCoin: new Set(),
    seenOpenHashes: new Set(),
    activeByHash: new Map(),
    endedAnnounced: new Set(),
  };
}

export function markTwapOpenedNotified(state: TwapWatchState, sig: NormalizedTwapSignal): void {
  state.openedNotifiedHashes.add(sig.hash);
  if (sig.side === 'buy') {
    state.buyNotifiedByWhaleCoin.add(whaleCoinKey(sig));
  }
}

export type TwapDetectResult = {
  newSignals: NormalizedTwapSignal[];
  endedSignals: Array<{ signal: NormalizedTwapSignal; endedStatus: string }>;
};

export type TwapFilterOpts = {
  minVolumeSharePct: number;
  /**
   * @deprecated Используйте перекрёстный impact (long/short ≥ min, diff > min).
   * Если true — sell только после buy OPEN (старое поведение).
   */
  buyOnly?: boolean;
};

/** Активный TWAP того же кита+монеты на противоположной стороне. */
export function oppositeActiveTwap(
  state: TwapWatchState,
  sig: NormalizedTwapSignal,
): NormalizedTwapSignal | null {
  const want: TwapSide = sig.side === 'buy' ? 'sell' : 'buy';
  const key = whaleCoinKey(sig);
  for (const active of state.activeByHash.values()) {
    if (active.side !== want) continue;
    if (whaleCoinKey(active) !== key) continue;
    return active;
  }
  return null;
}

export type CrossingImpactDecision = {
  allow: boolean;
  dominant: TwapSide | null;
  diffPct: number | null;
};

/**
 * Перекрёстные TWAP: long и short impact каждый ≥ min; |buy − sell| > min → доминирующая сторона.
 */
export function crossingImpactDecision(
  buyPct: number | null | undefined,
  sellPct: number | null | undefined,
  minPct: number,
): CrossingImpactDecision {
  if (minPct <= 0) {
    const dominant =
      buyPct != null && sellPct != null
        ? buyPct > sellPct
          ? 'buy'
          : sellPct > buyPct
            ? 'sell'
            : null
        : null;
    return { allow: true, dominant, diffPct: null };
  }
  if (buyPct == null || sellPct == null) {
    return { allow: false, dominant: null, diffPct: null };
  }
  if (buyPct < minPct || sellPct < minPct) {
    return { allow: false, dominant: null, diffPct: Math.abs(buyPct - sellPct) };
  }
  const diffPct = Math.abs(buyPct - sellPct);
  if (diffPct <= minPct) {
    return { allow: false, dominant: null, diffPct };
  }
  const dominant: TwapSide = buyPct > sellPct ? 'buy' : 'sell';
  return { allow: true, dominant, diffPct };
}

export function passesTwapFilters(
  sig: NormalizedTwapSignal,
  opts: TwapFilterOpts,
  state?: TwapWatchState,
): boolean {
  const min = opts.minVolumeSharePct;
  if (min > 0 && (sig.volumeSharePct == null || sig.volumeSharePct < min)) {
    return false;
  }

  if (opts.buyOnly === true) {
    if (sig.side === 'sell' && !state?.buyNotifiedByWhaleCoin.has(whaleCoinKey(sig))) {
      return false;
    }
    return true;
  }

  const opposite = state ? oppositeActiveTwap(state, sig) : null;
  if (!opposite) return true;

  const buyPct = sig.side === 'buy' ? sig.volumeSharePct : opposite.volumeSharePct;
  const sellPct = sig.side === 'sell' ? sig.volumeSharePct : opposite.volumeSharePct;
  const { allow, dominant } = crossingImpactDecision(buyPct, sellPct, min);
  if (!allow || !dominant) return false;
  return sig.side === dominant;
}

/** Compare HypurrScan feed snapshot to local state. */
export function detectTwapChanges(
  rows: HypurrscanTwapRow[],
  normalize: (row: HypurrscanTwapRow) => NormalizedTwapSignal | null,
  state: TwapWatchState,
  opts: TwapFilterOpts,
): TwapDetectResult {
  const newSignals: NormalizedTwapSignal[] = [];
  const endedSignals: Array<{ signal: NormalizedTwapSignal; endedStatus: string }> = [];

  const seenThisPass = new Set<string>();

  for (const row of rows) {
    const sig = normalize(row);
    if (!sig) continue;
    seenThisPass.add(sig.hash);

    if (sig.ended) {
      if (state.endedAnnounced.has(sig.hash)) continue;
      state.endedAnnounced.add(sig.hash);
      const tracked = state.activeByHash.get(sig.hash);
      state.activeByHash.delete(sig.hash);
      if (!state.openedNotifiedHashes.has(sig.hash)) continue;
      const base = tracked ?? sig;
      endedSignals.push({ signal: base, endedStatus: sig.ended });
      continue;
    }

    if (state.seenOpenHashes.has(sig.hash)) {
      state.activeByHash.set(sig.hash, sig);
      continue;
    }

    if (!passesTwapFilters(sig, opts, state)) continue;

    state.seenOpenHashes.add(sig.hash);
    state.activeByHash.set(sig.hash, sig);
    newSignals.push(sig);
  }

  return { newSignals, endedSignals };
}

/** Mark active TWAPs already in feed as seen — no Telegram burst on first poll after deploy. */
export function seedTwapWatchState(
  rows: HypurrscanTwapRow[],
  normalize: (row: HypurrscanTwapRow) => NormalizedTwapSignal | null,
  state: TwapWatchState,
  opts: TwapFilterOpts,
): number {
  let n = 0;
  for (const row of rows) {
    const sig = normalize(row);
    if (!sig || sig.ended) continue;
    if (!passesTwapFilters(sig, opts, state)) continue;
    state.seenOpenHashes.add(sig.hash);
    state.activeByHash.set(sig.hash, sig);
    n++;
  }
  return n;
}
