import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { buildTokenUniverse } from '../collectors/token-universe.js';
import { discoverSwappers } from '../collectors/helius-discovery.js';
import { rankWallets, type WalletFeatures } from '../scoring/seed-quality.js';
import { heliusFetch, getUsageSnapshot, HeliusGuardError } from '../core/helius-guard.js';

const log = child('seed-helius');

/**
 * v2 watchlist seeder — uses Helius enhanced transactions to discover
 * who actually swaps trending memecoins, then ranks them by quality features.
 *
 * Algorithm:
 *   1. buildTokenUniverse: union Birdeye + DexScreener trending/boosts/profiles
 *      filtered to memecoin FDV range + min liquidity + min volume + age window
 *   2. For each token: pull last N pages of SWAP transactions via Helius
 *   3. Aggregate per-wallet features: tokens touched, volume, buy/sell balance,
 *      median time gap, top-token concentration
 *   4. Filter junk (bots, MMs, dust) and rank by composite quality score
 *   5. (Optional) cluster-dedup by funding source to keep one wallet per entity
 *   6. UPSERT top K into watchlist_wallets with rich notes
 *
 * CLI flags via env vars:
 *   SEED_TARGET_TOKENS=50         tokens to scan (cost: tokens * pages * 100 credits)
 *   SEED_PAGES_PER_TOKEN=2        Helius pages per token (1 page = 100 txs = 100 credits)
 *   SEED_MIN_FDV=500000           min FDV for memecoin filter
 *   SEED_MAX_FDV=500000000        max FDV (filter bluechips)
 *   SEED_MIN_LIQ=30000            min liquidity USD
 *   SEED_MIN_VOL=100000           min 24h volume USD
 *   SEED_MAX_AGE_HOURS=86400      max age in hours (default ~3.6 years effectively)
 *   SEED_MIN_AGE_HOURS=2          min age (filter rug bait)
 *   SEED_LIMIT=200                max wallets to insert
 *   SEED_MIN_TOKENS=3             wallet must touch at least this many tokens
 *   SEED_MIN_GAP_SEC=5            wallet's median trade gap must be >= this (anti-MEV)
 *   SEED_DRY_RUN=1                show plan + top wallets, do not write
 *   SEED_CLUSTER=1                fetch funding source for cluster dedup (extra credits)
 *   SEED_REQUIRE_NET_ACCUM=0      require positive net flow (accumulation)
 */
