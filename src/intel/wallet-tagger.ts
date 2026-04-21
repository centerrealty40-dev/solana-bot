/**
 * Wallet auto-tagger.
 *
 * Reads entity_wallets + money_flows + swaps and classifies each wallet using
 * deterministic heuristics. Each rule writes a (wallet, tag, source, confidence)
 * row into wallet_tags. A wallet can carry multiple tags (e.g. 'sniper' AND
 * 'smart_money' if it both shoots launches AND comes out ahead).
 *
 * The "primary tag" denormalized into entity_wallets.primary_tag is the
 * highest-priority tag from this priority order:
 *   cex_hot_wallet > scam_operator > scam_proxy > sniper > mev_bot >
 *   smart_money > insider > rotation_node > lp_provider > retail > inactive
 *
 * Heuristic philosophy:
 *   - Each rule is a simple, auditable function with a comment explaining WHY
 *   - Confidence reflects how easy the rule is to fool by an adapting actor
 *   - We never delete tags — only add. Old tags are evidence in the audit log.
 */
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('wallet-tagger');

const PRIORITY = [
  'cex_hot_wallet',
  'scam_operator',
  'scam_proxy',
  'sniper',
  'mev_bot',
  'smart_money',
  'insider',
  'rotation_node',
  'lp_provider',
  'retail',
  'inactive',
];

const KNOWN_CEX_HOT_WALLETS = new Map<string, string>([
  ['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'Binance hot 1'],
  ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'Binance hot 2'],
  ['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase 1'],
  ['ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', 'Coinbase 2'],
  ['CcUxkA15UrdAvGWP8dZjB5wcjrjnwR9rmZE8tjPbZbhB', 'Kraken'],
  ['BieeZkdnBAgNYknzo3RH2vku7FyyUWXR9JuYAxHvxSfa', 'OKX'],
  ['G2FAbFQPFa5qKXCetoFZQEvF9BVvCKbvGJSvb1Sj6w7Z', 'KuCoin'],
]);

interface AddTagArgs {
  wallet: string;
  tag: string;
  confidence: number;
  source: string;
  context?: string;
}

async function addTag(args: AddTagArgs): Promise<void> {
  await db
    .insert(schema.walletTags)
    .values({
      wallet: args.wallet,
      tag: args.tag,
      confidence: args.confidence,
      source: args.source,
      context: args.context,
    })
    .onConflictDoNothing();
}

async function setPrimaryTag(wallet: string, tag: string): Promise<void> {
  await db
    .update(schema.entityWallets)
    .set({ primaryTag: tag })
    .where(dsql`${schema.entityWallets.wallet} = ${wallet}`);
}

/**
 * Run all classification rules against one wallet. Idempotent — safe to call
 * repeatedly; tags are deduped by (wallet, tag, source).
 */
