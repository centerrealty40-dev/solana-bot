import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  doublePrecision,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Tokens we have observed on-chain. Filled by collectors, enriched by Birdeye/Solscan.
 */
export const tokens = pgTable(
  'tokens',
  {
    mint: varchar('mint', { length: 64 }).primaryKey(),
    symbol: text('symbol'),
    name: text('name'),
    decimals: integer('decimals').notNull().default(0),
    devWallet: varchar('dev_wallet', { length: 64 }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    holderCount: integer('holder_count'),
    fdvUsd: doublePrecision('fdv_usd'),
    liquidityUsd: doublePrecision('liquidity_usd'),
    volume24hUsd: doublePrecision('volume_24h_usd'),
    /** primary DEX pair address used for price feeds */
    primaryPair: varchar('primary_pair', { length: 64 }),
    /** flagged manually or by heuristics as scam/rug/blacklisted */
    blacklisted: boolean('blacklisted').notNull().default(false),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    devIdx: index('tokens_dev_idx').on(t.devWallet),
    firstSeenIdx: index('tokens_first_seen_idx').on(t.firstSeenAt),
  }),
);

/**
 * Wallets we have observed making swaps. Most rows are populated lazily as we ingest swaps.
 */
export const wallets = pgTable(
  'wallets',
  {
    address: varchar('address', { length: 64 }).primaryKey(),
    /** first time we saw this wallet do anything */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** funding source: parent wallet that sent its first SOL/USDC */
    fundingSource: varchar('funding_source', { length: 64 }),
    fundingTs: timestamp('funding_ts', { withTimezone: true }),
    /** whether this wallet is on a known CEX hot-wallet list (Binance, Coinbase, etc.) */
    isCexHotWallet: boolean('is_cex_hot_wallet').notNull().default(false),
    /** label set manually for whitelisted "alpha" wallets we're tracking */
    label: text('label'),
    /** entity cluster id assigned by H2 wallet clustering */
    clusterId: varchar('cluster_id', { length: 64 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fundingIdx: index('wallets_funding_idx').on(t.fundingSource),
    clusterIdx: index('wallets_cluster_idx').on(t.clusterId),
    firstSeenIdx: index('wallets_first_seen_idx').on(t.firstSeenAt),
  }),
);

/**
 * Normalized swap events. Append-only fact table.
 * Single row per (signature, wallet, baseMint) — a multi-leg route can produce multiple rows.
 */
export const swaps = pgTable(
  'swaps',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    signature: varchar('signature', { length: 96 }).notNull(),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    wallet: varchar('wallet', { length: 64 }).notNull(),
    baseMint: varchar('base_mint', { length: 64 }).notNull(),
    quoteMint: varchar('quote_mint', { length: 64 }).notNull(),
    side: varchar('side', { length: 4 }).notNull(),
    baseAmountRaw: bigint('base_amount_raw', { mode: 'bigint' }).notNull(),
    quoteAmountRaw: bigint('quote_amount_raw', { mode: 'bigint' }).notNull(),
    priceUsd: doublePrecision('price_usd').notNull(),
    amountUsd: doublePrecision('amount_usd').notNull(),
    dex: varchar('dex', { length: 16 }).notNull(),
    source: varchar('source', { length: 24 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sigWalletBaseUq: uniqueIndex('swaps_sig_wallet_base_uq').on(t.signature, t.wallet, t.baseMint),
    walletTimeIdx: index('swaps_wallet_time_idx').on(t.wallet, t.blockTime),
    baseTimeIdx: index('swaps_base_time_idx').on(t.baseMint, t.blockTime),
    timeIdx: index('swaps_time_idx').on(t.blockTime),
  }),
);

/**
 * Periodic snapshots of OHLCV-ish price/volume per token.
 * Used for hypothesis market context and survivorship analysis.
 */
export const priceSamples = pgTable(
  'price_samples',
  {
    mint: varchar('mint', { length: 64 }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    priceUsd: doublePrecision('price_usd').notNull(),
    volumeUsd5m: doublePrecision('volume_usd_5m').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mint, t.ts] }),
    timeIdx: index('price_samples_time_idx').on(t.ts),
  }),
);

/**
 * Holder snapshots — we record holder count over time to compute velocity / anomaly.
 */
export const holderSnapshots = pgTable(
  'holder_snapshots',
  {
    mint: varchar('mint', { length: 64 }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    holderCount: integer('holder_count').notNull(),
    /** count of unique wallets that bought in the last 1h */
    newBuyers1h: integer('new_buyers_1h'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mint, t.ts] }),
  }),
);

/**
 * Rolling per-wallet metrics computed by the scoring engine.
 * One row per wallet, overwritten on each compute pass.
 */
