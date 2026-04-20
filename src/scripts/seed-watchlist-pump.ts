import { promises as fs } from 'node:fs';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { findPumpedTokens, type PumpedToken } from '../collectors/dex-pumped.js';
import { getSwappersForToken, type SwapEvent } from '../collectors/helius-discovery.js';
import {
  extractEarlyBuyers,
  aggregatePumpHits,
  filterSnipers,
  collapsePumpFleets,
  formatPumpNote,
  type EarlyBuyerHit,
} from '../scoring/pump-alpha.js';
import { getUsageSnapshot } from '../core/helius-guard.js';

const log = child('seed-pump');

/**
 * Pump-retro watchlist seeder — discovers wallets with proven track records of
 * being early into tokens that subsequently pumped.
 *
 * Algorithm:
 *   1. findPumpedTokens: query DexScreener for tokens with priceChange.h24
 *      within [minPct, maxPct] AND meaningful liquidity/volume
 *   2. For each pumped token, pull deep swap history from Helius
 *   3. For each token, extract the first N chronological buyers in the
 *      lookback window — these are "early buyers of the move"
 *   4. Cross-tabulate hits across all pumped tokens: a wallet that appears
 *      early in 2+ different pumps has a real signal (one is luck)
 *   5. Drop snipers (tiny avg-USD or sub-minute spread across pump hits)
 *   6. Anti-fleet collapse (same as seed-watchlist-helius)
 *   7. UPSERT top K into watchlist_wallets with rich notes (which pumps,
 *      what rank, what $)
 *
 * CLI flags via env vars:
 *   PUMP_TARGET_TOKENS=30           pumped tokens to scan
 *   PUMP_MIN_CHANGE_PCT=100         min priceChange.h24 % (default 100 = 2x)
 *   PUMP_MAX_CHANGE_PCT=2000        max priceChange.h24 % (skip extreme rugs)
 *   PUMP_MIN_LIQ=30000              min liquidity USD on the pumped token
 *   PUMP_MIN_VOL=100000             min 24h volume USD
 *   PUMP_MIN_AGE_HOURS=6            min age (skip launchpad sniper-only window)
 *   PUMP_DEPTH_PAGES=10             Helius pages per token (cost: pages*100/token)
 *   PUMP_TOP_BUYERS=50              top-N earliest buyers per token to keep
 *   PUMP_LOOKBACK_HOURS=24          window for "early in the move"
 *   PUMP_MIN_HITS=2                 wallet must appear in N+ distinct pumps
 *   PUMP_MIN_AVG_USD=50             drop snipers spending tiny $/buy
 *   PUMP_MIN_SPREAD_SEC=60          drop multi-token sniper batches (sub-min spread)
 *   PUMP_LIMIT=200                  max wallets to insert
 *   PUMP_DRY_RUN=1                  show plan + top wallets, do not write
 *   PUMP_PURGE_OLD=1                soft-delete prior pump-seed wallets not in new top
 *   PUMP_DUMP=path.json             after fetch, dump events+pumped to file (offline tuning)
 *   PUMP_LOAD=path.json             skip Helius+DexScreener, load from file (FREE)
 *   PUMP_ANTI_FLEET=1               collapse near-duplicate wallets (default on)
 */

interface PumpCache {
  pumped: PumpedToken[];
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