async function main(): Promise<void> {
  if (config.heliusMode === 'off') {
    log.error(
      'HELIUS_MODE=off; set HELIUS_MODE=wallets in .env first (so heliusFetch is allowed). Discovery is read-only and bounded by daily budget.',
    );
    process.exit(1);
  }
  if (!config.heliusApiKey) {
    log.error('HELIUS_API_KEY is empty');
    process.exit(1);
  }

  const targetTokens = Number(process.env.SEED_TARGET_TOKENS ?? 50);
  const pages = Number(process.env.SEED_PAGES_PER_TOKEN ?? 2);
  const minFdv = Number(process.env.SEED_MIN_FDV ?? 500_000);
  const maxFdv = Number(process.env.SEED_MAX_FDV ?? 500_000_000);
  const minLiq = Number(process.env.SEED_MIN_LIQ ?? 30_000);
  const minVol = Number(process.env.SEED_MIN_VOL ?? 100_000);
  const maxAgeHours = Number(process.env.SEED_MAX_AGE_HOURS ?? 24 * 60);
  const minAgeHours = Number(process.env.SEED_MIN_AGE_HOURS ?? 2);
  const limit = Number(process.env.SEED_LIMIT ?? 200);
  const minTokens = Number(process.env.SEED_MIN_TOKENS ?? 3);
  const minGapSec = Number(process.env.SEED_MIN_GAP_SEC ?? 5);
  const dryRun = process.env.SEED_DRY_RUN === '1';
  const cluster = process.env.SEED_CLUSTER === '1';
  const requireNetAccum = process.env.SEED_REQUIRE_NET_ACCUM === '1';

  const expectedCredits = targetTokens * pages * 100;
  log.info(
    {
      targetTokens,
      pages,
      expectedCredits,
      cluster,
      dryRun,
    },
    'plan: discover swappers via Helius, then rank',
  );

  // Pre-flight credit check
  const before = await getUsageSnapshot();
  log.info(
    {
      mode: before.mode,
      todayUsed: before.today,
      todayBudget: before.dailyBudget,
      monthlyUsed: before.thisMonth,
      monthlyBudget: before.monthlyBudget,
    },
    'helius credit snapshot (before run)',
  );
  if (before.today + expectedCredits > before.dailyBudget) {
    log.error(
      `would breach daily budget: ${before.today} + ${expectedCredits} > ${before.dailyBudget}. Increase HELIUS_DAILY_BUDGET or reduce SEED_TARGET_TOKENS.`,
    );
    process.exit(1);
  }

  // Step 1: token universe
  log.info('step 1: building token universe...');
  const universe = await buildTokenUniverse({
    targetCount: targetTokens,
    minFdvUsd: minFdv,
    maxFdvUsd: maxFdv,
    minLiquidityUsd: minLiq,
    minVolume24hUsd: minVol,
    maxAgeHours,
    minAgeHours,
  });
  if (universe.length === 0) {
    log.error('empty universe — relax filters');
    process.exit(1);
  }
  log.info(
    {
      tokens: universe.length,
      preview: universe.slice(0, 8).map((t) => `${t.symbol ?? t.mint.slice(0, 4)}(${t.sources.size}src)`).join(', '),
    },
    'universe ready',
  );

  // Step 2: discover swappers
  log.info('step 2: pulling swap transactions from Helius (this is the credit-spending step)');
  const events = await discoverSwappers(
    universe.map((t) => t.mint),
    pages,
  );
  if (events.length === 0) {
    log.error('no swap events returned — Helius API issue or empty tokens');
    process.exit(1);
  }

  // Step 3 & 4: aggregate, filter, rank
  log.info('step 3-4: aggregating + scoring wallets');
  const ranked = rankWallets(events, {
    minTokens,
    minMedianGapSec: minGapSec,
    requireNetAccumulation: requireNetAccum,
  });

  log.info(
    {
      totalWalletsObserved: new Set(events.map((e) => e.wallet)).size,
      passedFilters: ranked.length,
      eventsTotal: events.length,
    },
    'ranking done',
  );

  // Step 5: optional cluster dedup
  let final: typeof ranked = ranked;
  if (cluster && ranked.length > 0) {
    log.info('step 5: cluster dedup via funding source (uses extra credits)');
    final = await dedupByFundingSource(ranked.slice(0, limit * 3));
    log.info({ before: ranked.length, after: final.length }, 'cluster dedup done');
  }

  final = final.slice(0, limit);

  // Print preview
  console.log('\nTop wallets ranked by composite quality score:');
  console.log(
    'Wallet                                              Score Tokens Swaps  B/S      Volume USD  GapSec  TopConc',
  );
  console.log(
    '--------------------------------------------------  ----- ------ -----  -------  ----------- ------- -------',
  );
  for (const w of final.slice(0, 25)) {
    const wallet = w.wallet.padEnd(50);
    const score = w.score.toFixed(1).padStart(5);
    const tk = String(w.tokenCount).padStart(6);
    const sw = String(w.swapCount).padStart(5);
    const bs = `${w.buyCount}/${w.sellCount}`.padStart(7);
    const vol = `$${Math.round(w.volumeUsd).toLocaleString()}`.padStart(11);
    const gap = (Number.isFinite(w.medianGapSec) ? Math.round(w.medianGapSec) : NaN).toString().padStart(7);
    const conc = w.topTokenConcentration.toFixed(2).padStart(7);
    console.log(`${wallet}  ${score} ${tk} ${sw}  ${bs}  ${vol} ${gap} ${conc}`);
  }
  console.log('');

  const after = await getUsageSnapshot();
  log.info(
    {
      todayUsed: after.today,
      delta: after.today - before.today,
      monthlyUsed: after.thisMonth,
      monthlyDelta: after.thisMonth - before.thisMonth,
    },
    'helius credit snapshot (after run)',
  );

  if (dryRun) {
    log.info('SEED_DRY_RUN=1; not writing to DB');
    process.exit(0);
  }

  if (final.length === 0) {
    log.warn('nothing to insert — relax filters (try SEED_MIN_TOKENS=2)');
    process.exit(0);
  }

  log.info('step 6: upserting into watchlist_wallets');
  let inserted = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const w of final) {
      const note = formatNote(w);
      const existing = await tx
        .select({ wallet: schema.watchlistWallets.wallet })
        .from(schema.watchlistWallets)
        .where(dsql`${schema.watchlistWallets.wallet} = ${w.wallet}`)
        .limit(1);
      if (existing.length === 0) {
        await tx.insert(schema.watchlistWallets).values({
          wallet: w.wallet,
          source: 'helius-seed',
          note,
        });
        inserted++;
      } else {
        await tx
          .update(schema.watchlistWallets)
          .set({ removedAt: null, note })
          .where(dsql`${schema.watchlistWallets.wallet} = ${w.wallet}`);
        updated++;
      }
    }
  });

  log.info({ inserted, updated, total: final.length }, 'seed complete');
  log.info('next: confirm `npm run watchlist:show`, then ensure HELIUS_MODE=wallets and `pm2 restart sa-api`');
  process.exit(0);
}

