import type { TwapSide } from '../types.js';

export type HlTwapLiveOpen = {
  hash: string;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  entryTs: number;
  /** Anchor for ±3% ladder levels (initial fill). */
  entryAnchorPx: number;
  /** Volume-weighted average entry after DCAs. */
  avgEntryPx: number;
  /** Initial notional at open (USD). */
  initialNotionalUsd: number;
  /** Current gross notional (USD). */
  currentNotionalUsd: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
  liveOpenAtMs: number;
  liveCloseAtMs: number;
  twapStartMs: number;
  tpLevelsTaken: number;
  dcaLevelsTaken: number;
};

export type HlTwapLiveClose = HlTwapLiveOpen & {
  exitTs: number;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

export type OrderFillResult = {
  fillPx: number;
  sizeBase: number;
  notionalUsd: number;
};

export type MarketOrderIntent = 'open' | 'close' | 'tp' | 'dca';

export type MarketOrderParams = {
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  notionalUsd: number;
  markPx: number;
  reduceOnly: boolean;
  intent: MarketOrderIntent;
};

export type HlTwapExchangeClient = {
  readonly mode: 'dry_run' | 'live';
  /** One-time setup (SymbolConverter, leverage defaults). */
  init(): Promise<void>;
  marketOrder(params: MarketOrderParams): Promise<OrderFillResult>;
};