export const walletScores = pgTable(
  'wallet_scores',
  {
    wallet: varchar('wallet', { length: 64 }).primaryKey(),
    earlyEntryScore: doublePrecision('early_entry_score').notNull().default(0),
    realizedPnl30d: doublePrecision('realized_pnl_30d').notNull().default(0),
    unrealizedPnl: doublePrecision('unrealized_pnl').notNull().default(0),
    holdingAvgMinutes: doublePrecision('holding_avg_minutes').notNull().default(0),
    sellInTranchesRatio: doublePrecision('sell_in_tranches_ratio').notNull().default(0),
    fundingOriginAgeDays: doublePrecision('funding_origin_age_days').notNull().default(0),
    clusterId: varchar('cluster_id', { length: 64 }),
    consistencyScore: doublePrecision('consistency_score').notNull().default(0),
    /** total trade count last 30d (used to gate noisy wallets) */
    tradeCount30d: integer('trade_count_30d').notNull().default(0),
    /** distinct tokens traded last 30d */
    distinctTokens30d: integer('distinct_tokens_30d').notNull().default(0),
    /** winrate (closed positions only) last 30d */
    winrate30d: doublePrecision('winrate_30d').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pnlIdx: index('wallet_scores_pnl_idx').on(t.realizedPnl30d),
    eeIdx: index('wallet_scores_ee_idx').on(t.earlyEntryScore),
    clusterIdx: index('wallet_scores_cluster_idx').on(t.clusterId),
  }),
);

/**
 * Signals raised by hypotheses. One row per (hypothesis, signal time, mint).
 * Includes both signals that became positions and the ones that were filtered by risk.
 */
export const signals = pgTable(
  'signals',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    hypothesisId: varchar('hypothesis_id', { length: 32 }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    baseMint: varchar('base_mint', { length: 64 }).notNull(),
    side: varchar('side', { length: 4 }).notNull(),
    sizeUsd: doublePrecision('size_usd').notNull(),
    reason: text('reason').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    /** whether the runner approved this and a position was opened */
    accepted: boolean('accepted').notNull().default(false),
    rejectReason: text('reject_reason'),
  },
  (t) => ({
    hypoTsIdx: index('signals_hypo_ts_idx').on(t.hypothesisId, t.ts),
    mintIdx: index('signals_mint_idx').on(t.baseMint),
  }),
);

/**
 * Open or closed positions, one row per opened position.
 * Trades (fills) are stored separately with foreign key to positions.id.
 */
export const positions = pgTable(
  'positions',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    hypothesisId: varchar('hypothesis_id', { length: 32 }).notNull(),
    mode: varchar('mode', { length: 8 }).notNull(),
    baseMint: varchar('base_mint', { length: 64 }).notNull(),
    quoteMint: varchar('quote_mint', { length: 64 }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** initial USD size (notional) */
    sizeUsd: doublePrecision('size_usd').notNull(),
    /** weighted average entry price */
    entryPriceUsd: doublePrecision('entry_price_usd').notNull(),
    /** weighted average exit price */
    exitPriceUsd: doublePrecision('exit_price_usd'),
    /** raw base tokens currently held */
    baseAmountRaw: bigint('base_amount_raw', { mode: 'bigint' }).notNull().default(0n),
    /** realized PnL in USD (closed portion) */
    realizedPnlUsd: doublePrecision('realized_pnl_usd').notNull().default(0),
    /** total fees + slippage paid in USD */
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    status: varchar('status', { length: 12 }).notNull().default('open'),
    closeReason: text('close_reason'),
    /** opaque payload from the spawning signal */
    signalMeta: jsonb('signal_meta').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    hypoStatusIdx: index('positions_hypo_status_idx').on(t.hypothesisId, t.status),
    openedIdx: index('positions_opened_idx').on(t.openedAt),
    mintIdx: index('positions_mint_idx').on(t.baseMint),
  }),
);

/**
 * Individual fills — entry, partial exits, final exit. Both paper and live.
 */
export const trades = pgTable(
  'trades',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    positionId: bigint('position_id', { mode: 'bigint' })
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    side: varchar('side', { length: 4 }).notNull(),
    baseAmountRaw: bigint('base_amount_raw', { mode: 'bigint' }).notNull(),
    quoteAmountRaw: bigint('quote_amount_raw', { mode: 'bigint' }).notNull(),
    priceUsd: doublePrecision('price_usd').notNull(),
    slippageBps: doublePrecision('slippage_bps').notNull().default(0),
    feeUsd: doublePrecision('fee_usd').notNull().default(0),
    /** null for paper, signature for live */
    signature: varchar('signature', { length: 96 }),
  },
  (t) => ({
    posIdx: index('trades_pos_idx').on(t.positionId),
    tsIdx: index('trades_ts_idx').on(t.ts),
  }),
);

/**
 * Manually maintained whitelist of "seed" wallets we copy from in H1.
 * Populated via CLI / dashboard.
 */
export const watchlistWallets = pgTable(
  'watchlist_wallets',
  {
    wallet: varchar('wallet', { length: 64 }).primaryKey(),
    source: varchar('source', { length: 24 }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    note: text('note'),
  },
);

/**
 * Daily PnL snapshots per hypothesis, used for kill-switch and dashboard.
 */
export const dailyPnl = pgTable(
  'daily_pnl',
  {
    hypothesisId: varchar('hypothesis_id', { length: 32 }).notNull(),
    day: varchar('day', { length: 10 }).notNull(),
    mode: varchar('mode', { length: 8 }).notNull(),
    realizedPnlUsd: doublePrecision('realized_pnl_usd').notNull().default(0),
    tradesCount: integer('trades_count').notNull().default(0),
    winsCount: integer('wins_count').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.hypothesisId, t.day, t.mode] }),
  }),
);