export async function tagWallet(wallet: string): Promise<string[]> {
  const tagsApplied: string[] = [];

  // 0. CEX hot wallet — hard list, highest confidence
  const cexLabel = KNOWN_CEX_HOT_WALLETS.get(wallet);
  if (cexLabel) {
    await addTag({ wallet, tag: 'cex_hot_wallet', confidence: 100, source: 'cex_list', context: cexLabel });
    tagsApplied.push('cex_hot_wallet');
  }

  // Pull profile + activity stats
  const profileRows = await db
    .select()
    .from(schema.entityWallets)
    .where(dsql`${schema.entityWallets.wallet} = ${wallet}`)
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return tagsApplied; // wallet not in atlas yet

  const ageDays = profile.firstTxAt
    ? (Date.now() - new Date(profile.firstTxAt).getTime()) / 86_400_000
    : 0;
  const hasActivityData = profile.lastTxAt !== null;
  const idleDays = hasActivityData
    ? (Date.now() - new Date(profile.lastTxAt!).getTime()) / 86_400_000
    : 0;

  // 1. Inactive — hasn't traded in 90+ days. Only fire if we actually have
  // activity timestamps; null lastTxAt = "never traced" not "very inactive".
  if (hasActivityData && idleDays >= 90) {
    await addTag({ wallet, tag: 'inactive', confidence: 100, source: 'recency', context: `idle_${idleDays.toFixed(0)}d` });
    tagsApplied.push('inactive');
  }

  // Pull swap stats from the swaps table for trading-based heuristics
  const swapStats = (await db.execute(
    dsql.raw(`
      SELECT
        COUNT(*)::int AS n_swaps,
        COUNT(DISTINCT base_mint)::int AS n_mints,
        COUNT(*) FILTER (WHERE side='buy')::int AS n_buys,
        COUNT(*) FILTER (WHERE side='sell')::int AS n_sells,
        COALESCE(MIN(EXTRACT(EPOCH FROM block_time)),0)::float AS first_swap_ts,
        COALESCE(MAX(EXTRACT(EPOCH FROM block_time)),0)::float AS last_swap_ts,
        COALESCE(AVG(amount_usd),0)::float AS avg_usd,
        COALESCE(SUM(amount_usd),0)::float AS total_usd
      FROM swaps WHERE wallet = '${wallet}'
    `),
  )) as unknown as Array<{
    n_swaps: number;
    n_mints: number;
    n_buys: number;
    n_sells: number;
    first_swap_ts: number;
    last_swap_ts: number;
    avg_usd: number;
    total_usd: number;
  }>;
  const ss = swapStats[0] ?? {
    n_swaps: 0,
    n_mints: 0,
    n_buys: 0,
    n_sells: 0,
    first_swap_ts: 0,
    last_swap_ts: 0,
    avg_usd: 0,
    total_usd: 0,
  };

  // 2. Sniper: many swaps where wallet bought within 60s of token's first-ever trade.
  // Approximation: count buys where wallet was among the first 3 buyers of that mint.
  const sniperHits = (await db.execute(
    dsql.raw(`
      WITH ranked AS (
        SELECT s.wallet, s.base_mint,
               ROW_NUMBER() OVER (PARTITION BY s.base_mint ORDER BY s.block_time) AS r
        FROM swaps s WHERE s.side='buy'
      )
      SELECT COUNT(*)::int AS hits FROM ranked
      WHERE wallet='${wallet}' AND r <= 3
    `),
  )) as unknown as Array<{ hits: number }>;
  const snipes = sniperHits[0]?.hits ?? 0;
  if (snipes >= 3 && snipes / Math.max(ss.n_buys, 1) >= 0.5) {
    await addTag({
      wallet,
      tag: 'sniper',
      confidence: 75,
      source: 'first3_buyer',
      context: `${snipes}/${ss.n_buys}_first3_buys`,
    });
    tagsApplied.push('sniper');
  }

  // 3. MEV bot: very high tx count + high counterparty diversity + tiny avg trade
  if (profile.txCount >= 500 && profile.distinctCounterparties >= 100 && ss.avg_usd < 100) {
    await addTag({
      wallet,
      tag: 'mev_bot',
      confidence: 70,
      source: 'high_freq_low_size',
      context: `tx${profile.txCount}_cp${profile.distinctCounterparties}_avg$${ss.avg_usd.toFixed(0)}`,
    });
    tagsApplied.push('mev_bot');
  }

  // 4. Rotation node: fresh wallet (<30d), few mints touched (<5), large SOL inflow
  // from a single funder, almost no fee-spent (passes-through funds).
  if (ageDays < 30 && ss.n_mints < 5 && profile.totalFundedSol >= 50 && profile.totalFeeSpentSol < 0.5) {
    await addTag({
      wallet,
      tag: 'rotation_node',
      confidence: 60,
      source: 'fresh_passthrough',
      context: `age${ageDays.toFixed(0)}d_mints${ss.n_mints}_in${profile.totalFundedSol.toFixed(0)}sol`,
    });
    tagsApplied.push('rotation_node');
  }

  // 5. Smart money (provisional, will sharpen with realized PnL later):
  // - traded many distinct tokens (>=10)
  // - balanced buy/sell ratio (sells/buys between 0.3 and 3)
  // - reasonable avg size (>$100)
  // - active for at least 30 days
  if (
    ss.n_mints >= 10 &&
    ss.n_sells > 0 &&
    ss.n_buys / Math.max(ss.n_sells, 1) >= 0.33 &&
    ss.n_sells / Math.max(ss.n_buys, 1) >= 0.33 &&
    ss.avg_usd >= 100 &&
    ageDays >= 30
  ) {
    await addTag({
      wallet,
      tag: 'smart_money',
      confidence: 50,
      source: 'multi_token_balanced',
      context: `mints${ss.n_mints}_b/s${ss.n_buys}/${ss.n_sells}`,
    });
    tagsApplied.push('smart_money');
  }

  // 6. Retail: handful of trades, single mint, small size, no recurring activity
  if (
    ss.n_swaps >= 1 &&
    ss.n_swaps <= 10 &&
    ss.n_mints <= 3 &&
    ss.avg_usd < 200 &&
    profile.distinctCounterparties < 10
  ) {
    await addTag({
      wallet,
      tag: 'retail',
      confidence: 60,
      source: 'low_activity_single_token',
      context: `swaps${ss.n_swaps}_avg$${ss.avg_usd.toFixed(0)}`,
    });
    tagsApplied.push('retail');
  }

  // ---- Resolve PRIMARY tag (highest-priority of what we tagged) ----
  // Combine fresh tags AND all existing tags from wallet_tags
  const existing = await db
    .select({ tag: schema.walletTags.tag })
    .from(schema.walletTags)
    .where(dsql`${schema.walletTags.wallet} = ${wallet}`);
  const allTags = new Set<string>([...tagsApplied, ...existing.map((r) => r.tag)]);
  for (const t of PRIORITY) {
    if (allTags.has(t)) {
      await setPrimaryTag(wallet, t);
      break;
    }
  }

  log.debug({ wallet, tagsApplied: [...allTags], primary: [...allTags].find((t) => PRIORITY.includes(t)) }, 'tagged');
  return tagsApplied;
}

/**
 * Convenience: re-tag every wallet in the atlas (or only ones updated since N hours).
 * Used by a daily cron job.
 */
export async function tagAtlas(updatedSinceHours: number = 24): Promise<{ tagged: number }> {
  const rows = (await db.execute(
    dsql.raw(`
      SELECT wallet FROM entity_wallets
      WHERE profile_updated_at > now() - interval '${Math.max(1, Math.floor(updatedSinceHours))} hours'
      ORDER BY profile_updated_at DESC
    `),
  )) as unknown as Array<{ wallet: string }>;

  let n = 0;
  for (const r of rows) {
    try {
      await tagWallet(r.wallet);
      n += 1;
    } catch (err) {
      log.warn({ wallet: r.wallet, err: String(err) }, 'tag failed');
    }
  }
  log.info({ tagged: n, total: rows.length }, 'tagAtlas done');
  return { tagged: n };
}
