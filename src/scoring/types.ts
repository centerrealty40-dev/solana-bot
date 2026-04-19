import type { schema } from '../core/db/client.js';

export type Swap = typeof schema.swaps.$inferSelect;

/** Per-token aggregated stats used by FIFO PnL and holding-pattern metrics. */
export interface TokenPosition {
  baseMint: string;
  /** open lots: each buy adds a lot, each sell consumes from earliest lot (FIFO) */
  lots: Array<{ amountRaw: bigint; priceUsd: number; openedAt: Date }>;
  realizedPnlUsd: number;
  costUsd: number;
  /** seconds spent in net long position, weighted by quantity */
  holdingMinutes: number;
  /** count of positions (one position = period from flat -> net long -> flat) */
  closedCount: number;
  /** count of positions where the closing exit was split across >1 sell */
  trancheClosedCount: number;
  lastFlatAt: Date | null;
}

export interface WalletAggregate {
  wallet: string;
  swaps: Swap[];
  positions: Map<string, TokenPosition>;
  /** total trade count in window */
  tradeCount: number;
  /** distinct base mints */
  distinctTokens: number;
  /** wins / closed positions */
  winrate: number;
  /** sum of realized PnL across all tokens */
  totalRealizedPnlUsd: number;
}
