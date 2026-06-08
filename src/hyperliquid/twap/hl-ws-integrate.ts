import type { TwapWatchState } from './detect.js';
import { passesTwapFilters, type TwapFilterOpts } from './detect.js';
import type { HlWsTwapOpenEvent } from './hl-ws-types.js';
import { normalizeHlWsTwap } from './hl-ws-normalize.js';
import type { HyperliquidMarketCache } from './hyperliquid-meta.js';
import type { NormalizedTwapSignal } from './types.js';

export type WsIntegrateState = {
  /** matchKey → ws local hash */
  wsByMatchKey: Map<string, string>;
  /** hypurr tx hash → ws local hash */
  hypurrToLocalHash: Map<string, string>;
};

export function createWsIntegrateState(): WsIntegrateState {
  return {
    wsByMatchKey: new Map(),
    hypurrToLocalHash: new Map(),
  };
}

export function twapMatchKey(user: string, coin: string, startedAtMs: number): string {
  return `${user.toLowerCase()}:${coin}:${startedAtMs}`;
}

function findWsHashForSig(sig: NormalizedTwapSignal, ws: WsIntegrateState): string | null {
  const keys = [
    twapMatchKey(sig.user, sig.coin, sig.startedAtMs),
    twapMatchKey(sig.user, sig.coin, sig.startedAtMs - 60_000),
    twapMatchKey(sig.user, sig.coin, sig.startedAtMs + 60_000),
    twapMatchKey(sig.user, sig.coin, sig.startedAtMs - 120_000),
    twapMatchKey(sig.user, sig.coin, sig.startedAtMs + 120_000),
  ];
  for (const key of keys) {
    const wsHash = ws.wsByMatchKey.get(key);
    if (wsHash) return wsHash;
  }
  return null;
}

/** WS fast-path: returns signal to announce, or null if duplicate/filtered. */
export function tryAcceptWsTwap(
  ev: HlWsTwapOpenEvent,
  cache: HyperliquidMarketCache,
  state: TwapWatchState,
  ws: WsIntegrateState,
  opts: TwapFilterOpts,
): NormalizedTwapSignal | null {
  const sig = normalizeHlWsTwap(ev, cache);
  if (!sig) return null;
  if (state.seenOpenHashes.has(sig.hash)) return null;
  if (!passesTwapFilters(sig, opts, state)) return null;

  state.seenOpenHashes.add(sig.hash);
  state.activeByHash.set(sig.hash, sig);
  ws.wsByMatchKey.set(twapMatchKey(sig.user, sig.coin, sig.startedAtMs), sig.hash);
  return sig;
}

/** HypurrScan saw same TWAP after WS — link hashes, skip duplicate announce. */
export function absorbHypurrscanDuplicate(
  sig: NormalizedTwapSignal,
  state: TwapWatchState,
  ws: WsIntegrateState,
): boolean {
  const wsHash = findWsHashForSig(sig, ws);
  if (!wsHash || !state.seenOpenHashes.has(wsHash)) return false;

  ws.hypurrToLocalHash.set(sig.hash, wsHash);
  state.seenOpenHashes.add(sig.hash);
  state.activeByHash.set(sig.hash, sig);
  if (state.openedNotifiedHashes.has(wsHash)) {
    state.openedNotifiedHashes.add(sig.hash);
  }
  const tgId = state.telegramMessageByHash.get(wsHash);
  if (tgId != null) state.telegramMessageByHash.set(sig.hash, tgId);
  return true;
}

export function resolveLocalTwapHash(hash: string, ws: WsIntegrateState): string {
  return ws.hypurrToLocalHash.get(hash) ?? hash;
}

export function withLocalTwapHash(sig: NormalizedTwapSignal, ws: WsIntegrateState): NormalizedTwapSignal {
  const local = resolveLocalTwapHash(sig.hash, ws);
  return local === sig.hash ? sig : { ...sig, hash: local };
}

export function mergeWhaleAddresses(base: string[], extra: string[], max: number): string[] {
  const out = [...base];
  const seen = new Set(base.map((u) => u.toLowerCase()));
  for (const raw of extra) {
    const u = raw.trim().toLowerCase();
    if (!u.startsWith('0x') || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}
