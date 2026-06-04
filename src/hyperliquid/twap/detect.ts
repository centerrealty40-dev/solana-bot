import type { HypurrscanTwapRow, NormalizedTwapSignal } from './types.js';

export type TwapWatchState = {
  /** Open alert already sent to Telegram (required before end/cancel alert). */
  openedNotifiedHashes: Set<string>;
  /** Seen opens: seeded or new this session — suppress duplicate NEW only. */
  seenOpenHashes: Set<string>;
  /** Active TWAP hashes (no ended yet). */
  activeByHash: Map<string, NormalizedTwapSignal>;
  /** Ended notifications already sent. */
  endedAnnounced: Set<string>;
};

export function createTwapWatchState(): TwapWatchState {
  return {
    openedNotifiedHashes: new Set(),
    seenOpenHashes: new Set(),
    activeByHash: new Map(),
    endedAnnounced: new Set(),
  };
}

export function markTwapOpenedNotified(state: TwapWatchState, hash: string): void {
  state.openedNotifiedHashes.add(hash);
}

export type TwapDetectResult = {
  newSignals: NormalizedTwapSignal[];
  endedSignals: Array<{ signal: NormalizedTwapSignal; endedStatus: string }>;
};

/** Compare HypurrScan feed snapshot to local state. Единственный порог — price impact (% of 24h perp volume). */
export function detectTwapChanges(
  rows: HypurrscanTwapRow[],
  normalize: (row: HypurrscanTwapRow) => NormalizedTwapSignal | null,
  state: TwapWatchState,
  opts: { minVolumeSharePct: number },
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
      if (passesTwapFilters(base, opts.minVolumeSharePct)) {
        endedSignals.push({ signal: base, endedStatus: sig.ended });
      }
      continue;
    }

    if (state.seenOpenHashes.has(sig.hash)) {
      state.activeByHash.set(sig.hash, sig);
      continue;
    }

    if (!passesTwapFilters(sig, opts.minVolumeSharePct)) continue;

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

export function passesTwapFilters(sig: NormalizedTwapSignal, minVolumeSharePct: number): boolean {
  if (minVolumeSharePct <= 0) return true;
  return sig.volumeSharePct != null && sig.volumeSharePct >= minVolumeSharePct;
}

/** Mark active TWAPs already in feed as seen — no Telegram burst on first poll after deploy. */
export function seedTwapWatchState(
  rows: HypurrscanTwapRow[],
  normalize: (row: HypurrscanTwapRow) => NormalizedTwapSignal | null,
  state: TwapWatchState,
  opts: { minVolumeSharePct: number },
): number {
  let n = 0;
  for (const row of rows) {
    const sig = normalize(row);
    if (!sig || sig.ended) continue;
    if (!passesTwapFilters(sig, opts.minVolumeSharePct)) continue;
    state.seenOpenHashes.add(sig.hash);
    state.activeByHash.set(sig.hash, sig);
    n++;
  }
  return n;
}