  const targetTokens = Number(process.env.PUMP_TARGET_TOKENS ?? 30);
  const minChange = Number(process.env.PUMP_MIN_CHANGE_PCT ?? 100);
  const maxChange = Number(process.env.PUMP_MAX_CHANGE_PCT ?? 2000);
  const minLiq = Number(process.env.PUMP_MIN_LIQ ?? 30_000);
  const minVol = Number(process.env.PUMP_MIN_VOL ?? 100_000);
  const minAgeHours = Number(process.env.PUMP_MIN_AGE_HOURS ?? 6);
  const depthPages = Number(process.env.PUMP_DEPTH_PAGES ?? 10);
  const topBuyers = Number(process.env.PUMP_TOP_BUYERS ?? 50);
  const lookbackHours = Number(process.env.PUMP_LOOKBACK_HOURS ?? 24);
  const minHits = Number(process.env.PUMP_MIN_HITS ?? 2);
  const minAvgUsd = Number(process.env.PUMP_MIN_AVG_USD ?? 50);
  const minSpreadSec = Number(process.env.PUMP_MIN_SPREAD_SEC ?? 60);
  const limit = Number(process.env.PUMP_LIMIT ?? 200);
  const dryRun = process.env.PUMP_DRY_RUN === '1';
  const purgeOld = process.env.PUMP_PURGE_OLD === '1';
  const dumpPath = process.env.PUMP_DUMP ?? '';
  const loadPath = process.env.PUMP_LOAD ?? '';
  const antiFleet = process.env.PUMP_ANTI_FLEET !== '0';

  let cache: PumpCache;
  let before: Awaited<ReturnType<typeof getUsageSnapshot>> | null = null;

