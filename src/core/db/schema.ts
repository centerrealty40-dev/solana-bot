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
 * Append-only ledger of every outbound Helius API call.
 *
 * Used by the `heliusGuard` circuit breaker:
 *   - count today's calls -> compare against daily budget
 *   - count this-month calls -> compare against monthly budget
 *
 * Keeping it append-only (no aggregation) makes audits trivial after an incident
 * like the 2026-04 program-subscription burn.
 */
export const heliusUsage = pgTable(
  'helius_usage',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    /** logical bucket ('webhook_register', 'wallet_history', 'rpc_call', etc.) */
    kind: varchar('kind', { length: 32 }).notNull(),
    /** estimated credits this call consumed; webhook-register is ~1, history page is ~100 */
    creditsEstimate: integer('credits_estimate').notNull().default(1),
    /** http status returned (or 0 if call short-circuited by guard) */
    statusCode: integer('status_code').notNull().default(0),
    /** short note for debugging — wallet, endpoint, error message head */
    note: text('note'),
  },
  (t) => ({
    tsIdx: index('helius_usage_ts_idx').on(t.ts),
    kindTsIdx: index('helius_usage_kind_ts_idx').on(t.kind, t.ts),
  }),
);

/**
 * First-N attribution table for the copy-trader.
 *
 * The first watchlist wallet that buys a brand new mint registers itself here
 * and gets a paper position; subsequent buys by other watchlist wallets are
 * dropped as follow-the-leader noise.
 */
