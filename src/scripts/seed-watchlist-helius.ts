import { promises as fs } from 'node:fs';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { buildTokenUniverse } from '../collectors/token-universe.js';
import { discoverSwappers, deepDiveWallets, type SwapEvent } from '../collectors/helius-discovery.js';
import {
  aggregateSwapEvents,
  rankWalletsWithStats,
  type WalletFeatures,
} from '../scoring/seed-quality.js';
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
 *   SEED_DUMP_EVENTS=path.json    after fetch, dump merged events to file (for offline tuning)
 *   SEED_LOAD_EVENTS=path.json    skip Helius entirely, load events from file (FREE, fast tuning)
 *   SEED_MIN_MT_BALANCE=0.15      multi-token tier: min buy/sell balance — drops bot fleets
 *   SEED_ANTI_FLEET=1             collapse near-duplicate wallets (likely same entity) to top-1
 *   SEED_PURGE_OLD=1              soft-delete wallets from prior helius-seed runs not in current top-N
 *   SEED_MIN_SPEC_SWAPS=10        specialist tier: min swaps in their one token
 *   SEED_MIN_SPEC_VOL=2000        specialist tier: min USD volume
 *   SEED_MIN_SPEC_BALANCE=0.2     specialist tier: min buy/sell balance
 *   SEED_NO_SPECIALISTS=1         disable specialist tier entirely (multi-token only)
 *   SEED_MIN_SWAPS=4              multi-token tier: min swap count
 *   SEED_MIN_VOLUME=500           multi-token tier: min USD volume
 *   SEED_MAX_TOKENS=80            both tiers: max distinct tokens (drops MEV)
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
  const stage2 = process.env.SEED_NO_STAGE2 !== '1';
  const stage2Top = Number(process.env.SEED_STAGE2_TOP ?? 150);
  const stage2MinAppearances = Number(process.env.SEED_STAGE2_MIN_APPEARANCES ?? 2);
  const stage2Pages = Number(process.env.SEED_STAGE2_PAGES ?? 1);
  const minFdv = Number(process.env.SEED_MIN_FDV ?? 200_000);
  const maxFdv = Number(process.env.SEED_MAX_FDV ?? 1_000_000_000);
  const minLiq = Number(process.env.SEED_MIN_LIQ ?? 15_000);
  const minVol = Number(process.env.SEED_MIN_VOL ?? 30_000);
  const maxAgeHours = Number(process.env.SEED_MAX_AGE_HOURS ?? 24 * 60);
  const minAgeHours = Number(process.env.SEED_MIN_AGE_HOURS ?? 2);
  const limit = Number(process.env.SEED_LIMIT ?? 200);
  const minTokens = Number(process.env.SEED_MIN_TOKENS ?? 2);
  const allowSpecialists = process.env.SEED_NO_SPECIALISTS !== '1';
  const minGapSec = Number(process.env.SEED_MIN_GAP_SEC ?? 2);
  const maxConc = Number(process.env.SEED_MAX_CONC ?? 0.85);
  const minMtBalance = Number(process.env.SEED_MIN_MT_BALANCE ?? 0.15);
  const minSpecSwaps = Number(process.env.SEED_MIN_SPEC_SWAPS ?? 10);
  const minSpecVol = Number(process.env.SEED_MIN_SPEC_VOL ?? 2_000);
  const minSpecBalance = Number(process.env.SEED_MIN_SPEC_BALANCE ?? 0.2);
  const minSwaps = Number(process.env.SEED_MIN_SWAPS ?? 4);
  const minVolume = Number(process.env.SEED_MIN_VOLUME ?? 500);
  const maxTokens = Number(process.env.SEED_MAX_TOKENS ?? 80);
  const dumpEventsPath = process.env.SEED_DUMP_EVENTS ?? '';
  const loadEventsPath = process.env.SEED_LOAD_EVENTS ?? '';
  const antiFleet = process.env.SEED_ANTI_FLEET !== '0';
  const purgeOld = process.env.SEED_PURGE_OLD === '1';
  const dryRun = process.env.SEED_DRY_RUN === '1';
  const cluster = process.env.SEED_CLUSTER === '1';
  const requireNetAccum = process.env.SEED_REQUIRE_NET_ACCUM === '1';

  let allEvents: SwapEvent[] = [];
  let before: Awaited<ReturnType<typeof getUsageSnapshot>> | null = null;

  if (loadEventsPath) {
    log.info({ path: loadEventsPath }, 'SEED_LOAD_EVENTS: skipping Helius, loading cached events from disk (FREE)');
    const raw = await fs.readFile(loadEventsPath, 'utf8');
    allEvents = JSON.parse(raw) as SwapEvent[];
    log.info(
      {
        events: allEvents.length,
        wallets: new Set(allEvents.map((e) => e.wallet)).size,
      },
      'cached events loaded',
    );
  } else {
    const stage1Credits = targetTokens * pages * 100;
    const stage2Credits = stage2 ? stage2Top * stage2Pages * 100 : 0;
    const expectedCredits = stage1Credits + stage2Credits;
    log.info(
      {
        targetTokens,
        pages,
        stage1Credits,
        stage2,
        stage2Top,
        stage2Pages,
        stage2Credits,
        totalExpectedCredits: expectedCredits,
        cluster,
        dryRun,
        dumpEventsPath: dumpEventsPath || null,
      },
      'plan: two-stage discovery (token-side + wallet-side)',
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
        `would breach daily budget: ${before.today} + ${expectedCredits} > ${before.dailyBudget}. Increase HELIUS_DAILY_BUDGET, reduce SEED_TARGET_TOKENS, or set SEED_NO_STAGE2=1.`,
      );
      process.exit(1);
    }

    allEvents = await fetchAllEvents({
      targetTokens,
      pages,
      minFdv,
      maxFdv,
      minLiq,
      minVol,
      maxAgeHours,
      minAgeHours,
      stage2,
      stage2Top,
      stage2MinAppearances,
      stage2Pages,
    });

    if (dumpEventsPath) {
      await fs.writeFile(dumpEventsPath, JSON.stringify(allEvents));
      log.info({ path: dumpEventsPath, events: allEvents.length }, 'events dumped to disk for offline re-tuning');
    }
  }

  // Step 3 & 4: aggregate, filter, rank using merged data
  log.info('step 3-4: aggregating + scoring wallets');
  const { ranked, allFeatures, stats } = rankWalletsWithStats(allEvents, {
    minTokens,
    maxTokens,
    minSwaps,
    minVolumeUsd: minVolume,
    minMedianGapSec: minGapSec,
    maxTopTokenConcentration: maxConc,
    minMultiTokenBalance: minMtBalance,
    requireNetAccumulation: requireNetAccum,
    allowSpecialists,
    minSpecialistSwaps: minSpecSwaps,
    minSpecialistVolumeUsd: minSpecVol,
    minSpecialistBalance: minSpecBalance,
  });

  const multiToken = ranked.filter((w) => w.tokenCount >= 2).length;
  const specialists = ranked.filter((w) => w.tokenCount === 1).length;
  log.info({ multiToken, specialists }, 'breakdown of passing wallets');
  log.info(
    {
      total: stats.total,
      kept: stats.kept,
      droppedMaxTokens: stats.droppedMaxTokens,
      droppedMaxVolume: stats.droppedMaxVolume,
      droppedMaxSwaps: stats.droppedMaxSwaps,
      droppedMinGap: stats.droppedMinGap,
      droppedMinTokens: stats.droppedMinTokens,
      droppedMinVolume: stats.droppedMinVolume,
      droppedMinSwaps: stats.droppedMinSwaps,
      droppedConcentration: stats.droppedConcentration,
      droppedMultiBalance: stats.droppedMultiBalance,
      droppedSpecSwaps: stats.droppedSpecialistSwaps,
      droppedSpecVolume: stats.droppedSpecialistVolume,
      droppedSpecBalance: stats.droppedSpecialistBalance,
    },
    'filter rejection breakdown',
  );

  if (ranked.length < 20) {
    const rejects = allFeatures
      .filter((f) => !ranked.some((r) => r.wallet === f.wallet))
      .map((f) => ({ ...f, vScore: Math.log10(Math.max(1, f.volumeUsd)) + f.swapCount * 0.05 }))
      .sort((a, b) => b.vScore - a.vScore)
      .slice(0, 10);
    console.log('\nTop-10 REJECTED wallets (by activity), to help diagnose filters:');
    console.log(
      'Wallet                                              Tokens Swaps  B/S      Volume USD  GapSec  TopConc',
    );
    for (const w of rejects) {
      const wallet = w.wallet.padEnd(50);
      const tk = String(w.tokenCount).padStart(6);
      const sw = String(w.swapCount).padStart(5);
      const bs = `${w.buyCount}/${w.sellCount}`.padStart(7);
      const vol = `$${Math.round(w.volumeUsd).toLocaleString()}`.padStart(11);
      const gap = (Number.isFinite(w.medianGapSec) ? Math.round(w.medianGapSec) : NaN)
        .toString()
        .padStart(7);
      const conc = w.topTokenConcentration.toFixed(2).padStart(7);
      console.log(`${wallet}  ${tk} ${sw}  ${bs}  ${vol} ${gap} ${conc}`);
    }
    console.log('');
  }

  log.info(
    {
      totalWalletsObserved: new Set(allEvents.map((e) => e.wallet)).size,
      passedFilters: ranked.length,
      eventsTotal: allEvents.length,
    },
    'ranking done',
  );

  // Anti-fleet: collapse near-duplicate wallets (likely the same entity running N accounts).
  let postFleet: typeof ranked = ranked;
  if (antiFleet && ranked.length > 1) {
    postFleet = collapseFleets(ranked);
    if (postFleet.length < ranked.length) {
      log.info(
        { before: ranked.length, after: postFleet.length, collapsed: ranked.length - postFleet.length },
        'anti-fleet: collapsed near-duplicates (kept top-score per cluster)',
      );
    }
  }

  // Optional: cluster dedup by funding source (uses extra credits)
  let final: typeof ranked = postFleet;
  if (cluster && postFleet.length > 0) {
    log.info('step 5: cluster dedup via funding source (uses extra credits)');
    final = await dedupByFundingSource(postFleet.slice(0, limit * 3));
    log.info({ before: postFleet.length, after: final.length }, 'cluster dedup done');
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
  let purged = 0;
  await db.transaction(async (tx) => {
    const finalSet = new Set(final.map((w) => w.wallet));
    if (purgeOld) {
      const stale = await tx.execute(dsql`
        UPDATE watchlist_wallets
        SET removed_at = NOW()
        WHERE source = 'helius-seed'
          AND removed_at IS NULL
          AND wallet NOT IN (${dsql.join([...finalSet].map((w) => dsql`${w}`), dsql`, `)})
        RETURNING wallet
      `);
      purged = (stale as { rowCount?: number; length?: number }).rowCount ?? (Array.isArray(stale) ? stale.length : 0);
    }
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

  log.info({ inserted, updated, purged, total: final.length }, 'seed complete');
  log.info('next: confirm `npm run watchlist:show`, then ensure HELIUS_MODE=wallets and `pm2 restart sa-api`');
  process.exit(0);
}

/**
 * Pull the entire token universe + Stage 1 + Stage 2 events from Helius.
 * Extracted from main() so it can be skipped via SEED_LOAD_EVENTS.
 */
async function fetchAllEvents(opts: {
  targetTokens: number;
  pages: number;
  minFdv: number;
  maxFdv: number;
  minLiq: number;
  minVol: number;
  maxAgeHours: number;
  minAgeHours: number;
  stage2: boolean;
  stage2Top: number;
  stage2MinAppearances: number;
  stage2Pages: number;
}): Promise<SwapEvent[]> {
  log.info('step 1: building token universe...');
  const universe = await buildTokenUniverse({
    targetCount: opts.targetTokens,
    minFdvUsd: opts.minFdv,
    maxFdvUsd: opts.maxFdv,
    minLiquidityUsd: opts.minLiq,
    minVolume24hUsd: opts.minVol,
    maxAgeHours: opts.maxAgeHours,
    minAgeHours: opts.minAgeHours,
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

  log.info('step 2 stage-1: pulling swap transactions from Helius (token-side scan)');
  const stage1Events = await discoverSwappers(
    universe.map((t) => t.mint),
    opts.pages,
  );
  if (stage1Events.length === 0) {
    log.error('no swap events returned in stage 1 — Helius API issue or empty tokens');
    process.exit(1);
  }
  log.info(
    {
      stage1Events: stage1Events.length,
      stage1Wallets: new Set(stage1Events.map((e) => e.wallet)).size,
    },
    'stage-1 done',
  );

  let allEvents: SwapEvent[] = stage1Events;
  if (opts.stage2) {
    const stage1Agg = aggregateSwapEvents(stage1Events);
    type Cand = { wallet: string; score: number; reason: string };
    const cands: Cand[] = [];
    let dropBot = 0;
    let dropFew = 0;
    let dropDust = 0;
    for (const f of stage1Agg.values()) {
      if (f.swapCount < opts.stage2MinAppearances) {
        dropFew++;
        continue;
      }
      if (f.swapCount >= 5 && Number.isFinite(f.medianGapSec) && f.medianGapSec < 1) {
        dropBot++;
        continue;
      }
      if (f.volumeUsd < 50) {
        dropDust++;
        continue;
      }
      const breadth = Math.log10(Math.max(1, f.tokenCount)) * 2;
      const money = Math.log10(Math.max(1, f.volumeUsd)) * 1.5;
      const presence = Math.log10(f.swapCount);
      cands.push({
        wallet: f.wallet,
        score: breadth + money + presence,
        reason: `tk=${f.tokenCount} sw=${f.swapCount} vol=$${Math.round(f.volumeUsd)}`,
      });
    }
    cands.sort((a, b) => b.score - a.score);
    const candidates = cands.slice(0, opts.stage2Top).map((c) => c.wallet);

    log.info(
      {
        eligibleCands: cands.length,
        candidatesPicked: candidates.length,
        droppedBot: dropBot,
        droppedTooFew: dropFew,
        droppedDust: dropDust,
        topPreview: cands.slice(0, 5).map((c) => `${c.wallet.slice(0, 6)}(${c.reason})`).join(' | '),
      },
      'stage-2 candidate selection',
    );

    if (candidates.length > 0) {
      const stage2Events = await deepDiveWallets(candidates, opts.stage2Pages);
      const seen = new Set(stage1Events.map((e) => e.signature));
      let added = 0;
      for (const e of stage2Events) {
        if (!seen.has(e.signature)) {
          allEvents.push(e);
          added++;
        }
      }
      log.info(
        {
          stage2Events: stage2Events.length,
          newAfterDedup: added,
          totalEvents: allEvents.length,
        },
        'stage-2 merged',
      );
    }
  }

  return allEvents;
}

/**
 * Anti-fleet: collapse near-duplicate wallets that look like the same entity
 * running multiple accounts (e.g. an MM bot fleet, a sniper service mirror,
 * a wash-trading farm). We bucket by a coarse feature fingerprint and keep
 * only the highest-score wallet from each bucket.
 *
 * The fingerprint is (tokenCount bucket, swapCount log-bucket, conc bucket,
 * pure-buy flag, gap log-bucket). Wallets in the same bucket are treated as
 * one entity. Conservative defaults — only collapses very obvious fleets.
 */
function collapseFleets<T extends WalletFeatures & { score: number }>(ranked: T[]): T[] {
  const buckets = new Map<string, T>();
  for (const w of ranked) {
    const total = w.buyCount + w.sellCount;
    const pureBuy = total > 0 && w.sellCount === 0;
    const tkBucket = w.tokenCount; // exact — fleets share token count
    const swBucket = Math.round(Math.log10(Math.max(1, w.swapCount)) * 4); // ~25% bucket
    const concBucket = Math.round(w.topTokenConcentration * 10); // 10 bins
    const gap = Number.isFinite(w.medianGapSec) ? w.medianGapSec : 60;
    const gapBucket = Math.round(Math.log10(Math.max(1, gap)) * 3);
    const fp = `${tkBucket}|${swBucket}|${concBucket}|${pureBuy ? 1 : 0}|${gapBucket}`;
    const cur = buckets.get(fp);
    if (!cur || cur.score < w.score) buckets.set(fp, w);
  }
  return Array.from(buckets.values()).sort((a, b) => b.score - a.score);
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
