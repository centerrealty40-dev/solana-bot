import { promises as fs } from 'node:fs';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { findLongformWinners, type LongformWinner } from '../collectors/dex-longform.js';
import { getDeepHistoryForToken, type SwapEvent } from '../collectors/helius-discovery.js';
import { getJupPrices } from '../collectors/jupiter-price.js';
import { QUOTE_MINTS } from '../core/constants.js';
import { getUsageSnapshot } from '../core/helius-guard.js';
import {
  extractLongformEarlyBuyers,
  aggregateLongformHits,
  collapseLongformFleets,
  formatLongformNote,
  type LongformHit,
} from '../scoring/longform-alpha.js';

const log = child('seed-longform');

/**
 * Long-form alpha watchlist seeder.
 *
 * Algorithm:
 *   1. findLongformWinners: tokens 14-90 days old, FDV > $3M, liquid + active.
 *      These are the "this token did 50x over weeks" candidates — selected by
 *      age + size proxy, no historical price data needed.
 *   2. For each winner, pull DEEP swap history (back to launch + a couple
 *      days of buffer). Cost: ~5,000-15,000 credits per token.
 *   3. extractLongformEarlyBuyers: within first earlyWindowDays of launch,
 *      skip the first skipFirst (= sniper batch), require >= minSolPerBuy SOL,
 *      keep up to topN ranks. These are humans who aped early WITH money.
 *   4. aggregateLongformHits: cross-tabulate. Wallets in 2+ winners = signal.
 *   5. collapseLongformFleets: drop mirror-bot duplicates.
 *   6. UPSERT into watchlist_wallets with source='longform-seed'.
 *
 * CLI flags via env vars:
 *   LONGFORM_TARGET_TOKENS=15        long-form winners to scan
 *   LONGFORM_MIN_FDV=3000000         minimum current FDV (proxy for "grew big")
 *   LONGFORM_MAX_FDV=500000000       skip mega-caps where alpha is gone
 *   LONGFORM_MIN_LIQ=200000          minimum liquidity
 *   LONGFORM_MIN_VOL=50000           minimum 24h volume
 *   LONGFORM_MIN_AGE_DAYS=14         minimum pair age
 *   LONGFORM_MAX_AGE_DAYS=90         maximum pair age
 *   LONGFORM_MAX_PAGES=200           max history pages per token (cost cap)
 *   LONGFORM_EARLY_WINDOW_DAYS=7     window from launch to consider "early"
 *   LONGFORM_SKIP_FIRST=30           skip first N buyers (sniper zone)
 *   LONGFORM_TOP_BUYERS=500          how many post-skip buyers to keep
 *   LONGFORM_MIN_SOL=0.3             minimum SOL per entry buy (anti-dust)
 *   LONGFORM_MIN_HITS=2              wallet must appear in N+ winners
 *   LONGFORM_LIMIT=200               max wallets to insert
 *   LONGFORM_DRY_RUN=1               show plan, don't write to DB
 *   LONGFORM_PURGE_OLD=1             soft-delete prior longform-seed not in new top
 *   LONGFORM_DUMP=path.json          dump events+winners to disk for re-tuning
 *   LONGFORM_LOAD=path.json          skip Helius+DexScreener, load cache (FREE)
 *   LONGFORM_ANTI_FLEET=1            collapse mirror wallets (default on)
 */

interface LongformCache {
  winners: LongformWinner[];
  perTokenEvents: Record<string, SwapEvent[]>;
}

