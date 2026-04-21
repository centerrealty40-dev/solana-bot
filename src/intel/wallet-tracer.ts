/**
 * Wallet tracer — core of the Atlas.
 *
 * Given a wallet, fetch its on-chain history from Helius, extract every SOL
 * and token transfer leg, and persist:
 *   - one row in entity_wallets (profile snapshot)
 *   - one row per directed transfer in money_flows (append-only edge ledger)
 *
 * Then optionally walk N hops UP the funder chain (who funded whom) so we
 * end up with a full operator graph rooted at the input wallet.
 *
 * This is the SINGLE place that touches Helius for atlas building. All other
 * scripts (analyze-cluster, scam detector, smart-money finder) consume the DB.
 *
 * Cost-aware:
 *   - Helius "addresses/{w}/transactions" returns 100 txs per call (~150 credits)
 *   - Default depth 1 + per_wallet_pages 1 = ~150 credits per traced wallet
 *   - Multi-hop trace: depth 3, fanout 5 = up to 1+5+25+125 = 156 wallets = ~25k credits
 *   - We aggressively de-dup: a wallet already traced in last 24h is skipped
 */
import { eq, sql as dsql } from 'drizzle-orm';
import { config } from '../core/config.js';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';
import { heliusFetch } from '../core/helius-guard.js';

const log = child('wallet-tracer');

const HELIUS = 'https://api.helius.xyz/v0';

// Known DEX programs / system accounts that are NOT real "wallets" — exclude
// them from the funder graph so we don't grow a million-edge spaghetti.
const NON_WALLET_ADDRESSES = new Set<string>([
  '11111111111111111111111111111111', // System program
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter older
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca whirlpool
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',   // Serum DEX v3
  'DEX1qBDJxFNzwS19oywBkJ7CsNC6yBvNsHBz2tFNMGH',   // Pump.fun core (approx)
]);

interface HeliusEnhancedTx {
  signature: string;
  timestamp: number;
  slot?: number;
  type?: string;
  source?: string;
  feePayer?: string;
  fee?: number;
  nativeTransfers?: Array<{
    fromUserAccount: string | null;
    toUserAccount: string | null;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string | null;
    toUserAccount: string | null;
    fromTokenAccount?: string | null;
    toTokenAccount?: string | null;
    tokenAmount: number;
    mint: string;
  }>;
}

export interface TracerOptions {
  /** Fetch this many transaction pages per wallet (100 txs per page). */
  pagesPerWallet?: number;
  /** Recurse into top funders / recipients up to this many hops. */
  hops?: number;
  /** When recursing, only follow this many top counterparties per wallet. */
  fanout?: number;
  /** Skip re-tracing a wallet if its profile_updated_at is within this many hours. */
  cacheHours?: number;
  /** Minimum SOL transfer amount to record as a money flow edge. Filters dust. */
  minSolEdge?: number;
}

const DEFAULT_OPTS: Required<TracerOptions> = {
  pagesPerWallet: 1,
  hops: 0,
  fanout: 5,
  cacheHours: 24,
  minSolEdge: 0.05,
};

interface TracerResult {
  walletsScanned: number;
  walletsCached: number;
  txsObserved: number;
  flowsInserted: number;
}

/**
 * Trace one wallet (and optionally its funder chain).
 */