function formatNote(w: WalletFeatures & { score: number }): string {
  return [
    `score=${w.score.toFixed(1)}`,
    `tk=${w.tokenCount}`,
    `sw=${w.swapCount}`,
    `bs=${w.buyCount}/${w.sellCount}`,
    `vol=$${Math.round(w.volumeUsd)}`,
    `gap=${Number.isFinite(w.medianGapSec) ? Math.round(w.medianGapSec) : 'NA'}s`,
    `conc=${w.topTokenConcentration.toFixed(2)}`,
  ].join(' ');
}

/**
 * Group wallets by their funding source (the wallet that sent them their first SOL).
 *
 * Cost: 1 page per wallet via /addresses/{wallet}/transactions?type=TRANSFER&limit=1
 * Caps at 200 wallets to bound credit spend.
 */
async function dedupByFundingSource<T extends { wallet: string; score: number }>(
  ranked: T[],
): Promise<T[]> {
  const cap = Math.min(ranked.length, 200);
  const fundedBy = new Map<string, string>(); // wallet -> funder
  for (let i = 0; i < cap; i++) {
    const w = ranked[i]!.wallet;
    try {
      const res = await heliusFetch({
        url: `https://api.helius.xyz/v0/addresses/${w}/transactions?api-key=${config.heliusApiKey}&type=TRANSFER&limit=1`,
        kind: 'wallet_history',
        note: `cluster:${w.slice(0, 6)}`,
      });
      if (res.statusCode === 200) {
        const txs = (await res.body.json()) as Array<{
          tokenTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string }>;
          nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string }>;
        }>;
        const tx = txs[0];
        const incoming =
          tx?.nativeTransfers?.find((t) => t.toUserAccount === w)?.fromUserAccount ??
          tx?.tokenTransfers?.find((t) => t.toUserAccount === w)?.fromUserAccount;
        if (incoming) fundedBy.set(w, incoming);
      }
    } catch (err) {
      if (err instanceof HeliusGuardError) {
        log.warn({ reason: err.reason }, 'cluster dedup halted by guard');
        break;
      }
      log.warn({ err: String(err), wallet: w }, 'funding lookup failed');
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Keep the highest-score wallet per funder cluster
  const bestPerCluster = new Map<string, T>();
  const unclustered: T[] = [];
  for (const w of ranked) {
    const funder = fundedBy.get(w.wallet);
    if (!funder) {
      unclustered.push(w);
      continue;
    }
    const cur = bestPerCluster.get(funder);
    if (!cur || cur.score < w.score) bestPerCluster.set(funder, w);
  }

  return [...bestPerCluster.values(), ...unclustered].sort((a, b) => b.score - a.score);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'seed failed');
  process.exit(1);
});