async function main(): Promise<void> {
  if (config.heliusMode === 'off') {
    log.error('HELIUS_MODE=off; set HELIUS_MODE=wallets in .env first');
    process.exit(1);
  }
  if (!config.heliusApiKey) {
    log.error('HELIUS_API_KEY is empty');
    process.exit(1);
  }

  const targetTokens = Number(process.env.LONGFORM_TARGET_TOKENS ?? 15);
  const minFdv = Number(process.env.LONGFORM_MIN_FDV ?? 3_000_000);
  const maxFdv = Number(process.env.LONGFORM_MAX_FDV ?? 500_000_000);
  const minLiq = Number(process.env.LONGFORM_MIN_LIQ ?? 200_000);
  const minVol = Number(process.env.LONGFORM_MIN_VOL ?? 50_000);
  const minAgeDays = Number(process.env.LONGFORM_MIN_AGE_DAYS ?? 14);
  const maxAgeDays = Number(process.env.LONGFORM_MAX_AGE_DAYS ?? 90);
  const maxPages = Number(process.env.LONGFORM_MAX_PAGES ?? 200);
  const earlyWindowDays = Number(process.env.LONGFORM_EARLY_WINDOW_DAYS ?? 7);
  const skipFirst = Number(process.env.LONGFORM_SKIP_FIRST ?? 30);
  const topBuyers = Number(process.env.LONGFORM_TOP_BUYERS ?? 500);
  const minSol = Number(process.env.LONGFORM_MIN_SOL ?? 0.3);
  const minHits = Number(process.env.LONGFORM_MIN_HITS ?? 2);
  const limit = Number(process.env.LONGFORM_LIMIT ?? 200);
  const dryRun = process.env.LONGFORM_DRY_RUN === '1';
  const purgeOld = process.env.LONGFORM_PURGE_OLD === '1';
  const dumpPath = process.env.LONGFORM_DUMP ?? '';
  const loadPath = process.env.LONGFORM_LOAD ?? '';
  const antiFleet = process.env.LONGFORM_ANTI_FLEET !== '0';

  let cache: LongformCache;
  let before: Awaited<ReturnType<typeof getUsageSnapshot>> | null = null;

  if (loadPath) {
    log.info({ path: loadPath }, 'LONGFORM_LOAD: skipping Helius/DexScreener (FREE)');
    const raw = await fs.readFile(loadPath, 'utf8');
    cache = JSON.parse(raw) as LongformCache;
    log.info(
      {
        tokens: cache.winners.length,
        totalEvents: Object.values(cache.perTokenEvents).reduce((s, arr) => s + arr.length, 0),
      },
      'cache loaded',
    );
  } else {
    // Conservative cost estimate: assume each token uses up to 60% of maxPages
    const estCredits = Math.round(targetTokens * maxPages * 0.6 * 100);
    log.info(
      {
        targetTokens,
        maxPages,
        earlyWindowDays,
        skipFirst,
        topBuyers,
        minSol,
        minHits,
        estCredits,
        dryRun,
      },
      'plan: long-form alpha discovery',
    );

    before = await getUsageSnapshot();
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
    if (before.today + estCredits > before.dailyBudget) {
      log.error(
        `would breach daily budget: ${before.today} + ${estCredits} > ${before.dailyBudget}; raise HELIUS_DAILY_BUDGET or lower LONGFORM_TARGET_TOKENS / LONGFORM_MAX_PAGES`,
      );
      process.exit(1);
    }

    log.info('step 1: searching DexScreener for long-form winners');
    const winners = await findLongformWinners({
      minFdvUsd: minFdv,
      maxFdvUsd: maxFdv,
      minLiquidityUsd: minLiq,
      minVolume24hUsd: minVol,
      minAgeDays,
      maxAgeDays,
      limit: targetTokens,
    });
    if (winners.length === 0) {
      log.error('no long-form winners found — relax LONGFORM_MIN_FDV or LONGFORM_MIN_AGE_DAYS');
      process.exit(1);
    }

    const quotePrices = await getJupPrices([QUOTE_MINTS.SOL, QUOTE_MINTS.USDC, QUOTE_MINTS.USDT]);

    log.info('step 2: pulling deep history per winner (back to launch)');
    const perTokenEvents: Record<string, SwapEvent[]> = {};
    for (let i = 0; i < winners.length; i++) {
      const t = winners[i]!;
      // Stop pagination once we've reached a few days BEFORE launch (buffer)
      const untilTs = Math.floor(t.pairCreatedAt / 1000) - 86400;
      const events = await getDeepHistoryForToken(t.mint, maxPages, untilTs, quotePrices);
      perTokenEvents[t.mint] = events;
      log.info(
        {
          progress: `${i + 1}/${winners.length}`,
          mint: t.mint.slice(0, 8),
          symbol: t.symbol,
          fdvM: (t.fdvUsd / 1e6).toFixed(1),
          ageDays: t.ageDays.toFixed(0),
          events: events.length,
        },
        'token history pulled',
      );
    }

    cache = { winners, perTokenEvents };

    if (dumpPath) {
      await fs.writeFile(dumpPath, JSON.stringify(cache));
      log.info({ path: dumpPath }, 'long-form cache dumped to disk for offline re-tuning');
    }
  }

  // Step 3: per-token early-window buyers, post-sniper-zone, with money
  log.info('step 3: extracting early-window buyers per winner');
  const perTokenHits: LongformHit[][] = [];
  for (const t of cache.winners) {
    const events = cache.perTokenEvents[t.mint] ?? [];
    if (events.length === 0) continue;
    const hits = extractLongformEarlyBuyers(events, {
      pairCreatedAt: t.pairCreatedAt,
      earlyWindowDays,
      skipFirst,
      topN: topBuyers,
      minSolPerBuy: minSol,
    });
    perTokenHits.push(hits);
    log.debug(
      {
        symbol: t.symbol,
        mint: t.mint.slice(0, 8),
        eventCount: events.length,
        earlyBuyers: hits.length,
      },
      'token early buyers extracted',
    );
  }

  const totalHits = perTokenHits.reduce((s, arr) => s + arr.length, 0);
  const distinctEarlyWallets = new Set(perTokenHits.flat().map((h) => h.wallet)).size;
  log.info(
    {
      tokens: cache.winners.length,
      totalEarlyBuyerSlots: totalHits,
      distinctEarlyWallets,
    },
    'early buyer extraction done',
  );

  // Step 4: cross-aggregate
  log.info({ minHits }, 'step 4: aggregating cross-token alpha hits');
  let alpha = aggregateLongformHits(perTokenHits, { minHits });
  log.info(
    { walletsWithMultiHits: alpha.length, maxHits: alpha[0]?.hitCount ?? 0 },
    'aggregation done',
  );

  // Step 5: anti-fleet
  if (antiFleet && alpha.length > 1) {
    const beforeFleet = alpha.length;
    alpha = collapseLongformFleets(alpha);
    if (alpha.length < beforeFleet) {
      log.info(
        { before: beforeFleet, after: alpha.length, collapsed: beforeFleet - alpha.length },
        'anti-fleet: collapsed mirror wallets',
      );
    }
  }

  alpha = alpha.slice(0, limit);

  // Print preview table
  console.log('\nTop long-form alpha wallets:');
  console.log(
    'Wallet                                              Score Hits AvgRank   SolIn  HitsPreview',
  );
  console.log(
    '--------------------------------------------------  ----- ---- -------  ------  ------------------------',
  );
  const symByMint = new Map(cache.winners.map((t) => [t.mint, t.symbol]));
  for (const w of alpha.slice(0, 30)) {
    const wallet = w.wallet.padEnd(50);
    const score = w.score.toFixed(1).padStart(5);
    const hits = String(w.hitCount).padStart(4);
    const ar = w.avgRank.toFixed(0).padStart(7);
    const sol = `${w.totalSolSpent.toFixed(2)}`.padStart(6);
    const hitsList = w.hits
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 4)
      .map((h) => `${symByMint.get(h.mint) ?? h.mint.slice(0, 4)}#${h.rank}`)
      .join(',');
    console.log(`${wallet}  ${score} ${hits} ${ar}  ${sol}  ${hitsList}`);
  }
  console.log('');

  if (before) {
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
  }

  if (dryRun) {
    log.info('LONGFORM_DRY_RUN=1; not writing to DB');
    process.exit(0);
  }

  if (alpha.length === 0) {
    log.warn(
      'nothing to insert — relax LONGFORM_MIN_HITS or LONGFORM_MIN_SOL, or check that LONGFORM_SKIP_FIRST is not too aggressive for thin tokens',
    );
    process.exit(0);
  }

  log.info('step 6: upserting into watchlist_wallets');
  let inserted = 0;
  let updated = 0;
  let purged = 0;
  await db.transaction(async (tx) => {
    if (purgeOld) {
      const finalSet = alpha.map((w) => w.wallet);
      const stale = await tx.execute(dsql`
        UPDATE watchlist_wallets
        SET removed_at = NOW()
        WHERE source = 'longform-seed'
          AND removed_at IS NULL
          AND wallet NOT IN (${dsql.join(
            finalSet.map((w) => dsql`${w}`),
            dsql`, `,
          )})
        RETURNING wallet
      `);
      purged =
        (stale as { rowCount?: number; length?: number }).rowCount ??
        (Array.isArray(stale) ? stale.length : 0);
    }
    for (const w of alpha) {
      const note = formatLongformNote(w, cache.winners);
      const existing = await tx
        .select({ wallet: schema.watchlistWallets.wallet })
        .from(schema.watchlistWallets)
        .where(dsql`${schema.watchlistWallets.wallet} = ${w.wallet}`)
        .limit(1);
      if (existing.length === 0) {
        await tx.insert(schema.watchlistWallets).values({
          wallet: w.wallet,
          source: 'longform-seed',
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

  log.info({ inserted, updated, purged, total: alpha.length }, 'longform-seed complete');
  log.info(
    'next: `npm run watchlist:deepdive` to validate trader behavior, then `npm run watchlist:show`',
  );
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'longform-seed failed');
  process.exit(1);
});