export async function traceWallet(
  rootWallet: string,
  opts: TracerOptions = {},
): Promise<TracerResult> {
  const o = { ...DEFAULT_OPTS, ...opts };
  const result: TracerResult = {
    walletsScanned: 0,
    walletsCached: 0,
    txsObserved: 0,
    flowsInserted: 0,
  };

  const queue: Array<{ wallet: string; remainingHops: number }> = [
    { wallet: rootWallet, remainingHops: o.hops },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { wallet, remainingHops } = queue.shift()!;
    if (visited.has(wallet)) continue;
    visited.add(wallet);

    if (NON_WALLET_ADDRESSES.has(wallet)) {
      log.debug({ wallet }, 'skipping known non-wallet address');
      continue;
    }

    // Cache: skip if recently traced AND we actually have data (txCount > 0).
    // Stub rows can be inserted by other components (analyze-cluster persists
    // funder shells without fetching their history) — those should NOT count
    // as cache hits or we'd never enrich them.
    const existing = await db
      .select({
        updatedAt: schema.entityWallets.profileUpdatedAt,
        txCount: schema.entityWallets.txCount,
      })
      .from(schema.entityWallets)
      .where(eq(schema.entityWallets.wallet, wallet))
      .limit(1);
    if (existing[0] && existing[0].txCount > 0) {
      const ageHours = (Date.now() - existing[0].updatedAt.getTime()) / 3_600_000;
      if (ageHours < o.cacheHours) {
        log.debug({ wallet, ageHours: ageHours.toFixed(1) }, 'cache hit, skipping fetch');
        result.walletsCached += 1;
        if (remainingHops > 0) {
          // Still walk the cached funders into the queue
          const topFunders = await topFundersFromDb(wallet, o.fanout);
          for (const f of topFunders) {
            if (!visited.has(f)) queue.push({ wallet: f, remainingHops: remainingHops - 1 });
          }
        }
        continue;
      }
    }

    const txs = await fetchHistory(wallet, o.pagesPerWallet);
    result.walletsScanned += 1;
    result.txsObserved += txs.length;

    const { profile, flows, topCounterparties } = analyzeTxs(wallet, txs, o.minSolEdge);

    await upsertProfile(wallet, profile);
    if (flows.length > 0) {
      result.flowsInserted += await insertFlows(flows);
    }

    if (remainingHops > 0) {
      for (const f of topCounterparties.slice(0, o.fanout)) {
        if (!visited.has(f)) queue.push({ wallet: f, remainingHops: remainingHops - 1 });
      }
    }
  }

  log.info({ root: rootWallet, ...result, opts: o }, 'wallet trace done');
  return result;
}

async function fetchHistory(wallet: string, pages: number): Promise<HeliusEnhancedTx[]> {
  const out: HeliusEnhancedTx[] = [];
  let before: string | undefined;
  for (let p = 0; p < pages; p++) {
    const url =
      `${HELIUS}/addresses/${wallet}/transactions?api-key=${config.heliusApiKey}` +
      `&limit=100${before ? `&before=${before}` : ''}`;
    try {
      const res = await heliusFetch({
        url,
        kind: 'wallet_history',
        note: `${wallet.slice(0, 8)}…page${p}`,
      });
      if (res.statusCode !== 200) {
        log.warn({ wallet, status: res.statusCode, page: p }, 'helius non-200');
        break;
      }
      const j = (await res.body.json()) as HeliusEnhancedTx[];
      if (!Array.isArray(j) || j.length === 0) break;
      out.push(...j);
      before = j[j.length - 1].signature;
      if (j.length < 100) break;
    } catch (err) {
      log.warn({ wallet, err: String(err), page: p }, 'helius fetch failed');
      break;
    }
  }
  return out;
}

interface ProfileUpdate {
  firstTxAt: Date | null;
  lastTxAt: Date | null;
  txCount: number;
  distinctMints: number;
  distinctCounterparties: number;
  totalFundedSol: number;
  totalFeeSpentSol: number;
}

interface FlowRow {
  sourceWallet: string;
  targetWallet: string;
  asset: string;
  amount: number;
  txTime: Date;
  signature: string;
}

