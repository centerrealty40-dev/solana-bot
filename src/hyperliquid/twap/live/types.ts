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
  /** Initial gross notional at open (USD) = margin × leverage. */
  initialNotionalUsd: number;
  /** Current gross notional (USD). */
  currentNotionalUsd: number;
  /** Collateral per trade (HL_TWAP_LIVE_NOTIONAL_USD). */
  marginUsd: number;
  /** Leverage applied at open (capped by HL max for coin). */
  entryLeverage: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
  liveOpenAtMs: number;
  liveCloseAtMs: number;
  twapStartMs: number;
  tpLevelsTaken: number;
  dcaLevelsTaken: number;
  whaleNotionalUsd: number | null;
  whaleSize: number | null;
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
  /** Gross position notional filled (USD). */
  notionalUsd: number;
  /** Collateral for opens (margin × leverage = notional). */
  marginUsd?: number;
  leverage?: number;
  /** Requested gross notional before fill reconciliation. */
  requestedNotionalUsd?: number;
  /** True when filled size < 95% of requested. */
  partialFill?: boolean;
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
  /** When set, order size in base units (exchange szi) instead of notional/markPx. */
  sizeBase?: number;
};

export type HlTwapExchangeClient = {
  readonly mode: 'dry_run' | 'live';
  /** One-time setup (SymbolConverter, leverage defaults). */
  init(): Promise<void>;
  /** HL account that holds perp positions (for clearinghouse queries). */
  accountAddress(): string;
  /** Signed perp size on exchange (base units); 0 if flat. */
  getPositionSzi(coin: string): Promise<number>;
  /** Effective cross leverage for opens (capped by HL max per coin). */
  leverageForCoin(coin: string): number;
  marketOrder(params: MarketOrderParams): Promise<OrderFillResult>;
};
