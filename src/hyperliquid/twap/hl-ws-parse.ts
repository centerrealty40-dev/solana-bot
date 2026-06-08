import type { HlTwapStatus, HlWsTwapHistoryRow, HlWsTwapOpenEvent, HlWsTwapState } from './hl-ws-types.js';

export function twapSideFromHl(side: string): 'buy' | 'sell' | null {
  const s = side.trim().toUpperCase();
  if (s === 'B' || s === 'BUY' || s === 'BID') return 'buy';
  if (s === 'A' || s === 'SELL' || s === 'ASK') return 'sell';
  return null;
}

export function syntheticTwapId(user: string, twapId: number | null, state: HlWsTwapState): string {
  if (twapId != null && Number.isFinite(twapId)) {
    return `${user.toLowerCase()}:twap:${twapId}`;
  }
  return `${user.toLowerCase()}:${state.coin}:${state.side}:${state.minutes}:${state.timestamp}`;
}

export function isActiveTwapStatus(status: HlTwapStatus): boolean {
  return status === 'activated';
}

export function twapStateToOpenEvent(
  channel: HlWsTwapOpenEvent['channel'],
  user: string,
  twapId: number | null,
  row: HlWsTwapHistoryRow,
  receivedAtMs: number,
  isSnapshot: boolean,
): HlWsTwapOpenEvent | null {
  const side = twapSideFromHl(row.state.side);
  if (!side) return null;
  const size = Number(row.state.sz);
  if (!Number.isFinite(size) || size <= 0) return null;
  const startedAtMs = row.state.timestamp > 0 ? row.state.timestamp : row.time;
  return {
    source: 'hl_ws',
    channel,
    user: user.toLowerCase(),
    twapId,
    syntheticId: syntheticTwapId(user, twapId, row.state),
    status: row.status.status,
    coin: row.state.coin,
    side,
    size,
    minutes: row.state.minutes,
    reduceOnly: row.state.reduceOnly,
    randomize: row.state.randomize,
    startedAtMs,
    receivedAtMs,
    isSnapshot,
    rawStatusDescription: row.status.description,
  };
}

export function parseUserTwapHistoryMessage(
  data: unknown,
  receivedAtMs = Date.now(),
): HlWsTwapOpenEvent[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as { isSnapshot?: boolean; user?: string; history?: HlWsTwapHistoryRow[] };
  const user = d.user?.trim();
  if (!user || !Array.isArray(d.history)) return [];
  const isSnapshot = d.isSnapshot === true;
  const out: HlWsTwapOpenEvent[] = [];
  for (const row of d.history) {
    if (!row?.state || !row.status) continue;
    const ev = twapStateToOpenEvent('userTwapHistory', user, null, row, receivedAtMs, isSnapshot);
    if (ev) out.push(ev);
  }
  return out;
}

export function parseTwapStatesMessage(data: unknown, receivedAtMs = Date.now()): HlWsTwapOpenEvent[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as { user?: string; states?: Array<[number, HlWsTwapState]> };
  const user = d.user?.trim();
  if (!user || !Array.isArray(d.states)) return [];
  const out: HlWsTwapOpenEvent[] = [];
  for (const [twapId, state] of d.states) {
    if (!state) continue;
    const side = twapSideFromHl(state.side);
    if (!side) continue;
    const size = Number(state.sz);
    if (!Number.isFinite(size) || size <= 0) continue;
    const startedAtMs = state.timestamp;
    out.push({
      source: 'hl_ws',
      channel: 'twapStates',
      user: user.toLowerCase(),
      twapId,
      syntheticId: syntheticTwapId(user, twapId, state),
      status: 'activated',
      coin: state.coin,
      side,
      size,
      minutes: state.minutes,
      reduceOnly: state.reduceOnly,
      randomize: state.randomize,
      startedAtMs,
      receivedAtMs,
      isSnapshot: false,
    });
  }
  return out;
}

export function detectLagMs(receivedAtMs: number, startedAtMs: number): number | null {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return receivedAtMs - startedAtMs;
}