  if (loadPath) {
    log.info({ path: loadPath }, 'PUMP_LOAD: skipping Helius/DexScreener, loading from disk (FREE)');
    const raw = await fs.readFile(loadPath, 'utf8');
    cache = JSON.parse(raw) as PumpCache;
    log.info(
      {
        tokens: cache.pumped.length,
        totalEvents: Object.values(cache.perTokenEvents).reduce((s, arr) => s + arr.length, 0),
      },
      'pump cache loaded',
    );
  } else {
    const expectedCredits = targetTokens * depthPages * 100;
    log.info(
      {
        targetTokens,
        depthPages,
        topBuyers,
        lookbackHours,
        minHits,
        expectedCredits,
        dryRun,
      },
      'plan: pump retro discovery',
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
    if (before.today + expectedCredits > before.dailyBudget) {
      log.error(
        `would breach daily budget: ${before.today} + ${expectedCredits} > ${before.dailyBudget}`,
      );
      process.exit(1);
    }

    log.info('step 1: searching DexScreener for pumped tokens');
    const pumped = await findPumpedTokens({
      minPriceChangePct: minChange,
      maxPriceChangePct: maxChange,
      minLiquidityUsd: minLiq,
      minVolume24hUsd: minVol,
      minAgeHours,
      limit: targetTokens,
    });
    if (pumped.length === 0) {
      log.error('no pumped tokens found — relax PUMP_MIN_CHANGE_PCT or PUMP_MIN_LIQ');
      process.exit(1);
    }

    log.info('step 2: pulling deep swap history per pumped token');
    const perTokenEvents: Record<string, SwapEvent[]> = {};
    for (let i = 0; i < pumped.length; i++) {
      const t = pumped[i]!;
      const events = await getSwappersForToken(t.mint, depthPages);
      perTokenEvents[t.mint] = events;
      log.info(
        {
          progress: `${i + 1}/${pumped.length}`,
          mint: t.mint.slice(0, 8),
          symbol: t.symbol,
          priceChangeH24: Math.round(t.priceChangeH24),
          events: events.length,
        },
        'token history pulled',
      );
    }

    cache = { pumped, perTokenEvents };

    if (dumpPath) {
      await fs.writeFile(dumpPath, JSON.stringify(cache));
      log.info({ path: dumpPath }, 'pump cache dumped to disk for offline re-tuning');
    }
  }

  // Step 3: per-token early buyers
  log.info('step 3: extracting early buyers per token');
  const lookbackSec = lookbackHours * 3600;
  const perTokenHits: EarlyBuyerHit[][] = [];
  for (const t of cache.pumped) {
    const events = cache.perTokenEvents[t.mint] ?? [];
    if (events.length === 0) continue;
    const hits = extractEarlyBuyers(events, { topN: topBuyers, lookbackSec });
    perTokenHits.push(hits);
    log.debug(
      {
        symbol: t.symbol,
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
      tokens: cache.pumped.length,
      totalEarlyBuyerSlots: totalHits,
      distinctEarlyWallets,
    },
    'early buyer extraction done',
  );

  // Step 4: cross-tabulate
  log.info({ minHits }, 'step 4: aggregating cross-token alpha hits');
  let alpha = aggregatePumpHits(perTokenHits, { minHits });
  log.info(
    {
      walletsWithMultiHits: alpha.length,
      maxHits: alpha[0]?.hitCount ?? 0,
    },
    'aggregation done',
  );

  // Step 5: drop snipers
  const beforeSniper = alpha.length;
  alpha = filterSnipers(alpha, { minAvgUsd, minSpreadSec });
  log.info(
    {
      before: beforeSniper,
      after: alpha.length,
      droppedSnipers: beforeSniper - alpha.length,
    },
    'sniper filter applied',
  );

  // Step 6: anti-fleet
  if (antiFleet && alpha.length > 1) {
    const beforeFleet = alpha.length;
    alpha = collapsePumpFleets(alpha);
    if (alpha.length < beforeFleet) {
      log.info(
        { before: beforeFleet, after: alpha.length, collapsed: beforeFleet - alpha.length },
        'anti-fleet: collapsed near-duplicate wallets',
      );
    }
  }

  alpha = alpha.slice(0, limit);

  // Print preview
  console.log('\nTop pump-alpha wallets:');
  console.log(
    'Wallet                                              Score Hits AvgRank   BuyUSD  HitsPreview',
  );
  console.log(
    '--------------------------------------------------  ----- ---- -------  -------  ------------------------',
  );
  const symbolByMint = new Map(cache.pumped.map((p) => [p.mint, p.symbol]));
  for (const w of alpha.slice(0, 30)) {
    const wallet = w.wallet.padEnd(50);
    const score = w.score.toFixed(1).padStart(5);
    const hits = String(w.hitCount).padStart(4);
    const ar = w.avgRank.toFixed(1).padStart(7);
    const usd = `$${Math.round(w.totalBuyUsd).toLocaleString()}`.padStart(7);
    const hitsList = w.hits
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 4)
      .map((h) => `${symbolByMint.get(h.mint) ?? h.mint.slice(0, 4)}#${h.rank}`)
      .join(',');
    console.log(`${wallet}  ${score} ${hits} ${ar}  ${usd}  ${hitsList}`);
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
    log.info('PUMP_DRY_RUN=1; not writing to DB');
    process.exit(0);
  }

  if (alpha.length === 0) {
    log.warn('nothing to insert — relax PUMP_MIN_HITS or PUMP_MIN_AVG_USD');
    process.exit(0);
  }

  log.info('step 7: upserting into watchlist_wallets');
  let inserted = 0;
  let updated = 0;
  let purged = 0;
  await db.transaction(async (tx) => {
    if (purgeOld) {
      const finalSet = alpha.map((w) => w.wallet);
      const stale = await tx.execute(dsql`
        UPDATE watchlist_wallets
        SET removed_at = NOW()
        WHERE source = 'pump-seed'
          AND removed_at IS NULL
          AND wallet NOT IN (${dsql.join(finalSet.map((w) => dsql`${w}`), dsql`, `)})
        RETURNING wallet
      `);
      purged = (stale as { rowCount?: number; length?: number }).rowCount ?? (Array.isArray(stale) ? stale.length : 0);
    }
    for (const w of alpha) {
      const note = formatPumpNote(w, cache.pumped);
      const existing = await tx
        .select({ wallet: schema.watchlistWallets.wallet })
        .from(schema.watchlistWallets)
        .where(dsql`${schema.watchlistWallets.wallet} = ${w.wallet}`)
        .limit(1);
      if (existing.length === 0) {
        await tx.insert(schema.watchlistWallets).values({
          wallet: w.wallet,
          source: 'pump-seed',
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

  log.info({ inserted, updated, purged, total: alpha.length }, 'pump-seed complete');
  log.info('next: confirm `npm run watchlist:show`, then ensure HELIUS_MODE=wallets and `pm2 restart sa-api`');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'pump-seed failed');
  process.exit(1);
});
