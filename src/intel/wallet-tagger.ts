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
  'terminal_distributor',   // public trading terminal paymaster (Axiom/Photon/...)
  'scam_treasury',
  'scam_payout',
  'scam_operator',
  'scam_proxy',
  'whale',                  // moves >=100 SOL per transfer or >=1000 SOL totals
  'bot_farm_boss',          // collector receiving from many small sources
  'bot_farm_distributor',   // sender to many wallets w/ medium SOL amounts (live raids)
  'sniper',
  'mev_bot',
  'terminal_user',          // received gas from terminal_distributor
  'meme_flipper',           // many mints via 1-2 aggregators (real human flipper)
  'smart_money',
  'insider',
  'rotation_node',
  'gas_distributor',        // micro-amounts (<0.5 SOL) to many — paymasters, helpers
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

/**
 * Public trading terminals that fund their users with starter SOL.
 * Receivers of these wallets are real human traders using that terminal.
 * Add more as we identify them on-chain.
 */
const KNOWN_TERMINAL_DISTRIBUTORS = new Map<string, string>([
  ['AxiomRXZAq1Jgjj9pHmNqVP7Lhu67wLXZJZbaK87TTSk', 'Axiom Trade'],
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

  // 0c. Terminal distributor — public terminals (Axiom etc) that paymaster their users.
  const termLabel = KNOWN_TERMINAL_DISTRIBUTORS.get(wallet);
  if (termLabel) {
    await addTag({ wallet, tag: 'terminal_distributor', confidence: 100, source: 'terminal_list', context: termLabel });
    tagsApplied.push('terminal_distributor');
  }

  // 0d. Terminal user — received SOL from a known terminal distributor.
  // These are real human traders using that terminal. Highest-value targets
  // because they are humans, not bots, and they trade with their own money.
  const termIds = [...KNOWN_TERMINAL_DISTRIBUTORS.keys()].map(k => `'${k}'`).join(',');
  if (termIds.length > 0) {
    const termRecv = (await db.execute(
      dsql.raw(`
        SELECT source_wallet, SUM(amount)::float AS sol, COUNT(*)::int AS n
        FROM money_flows
        WHERE target_wallet = '${wallet}'
          AND source_wallet IN (${termIds})
          AND asset = 'SOL'
        GROUP BY source_wallet
        ORDER BY sol DESC
        LIMIT 1
      `),
    )) as unknown as Array<{ source_wallet: string; sol: number; n: number }>;
    const tr = termRecv[0];
    if (tr && tr.sol >= 0.05) {
      const label = KNOWN_TERMINAL_DISTRIBUTORS.get(tr.source_wallet) ?? 'unknown';
      await addTag({
        wallet,
        tag: 'terminal_user',
        confidence: 90,
        source: 'received_from_terminal',
        context: `${label}|${tr.sol.toFixed(3)}sol|${tr.n}tx`,
      });
      tagsApplied.push('terminal_user');
    }
  }

  // 0a. Scam treasury — wallet funded ≥3 distinct scam_operator wallets.
  // The boss/payroll account behind a coordinated rug operation. Highest-value
  // intel target: monitoring it lets us pre-empt every future pump it launches.
  const treasuryProbe = (await db.execute(
    dsql.raw(`
      SELECT COUNT(DISTINCT mf.target_wallet)::int AS n_funded,
             SUM(mf.amount)::float AS total_sol
      FROM money_flows mf
      JOIN entity_wallets ew ON ew.wallet = mf.target_wallet
      WHERE mf.source_wallet = '${wallet}'
        AND ew.primary_tag IN ('scam_operator','scam_proxy')
        AND mf.asset = 'SOL'
    `),
  )) as unknown as Array<{ n_funded: number; total_sol: number }>;
  const tp = treasuryProbe[0];
  if (tp && tp.n_funded >= 3) {
    await addTag({
      wallet,
      tag: 'scam_treasury',
      confidence: Math.min(100, 60 + tp.n_funded * 3),
      source: 'multi_funded_operators',
      context: `funded:${tp.n_funded}_ops|total:${tp.total_sol.toFixed(0)}sol`,
    });
    tagsApplied.push('scam_treasury');
  }

  // 0b. Scam payout — wallet RECEIVED SOL from ≥3 distinct scam_operator wallets.
  // The collector behind a coordinated rug; usually the same human as scam_treasury
  // but on a separate address for anti-forensics. Tracking these gives us an
  // exit-side intel target: when payout receives a fresh inflow it means the
  // operation just printed money.
  const payoutProbe = (await db.execute(
    dsql.raw(`
      SELECT COUNT(DISTINCT mf.source_wallet)::int AS n_drained,
             SUM(mf.amount)::float AS total_sol
      FROM money_flows mf
      JOIN entity_wallets ew ON ew.wallet = mf.source_wallet
      WHERE mf.target_wallet = '${wallet}'
        AND ew.primary_tag IN ('scam_operator','scam_proxy')
        AND mf.asset = 'SOL'
    `),
  )) as unknown as Array<{ n_drained: number; total_sol: number }>;
  const pp = payoutProbe[0];
  if (pp && pp.n_drained >= 3) {
    await addTag({
      wallet,
      tag: 'scam_payout',
      confidence: Math.min(100, 60 + pp.n_drained * 3),
      source: 'multi_drained_from_operators',
      context: `drained_from:${pp.n_drained}_ops|total:${pp.total_sol.toFixed(0)}sol`,
    });
    tagsApplied.push('scam_payout');
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

  // 4a-4d. Outbound funding profile (one query, multiple rules).
  const outProbe = (await db.execute(
    dsql.raw(`
      SELECT
        COUNT(DISTINCT target_wallet)::int                              AS recipients,
        COUNT(*)::int                                                   AS n_tx,
        COALESCE(AVG(amount), 0)::float                                 AS avg_sol,
        COALESCE(SUM(amount), 0)::float                                 AS sum_sol,
        COALESCE(MAX(amount), 0)::float                                 AS max_sol,
        COALESCE(EXTRACT(EPOCH FROM (MAX(tx_time) - MIN(tx_time))), 0)::float AS span_sec,
        COALESCE(EXTRACT(EPOCH FROM (now() - MAX(tx_time))), 0)::float  AS idle_sec
      FROM money_flows
      WHERE source_wallet = '${wallet}' AND asset = 'SOL' AND amount > 0
    `),
  )) as unknown as Array<{
    recipients: number; n_tx: number; avg_sol: number; sum_sol: number;
    max_sol: number; span_sec: number; idle_sec: number;
  }>;
  const out = outProbe[0] ?? { recipients: 0, n_tx: 0, avg_sol: 0, sum_sol: 0, max_sol: 0, span_sec: 0, idle_sec: 1e12 };

  // 4a. Whale — moves big SOL (single tx >=100 SOL OR cumulative >=1000 SOL out)
  if (out.max_sol >= 100 || out.sum_sol >= 1000) {
    await addTag({
      wallet, tag: 'whale', confidence: 75, source: 'big_sol_out',
      context: `max=${out.max_sol.toFixed(0)}sol|sum=${out.sum_sol.toFixed(0)}sol|n=${out.n_tx}`,
    });
    tagsApplied.push('whale');
  }

  // 4b. Bot-farm distributor — many recipients, medium avg, sustained activity, recent.
  // The SOL-dispatcher of a bot fleet. Real signal in our niche: when this guy
  // sprays SOL into 30+ wallets within minutes, a coordinated buy/raid is imminent.
  // Excludes whales (filtered by avg_sol upper bound) and gas_distributors (avg too small).
  if (
    out.recipients >= 30 &&
    out.avg_sol >= 0.5 && out.avg_sol <= 30 &&
    out.idle_sec < 14 * 86400  // active in last 14 days
  ) {
    await addTag({
      wallet, tag: 'bot_farm_distributor', confidence: 65, source: 'many_med_recipients',
      context: `r=${out.recipients}|avg=${out.avg_sol.toFixed(2)}sol|sum=${out.sum_sol.toFixed(0)}sol`,
    });
    tagsApplied.push('bot_farm_distributor');
  }

  // 4c. Gas distributor — micro amounts (<0.5 SOL avg) to many recipients.
  // These are paymasters/helpers; not as interesting as bot_farm_distributor.
  if (out.recipients >= 20 && out.avg_sol > 0 && out.avg_sol < 0.5) {
    await addTag({
      wallet, tag: 'gas_distributor', confidence: 70, source: 'micro_amounts_many',
      context: `r=${out.recipients}|avg=${out.avg_sol.toFixed(3)}sol`,
    });
    tagsApplied.push('gas_distributor');
  }

  // 4d. Bot-farm boss — collects SOL FROM many sources with small per-source amounts.
  // The drain side of a bot fleet (workers send their profits up to boss).
  const inProbe = (await db.execute(
    dsql.raw(`
      SELECT
        COUNT(DISTINCT source_wallet)::int                              AS sources,
        COUNT(*)::int                                                   AS n_tx,
        COALESCE(AVG(amount), 0)::float                                 AS avg_sol,
        COALESCE(SUM(amount), 0)::float                                 AS sum_sol,
        COALESCE(EXTRACT(EPOCH FROM (now() - MAX(tx_time))), 0)::float  AS idle_sec
      FROM money_flows
      WHERE target_wallet = '${wallet}' AND asset = 'SOL' AND amount > 0
    `),
  )) as unknown as Array<{ sources: number; n_tx: number; avg_sol: number; sum_sol: number; idle_sec: number }>;
  const inn = inProbe[0] ?? { sources: 0, n_tx: 0, avg_sol: 0, sum_sol: 0, idle_sec: 1e12 };

  if (
    inn.sources >= 30 &&
    inn.avg_sol < 10 &&  // not whales sending to it
    inn.idle_sec < 14 * 86400
  ) {
    await addTag({
      wallet, tag: 'bot_farm_boss', confidence: 60, source: 'many_small_sources',
      context: `s=${inn.sources}|avg=${inn.avg_sol.toFixed(2)}sol|sum=${inn.sum_sol.toFixed(0)}sol`,
    });
    tagsApplied.push('bot_farm_boss');
  }

  // 4e. Meme flipper — many distinct mints traded via 1-2 routers (=Jupiter/pump.fun only).
  // High distinct_mints + low distinct_counterparties is the on-chain signature
  // of a real human flipping memecoins through aggregators (no direct CEX/funder relations).
  if (
    profile.distinctMints >= 20 &&
    profile.distinctCounterparties <= 4 &&
    profile.txCount >= 30
  ) {
    await addTag({
      wallet, tag: 'meme_flipper', confidence: 70, source: 'many_mints_few_cps',
      context: `mints=${profile.distinctMints}|cps=${profile.distinctCounterparties}|tx=${profile.txCount}`,
    });
    tagsApplied.push('meme_flipper');
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

  const primary = PRIORITY.find((t) => allTags.has(t)) ?? null;
  log.debug({ wallet, tagsApplied: [...allTags], primary }, 'tagged');
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
