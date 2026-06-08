/** Hyperliquid WebSocket TWAP feed types (wss://api.hyperliquid.xyz/ws). */

export type HlTwapStatus = 'activated' | 'terminated' | 'finished' | 'error';

export type HlWsTwapState = {
  coin: string;
  user: string;
  side: string;
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  reduceOnly: boolean;
  randomize: boolean;
  timestamp: number;
};

export type HlWsTwapHistoryRow = {
  state: HlWsTwapState;
  status: { status: HlTwapStatus; description?: string };
  time: number;
};

export type HlWsTwapOpenEvent = {
  source: 'hl_ws';
  channel: 'userTwapHistory' | 'twapStates';
  user: string;
  twapId: number | null;
  syntheticId: string;
  status: HlTwapStatus;
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  minutes: number;
  reduceOnly: boolean;
  randomize: boolean;
  startedAtMs: number;
  receivedAtMs: number;
  isSnapshot: boolean;
  rawStatusDescription?: string;
};

export type HlWsInboundMessage = {
  channel?: string;
  data?: unknown;
};

export type HlWsUserTwapHistoryData = {
  isSnapshot?: boolean;
  user: string;
  history?: HlWsTwapHistoryRow[];
};

export type HlWsTwapStatesData = {
  dex?: string;
  user: string;
  states?: Array<[number, HlWsTwapState]>;
};
