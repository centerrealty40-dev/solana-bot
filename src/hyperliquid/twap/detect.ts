import type { HypurrscanTwapRow, NormalizedTwapSignal } from './types.js';

export type TwapWatchState = {
  /** Open alert already sent to Telegram (required before end/cancel alert). */
  openedNotifiedHashes: Set<string>;
  /**
   * Кит+монета: мы уже слали OPEN по buy-TWAP (тот же user+coin).
   * Sell-TWAP алертим только при наличии ключа — разворот против нашей long-логики.
   */
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
   * Default true: sell-TWAP только если ранее слали buy OPEN тому же киту по той же монете.
   * Обычные продажи в стейблы без нашего buy — игнорируются.
   */
  buyOnly?: boolean;
};

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
      if (passesTwapFilters(base, opts, state)) {
        endedSignals.push({ signal: base, endedStatus: sig.ended });
      }
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

  // Rows that disappeared from feed without ended flag are left in activeByHash until ended appears.
  for (const hash of [...state.activeByHash.keys()]) {
    if (!seenThisPass.has(hash)) {
      // HypurrScan keeps ended rows in feed; no action until ended is set.
    }
  }

  return { newSignals, endedSignals };
}

export function passesTwapFilters(
  sig: NormalizedTwapSignal,
  opts: TwapFilterOpts,
  state?: TwapWatchState,
): boolean {
  const buyOnly = opts.buyOnly !== false;
  if (buyOnly && sig.side === 'sell') {
    if (!state?.buyNotifiedByWhaleCoin.has(whaleCoinKey(sig))) return false;
  }
  if (opts.minVolumeSharePct <= 0) return true;
  return sig.volumeSharePct != null && sig.volumeSharePct >= opts.minVolumeSharePct;
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