export const copySeenMints = pgTable(
  'copy_seen_mints',
  {
    mint: varchar('mint', { length: 64 }).primaryKey(),
    firstWallet: varchar('first_wallet', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    firstSignature: varchar('first_signature', { length: 96 }),
  },
  (t) => ({
    firstWalletIdx: index('copy_seen_mints_first_wallet_idx').on(t.firstWallet),
    firstSeenIdx: index('copy_seen_mints_first_seen_idx').on(t.firstSeenAt),
  }),
);

/* =====================================================================
 * Wallet Atlas (intel layer)
 *
 * Persistent profile of every wallet we touch. Used both as a research
 * playground ("show me everything we know about wallet X") and as the
 * substrate for downstream products (rug-alert telegram bot, "smart-money
 * verified" labels, operator-graph queries).
 *
 * Design philosophy:
 *   - One row per wallet in entity_wallets — accumulating profile, never deleted
 *   - One row per directed transfer in money_flows — append-only edge log
 *     (we re-aggregate on demand to compute funder chains)
 *   - One row per (wallet, tag) in wallet_tags — many-to-many; a wallet can
 *     simultaneously be 'smart-money' AND 'sniper'
 *   - One row per cluster in wallet_clusters — group of wallets we believe
 *     belong to the same human operator (joined via funding patterns)
 *
 * No row is ever deleted; only soft-flagged. Reasons:
 *   - We may revise judgements as new patterns emerge
 *   - Defamation-safe: we record evidence, not verdicts
 * ===================================================================== */

/**
 * Persistent profile per wallet we have ever scanned.
 *
 * Populated incrementally:
 *   - First seen: wallet-tracer creates the row
 *   - Updated: each new tracer run refreshes counts/lastSeen/etc
 *   - Tagged: wallet-tagger writes into wallet_tags
 *   - Clustered: when a money-flow link is established, clusterId is set
 */
export const entityWallets = pgTable(
  'entity_wallets',
  {
    wallet: varchar('wallet', { length: 64 }).primaryKey(),
    /** First time this wallet appeared on-chain (timestamp of oldest tx we saw). */
    firstTxAt: timestamp('first_tx_at', { withTimezone: true }),
    /** Last time we observed activity for this wallet (any tx). */
    lastTxAt: timestamp('last_tx_at', { withTimezone: true }),
    /** When we first added this wallet to our atlas (db insertion time). */
    profileCreatedAt: timestamp('profile_created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When we last refreshed this profile from on-chain. */
    profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Total transactions we have observed (capped at the depth of our last scan). */
    txCount: integer('tx_count').notNull().default(0),
    /** Number of distinct token mints this wallet has touched (any side). */
    distinctMints: integer('distinct_mints').notNull().default(0),
    /** Number of distinct counterparty wallets seen (funders + recipients). */
    distinctCounterparties: integer('distinct_counterparties').notNull().default(0),
    /** Total SOL ever received as funding (sum of nativeTransfers in). */
    totalFundedSol: doublePrecision('total_funded_sol').notNull().default(0),
    /** Total SOL spent as fee payer (proxy for "owns this wallet"). */
    totalFeeSpentSol: doublePrecision('total_fee_spent_sol').notNull().default(0),
    /**
     * Optional cluster assignment — the human operator we believe owns this
     * wallet. References wallet_clusters.id. Many wallets per cluster.
     */
    clusterId: bigint('cluster_id', { mode: 'number' }),
    /**
     * Optional pre-computed "primary tag" (most confident classification).
     * Detailed tags live in wallet_tags. This is just a denormalized cache for
     * fast filtering (e.g. "all wallets where primary_tag='scam_operator'").
     */
    primaryTag: varchar('primary_tag', { length: 32 }),
    /** Free-form notes — e.g. "Coinbase 5", "found via cluster 42 honeypot dive" */
    note: text('note'),
  },
  (t) => ({
    clusterIdx: index('entity_wallets_cluster_idx').on(t.clusterId),
    primaryTagIdx: index('entity_wallets_primary_tag_idx').on(t.primaryTag),
    lastTxIdx: index('entity_wallets_last_tx_idx').on(t.lastTxAt),
  }),
);

/**
 * Append-only directed money flow ledger.
 *
 * Each row = one observed SOL or token transfer between two wallets, tagged
 * with the asset, amount and time. We use this to:
 *   - Build funder chains ("walk N hops upstream from wallet X")
 *   - Detect uniform-funding-via-intermediaries (the scammer pattern)
 *   - Compute net flows per cluster
 *
 * Asset is either 'SOL' (native) or a mint address. Amount is decimal-adjusted
 * (already divided by 10^decimals) for ergonomics — we lose some precision but
 * gain trivial filtering.
 */
export const moneyFlows = pgTable(
  'money_flows',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceWallet: varchar('source_wallet', { length: 64 }).notNull(),
    targetWallet: varchar('target_wallet', { length: 64 }).notNull(),
    /** 'SOL' or a mint address (varchar to keep flexible). */
    asset: varchar('asset', { length: 64 }).notNull(),
    /** Decimal-adjusted amount (SOL or token units). */
    amount: doublePrecision('amount').notNull(),
    /** Block time of the underlying tx. */
    txTime: timestamp('tx_time', { withTimezone: true }).notNull(),
    /** Tx signature for audit. */
    signature: varchar('signature', { length: 96 }).notNull(),
    /** When we ingested this edge into the ledger. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceIdx: index('money_flows_source_idx').on(t.sourceWallet),
    targetIdx: index('money_flows_target_idx').on(t.targetWallet),
    timeIdx: index('money_flows_time_idx').on(t.txTime),
    // Prevent duplicate ingestion of the same transfer leg
    uniqueLeg: uniqueIndex('money_flows_unique_leg').on(
      t.signature,
      t.sourceWallet,
      t.targetWallet,
      t.asset,
    ),
  }),
);

/**
 * Many-to-many wallet ↔ tag relation. A wallet can carry several tags
 * simultaneously (e.g. 'smart-money' + 'sniper').
 *
 * Standard tag vocabulary (extend as we discover patterns):
 *   - 'cex_hot_wallet'    — exchange hot wallet (Coinbase, Binance, etc.)
 *   - 'cex_deposit'       — funded from CEX, not a CEX itself
 *   - 'lp_provider'       — long-term liquidity provider
 *   - 'mev_bot'           — high-frequency arbitrage / sandwich
 *   - 'sniper'            — buys within 1-3 blocks of token launch
 *   - 'smart_money'       — provably profitable across many tokens
 *   - 'retail'            — random small-size single-shot trader
 *   - 'scam_operator'     — confirmed member of a scammer cluster
 *   - 'scam_proxy'        — intermediary funding wallet in scam laundering
 *   - 'insider'           — early dev/team wallet of a launched token
 *   - 'rotation_node'     — fresh wallet that rotates SOL between operators
 *   - 'inactive'          — last activity > 90 days ago
 *
 * confidence = 0..100 (subjective — based on the rule that produced the tag)
 * source = which detector / hypothesis added the tag (for audit + retraining)
 */
export const walletTags = pgTable(
  'wallet_tags',
  {
    wallet: varchar('wallet', { length: 64 }).notNull(),
    tag: varchar('tag', { length: 32 }).notNull(),
    confidence: integer('confidence').notNull().default(50),
    source: varchar('source', { length: 32 }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    /** Optional context — e.g. "cluster:42", "honeypot:4hpC..." */
    context: text('context'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.wallet, t.tag, t.source] }),
    walletIdx: index('wallet_tags_wallet_idx').on(t.wallet),
    tagIdx: index('wallet_tags_tag_idx').on(t.tag),
  }),
);

/**
 * Operator clusters — groups of wallets we believe belong to the same person.
 *
 * Joining rule today: confirmed shared funder OR uniform-funding-through-
 * intermediaries pattern within ±20% of the same SOL amount AND within 24h.
 *
 * As we discover more patterns, we will MERGE clusters (re-point all wallets
 * from cluster A to cluster B and soft-delete A by setting mergedIntoId).
 */
export const walletClusters = pgTable(
  'wallet_clusters',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Free-form label — e.g. "honeypot operator (4hpC scam, 2026-04-21)" */
    label: text('label'),
    /** Classification of the operator: 'scam_ring', 'mm_desk', 'sniper_farm', 'unknown' */
    kind: varchar('kind', { length: 24 }).notNull().default('unknown'),
    /** Confidence we are right about this being one operator (0..100). */
    confidence: integer('confidence').notNull().default(50),
    /** Number of confirmed member wallets. Updated by tagger. */
    walletCount: integer('wallet_count').notNull().default(0),
    /** Earliest activity across any member wallet. */
    firstActivityAt: timestamp('first_activity_at', { withTimezone: true }),
    /** Latest activity. */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    /** Total SOL flowing INTO the cluster (sum of external→member transfers). */
    totalInflowSol: doublePrecision('total_inflow_sol').notNull().default(0),
    /** Tokens that this cluster touched (jsonb array of mint addresses). */
    touchedMints: jsonb('touched_mints'),
    /** If two clusters get merged, the loser points to the winner. */
    mergedIntoId: bigint('merged_into_id', { mode: 'number' }),
    detectedBy: varchar('detected_by', { length: 32 }).notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
  (t) => ({
    kindIdx: index('wallet_clusters_kind_idx').on(t.kind),
    detectedAtIdx: index('wallet_clusters_detected_idx').on(t.detectedAt),
  }),
);

/**
 * On-chain programs / protocols catalog.
 *
 * Strategy B (Infrastructure Frontrunner) needs to know which programs are
 * young, growing, and have predictable on-chain intents (DCA orders, vault
 * unlocks, liquidations, etc.). This table is our working catalog.
 *
 * Long-term it also feeds Strategy A (sellable risk-intel API).
 */
export const programs = pgTable(
  'programs',
  {
    /** On-chain program address OR DefiLlama slug if address unknown. */
    programId: varchar('program_id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 128 }),
    slug: varchar('slug', { length: 128 }),
    /** Protocol category: DEX, Lending, Yield, Liquid Staking, Derivatives, etc. */
    category: varchar('category', { length: 64 }),
    chain: varchar('chain', { length: 16 }).notNull().default('solana'),
    /** Where we found it: 'defillama' | 'discovered' | 'manual' */
    source: varchar('source', { length: 32 }).notNull(),
    url: text('url'),
    twitter: varchar('twitter', { length: 64 }),
    /** Public listing date if known (DefiLlama listedAt). */
    listedAt: timestamp('listed_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),

    tvlUsd: doublePrecision('tvl_usd'),
    change1d: doublePrecision('change_1d'),
    change7d: doublePrecision('change_7d'),
    change1m: doublePrecision('change_1m'),

    /** 'pending' | 'reviewed' | 'edge_found' | 'no_edge' | 'discarded' */
    reviewStatus: varchar('review_status', { length: 32 }).notNull().default('pending'),
    /** 'high' | 'medium' | 'low' | 'skip' */
    ourPriority: varchar('our_priority', { length: 16 }).notNull().default('medium'),
    /** What edge we suspect: 'dca' | 'limit_orders' | 'liquidations' | 'vault_unlock' | etc. */
    edgeType: varchar('edge_type', { length: 64 }),
    notes: text('notes'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    categoryIdx: index('programs_category_idx').on(t.category),
    priorityIdx: index('programs_priority_idx').on(t.ourPriority),
    statusIdx: index('programs_status_idx').on(t.reviewStatus),
    listedIdx: index('programs_listed_idx').on(t.listedAt),
  }),
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
