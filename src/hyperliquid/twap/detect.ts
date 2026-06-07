import { aggregateCoinHourlyImpacts, activeTwapsForCoin, crossingImpactDecision, twapHourlyImpactPct } from './coin-twap-analysis.js';
import type { CrossingImpactDecision } from './coin-twap-analysis.js';
import type { HypurrscanTwapRow, NormalizedTwapSignal, TwapSide } from './types.js';

export { crossingImpactDecision };
export type { CrossingImpactDecision };

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
  /** Delayed exit after whale TWAP cancel (hash → exitAtMs + reason). */
  pendingWhaleExitByHash: Map<string, { exitAtMs: number; reason: string }>;
  /** Last HypurrScan `ended` status per hash (set when TWAP leaves active feed). */
  lastEndedStatusByHash: Map<string, string>;
  /** Telegram message_id for start alerts — link crossing TWAPs. */
  telegramMessageByHash: Map<string, number>;
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
    pendingWhaleExitByHash: new Map(),
    lastEndedStatusByHash: new Map(),
    telegramMessageByHash: new Map(),
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

export function passesTwapFilters(
  sig: NormalizedTwapSignal,
  opts: TwapFilterOpts,
  state?: TwapWatchState,
): boolean {
  const min = opts.minVolumeSharePct;
  const hourly = twapHourlyImpactPct(sig);
  if (min > 0 && (hourly == null || hourly < min)) {
    return false;
  }

  if (opts.buyOnly === true) {
    if (sig.side === 'sell' && !state?.buyNotifiedByWhaleCoin.has(whaleCoinKey(sig))) {
      return false;
    }
    return true;
  }

  if (!state) return true;

  const activeOnCoin = activeTwapsForCoin(state, sig.coin);
  const twaps = activeOnCoin.some((t) => t.hash === sig.hash)
    ? activeOnCoin
    : [...activeOnCoin, sig];
  const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(twaps);
  const { allow, dominant } = crossingImpactDecision(buyPctPerHour, sellPctPerHour, min);
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
      state.lastEndedStatusByHash.set(sig.hash, sig.ended);
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
