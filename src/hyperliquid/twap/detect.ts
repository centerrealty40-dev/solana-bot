import type { HypurrscanTwapRow, NormalizedTwapSignal } from './types.js';

export type TwapWatchState = {
  /** Hashes we already announced as new TWAP. */
  announcedHashes: Set<string>;
  /** Active TWAP hashes (no ended yet). */
  activeByHash: Map<string, NormalizedTwapSignal>;
  /** Ended notifications already sent. */
  endedAnnounced: Set<string>;
};

export function createTwapWatchState(): TwapWatchState {
  return {
    announcedHashes: new Set(),
    activeByHash: new Map(),
    endedAnnounced: new Set(),
  };
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
      const prev = state.activeByHash.get(sig.hash);
      const base = prev ?? sig;
      if (passesTwapFilters(base, opts.minVolumeSharePct)) {
        endedSignals.push({ signal: base, endedStatus: sig.ended });
      }
      state.endedAnnounced.add(sig.hash);
      state.activeByHash.delete(sig.hash);
      continue;
    }

    if (state.announcedHashes.has(sig.hash)) {
      state.activeByHash.set(sig.hash, sig);
      continue;
    }

    if (!passesTwapFilters(sig, opts.minVolumeSharePct)) continue;

    state.announcedHashes.add(sig.hash);
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

function passesTwapFilters(sig: NormalizedTwapSignal, minVolumeSharePct: number): boolean {
  if (minVolumeSharePct <= 0) return true;
  return sig.volumeSharePct != null && sig.volumeSharePct >= minVolumeSharePct;
}