function analyzeTxs(
  wallet: string,
  txs: HeliusEnhancedTx[],
  minSolEdge: number,
): {
  profile: ProfileUpdate;
  flows: FlowRow[];
  topCounterparties: string[];
} {
  const flows: FlowRow[] = [];
  const mints = new Set<string>();
  const counterparties = new Map<string, number>(); // wallet -> total SOL volume with us
  let firstTs = Number.MAX_SAFE_INTEGER;
  let lastTs = 0;
  let totalFundedSol = 0;
  let totalFeeSpentSol = 0;

  for (const tx of txs) {
    if (tx.timestamp) {
      firstTs = Math.min(firstTs, tx.timestamp);
      lastTs = Math.max(lastTs, tx.timestamp);
    }
    const txTime = new Date((tx.timestamp ?? 0) * 1000);

    if (tx.feePayer === wallet && typeof tx.fee === 'number') {
      totalFeeSpentSol += tx.fee / 1e9;
    }

    for (const nt of tx.nativeTransfers ?? []) {
      if (typeof nt.amount !== 'number' || nt.amount <= 0) continue;
      const sol = nt.amount / 1e9;
      // Edges concerning OUR wallet only — that's enough to build the funder
      // chain rooted at root. We don't index the whole world.
      if (nt.toUserAccount === wallet && nt.fromUserAccount && !NON_WALLET_ADDRESSES.has(nt.fromUserAccount)) {
        if (sol >= minSolEdge) {
          flows.push({
            sourceWallet: nt.fromUserAccount,
            targetWallet: wallet,
            asset: 'SOL',
            amount: sol,
            txTime,
            signature: tx.signature,
          });
          totalFundedSol += sol;
          counterparties.set(nt.fromUserAccount, (counterparties.get(nt.fromUserAccount) ?? 0) + sol);
        }
      }
      if (nt.fromUserAccount === wallet && nt.toUserAccount && !NON_WALLET_ADDRESSES.has(nt.toUserAccount)) {
        if (sol >= minSolEdge) {
          flows.push({
            sourceWallet: wallet,
            targetWallet: nt.toUserAccount,
            asset: 'SOL',
            amount: sol,
            txTime,
            signature: tx.signature,
          });
          counterparties.set(nt.toUserAccount, (counterparties.get(nt.toUserAccount) ?? 0) + sol);
        }
      }
    }

    for (const tt of tx.tokenTransfers ?? []) {
      if (typeof tt.tokenAmount !== 'number' || tt.tokenAmount <= 0) continue;
      mints.add(tt.mint);
      // We do not log every token transfer as a flow — would explode storage.
      // Token transfers are already in the swaps table for trading analysis.
      // Money flows table is only for SOL legs (the funding fingerprint).
    }
  }

  // Top counterparties by total SOL volume — used for graph fanout
  const sortedCp = [...counterparties.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .filter((w) => w !== wallet);

  return {
    profile: {
      firstTxAt: firstTs === Number.MAX_SAFE_INTEGER ? null : new Date(firstTs * 1000),
      lastTxAt: lastTs > 0 ? new Date(lastTs * 1000) : null,
      txCount: txs.length,
      distinctMints: mints.size,
      distinctCounterparties: counterparties.size,
      totalFundedSol,
      totalFeeSpentSol,
    },
    flows,
    topCounterparties: sortedCp,
  };
}

async function upsertProfile(wallet: string, p: ProfileUpdate): Promise<void> {
  // Simple upsert: insert fresh values, on conflict overwrite. We lose the
  // "widening" semantics (max of old vs new) but that's acceptable — re-tracing
  // re-reads the same canonical history from Helius, so values converge anyway.
  // Avoids fragile dsql template literal interpolation that postgres-js dislikes
  // when mixing Date and column-reference parameters.
  await db
    .insert(schema.entityWallets)
    .values({
      wallet,
      firstTxAt: p.firstTxAt,
      lastTxAt: p.lastTxAt,
      txCount: p.txCount,
      distinctMints: p.distinctMints,
      distinctCounterparties: p.distinctCounterparties,
      totalFundedSol: p.totalFundedSol,
      totalFeeSpentSol: p.totalFeeSpentSol,
      profileUpdatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.entityWallets.wallet,
      set: {
        firstTxAt: p.firstTxAt,
        lastTxAt: p.lastTxAt,
        txCount: p.txCount,
        distinctMints: p.distinctMints,
        distinctCounterparties: p.distinctCounterparties,
        totalFundedSol: p.totalFundedSol,
        totalFeeSpentSol: p.totalFeeSpentSol,
        profileUpdatedAt: new Date(),
      },
    });
}

async function insertFlows(flows: FlowRow[]): Promise<number> {
  // Drizzle batch insert with ON CONFLICT DO NOTHING via the unique index
  let inserted = 0;
  // Insert in chunks to avoid pg parameter limit
  const CHUNK = 200;
  for (let i = 0; i < flows.length; i += CHUNK) {
    const slice = flows.slice(i, i + CHUNK);
    const r = await db
      .insert(schema.moneyFlows)
      .values(slice)
      .onConflictDoNothing()
      .returning({ id: schema.moneyFlows.id });
    inserted += r.length;
  }
  return inserted;
}

async function topFundersFromDb(wallet: string, n: number): Promise<string[]> {
  const rows = (await db.execute(
    dsql.raw(`
      SELECT source_wallet AS w, SUM(amount) AS s
      FROM money_flows
      WHERE target_wallet = '${wallet}' AND asset = 'SOL'
      GROUP BY source_wallet
      ORDER BY s DESC
      LIMIT ${n}
    `),
  )) as unknown as Array<{ w: string; s: number }>;
  return rows.map((r) => r.w);
}
