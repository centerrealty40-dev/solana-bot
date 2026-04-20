import { promises as fs } from 'node:fs';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { QUOTE_MINTS } from '../core/constants.js';
import { getJupPrices } from '../collectors/jupiter-price.js';
import { getWalletTransfers, type TransferEvent } from '../collectors/wallet-transfers.js';
import { getWalletSwapHistory, type SwapEvent } from '../collectors/helius-discovery.js';
import {
  buildRotationGraph,
  buildIncomingGraph,
  detectFanInOutliers,
  detectParentOperators,
  detectBidirectionalHubs,
  detectPassThroughRouters,
  computeBehavior,
  scoreRotationCandidate,
  collapseRotationFleets,
  formatRotationNote,
  type RotationCandidate,
  type CandidateProfile,
  type ParentOperator,
} from '../scoring/rotation-graph.js';
import { getUsageSnapshot } from '../core/helius-guard.js';

const log = child('seed-rotation');

/**
 * Rotation Network watchlist seeder (H8) — discovers HIDDEN alpha wallets by
 * tracing where existing alpha wallets send their capital. Real pros rotate
 * accounts to avoid copy-trading detection; the funding graph reveals them.
 *
 * Algorithm:
 *   1. Load seed wallets from `watchlist_wallets` (sources: helius-seed,
 *      pump-seed, longform-seed) or from a CLI list/file.
 *   2. For each seed, pull recent TRANSFER history (outgoing SOL/USDC/USDT
 *      legs of meaningful size).
 *   3. Build the funder→candidate graph; exclude CEX hot wallets, DEX
 *      programs, and seeds themselves.
 *   4. Detect fan-in outliers (>40% of seeds funding the same address) =
 *      almost certainly a CEX we don't have in our hardcoded list.
 *   5. Score each candidate on funding-graph evidence alone.
 *   6. For top-K candidates, pull a SHALLOW swap history page to verify they
 *      are active traders (not passive holders or one-shot recipients).
 *   7. Rescore with behavior modifiers; collapse near-duplicate fleets;
 *      UPSERT top results into watchlist_wallets with source='rotation-seed'.
 *
 * CLI flags via env vars:
 *   ROT_SEED_SOURCES=helius-seed,pump-seed,longform-seed
 *                                  watchlist sources to use as seeds (default: all 3)
 *   ROT_SEED_FILE=path.txt         alternative: newline-separated seed wallets
 *   ROT_SEED_LIMIT=80              cap on number of seed wallets to scan
 *   ROT_TRANSFER_PAGES=2           Helius pages of transfers per seed
 *                                  (cost: pages * 100 credits per seed)
 *   ROT_MIN_SOL_PER_EDGE=0.5       drop transfers under this size (anti-dust)
 *   ROT_MIN_FUNDERS=1              candidate must have >= this many distinct funders
 *                                  (set 2+ for cross-seed rotation only)
 *   ROT_FAN_IN_CAP=auto            override the auto fan-in cap (CEX detection)
 *   ROT_VERIFY_TOP=80              top-N candidates to deep-verify with swap history
 *   ROT_VERIFY_PAGES=1             swap history pages per verified candidate
 *   ROT_LIMIT=200                  max wallets to insert
 *   ROT_DRY_RUN=1                  show plan, do not write
 *   ROT_PURGE_OLD=1                soft-delete prior rotation-seed not in new top
 *   ROT_DUMP=path.json             dump all collected data after run (offline tuning)
 *   ROT_LOAD=path.json             skip Helius, load from file (FREE)
 *   ROT_ANTI_FLEET=1               collapse near-duplicate wallets (default on)
 *   ROT_BIDIRECTIONAL=1            also analyze INCOMING transfers to detect
 *                                  parent operators + bidirectional hubs (default on,
 *                                  free — same Helius data, just opposite direction)
 *   ROT_MIN_PARENT_CHILDREN=2      parent must fund >= N seeds to be flagged
 *   ROT_PROMOTE_PARENTS=1          insert top parents as source='rotation-parent'
 *                                  (default on; their treasury wallets are gold)
 *   ROT_PARENT_LIMIT=50            cap on parents to insert
 *   ROT_HUB_BONUS=30               score bonus added to bidirectional hubs
 *                                  (candidates that are ALSO parents of multiple seeds)
 *   ROT_HUB_REQUIRES_SWAP=1        only apply BI-HUB bonus when candidate has 1+
 *                                  own swap (default on; pass-through routers
 *                                  with 0 swaps don't get boosted)
 *   ROT_DROP_ROUTERS=1             drop pass-through routers entirely (5+ funders
 *                                  AND 5+ children AND 0 swaps AND >50 SOL flow);
 *                                  these are likely CEX hot wallets (default on)
 *   ROT_ROUTER_MIN_EDGES=5         router detection: min funders == min children
 *   ROT_ROUTER_MIN_SOL=50          router detection: min total SOL throughput
 */

interface RotationCache {
  seedToTransfers: Record<string, TransferEvent[]>;
  candidateToSwaps: Record<string, SwapEvent[]>;
  solPriceUsd: number;
}

async function loadSeeds(): Promise<string[]> {
  const file = process.env.ROT_SEED_FILE ?? '';
  if (file) {
    const raw = await fs.readFile(file, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
    return Array.from(new Set(lines));
  }
  const sources = (process.env.ROT_SEED_SOURCES ?? 'helius-seed,pump-seed,longform-seed')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const limit = Number(process.env.ROT_SEED_LIMIT ?? 80);

  const rows = await db
    .select({ wallet: schema.watchlistWallets.wallet, source: schema.watchlistWallets.source })
    .from(schema.watchlistWallets)
    .where(
      dsql`${schema.watchlistWallets.removedAt} IS NULL AND ${schema.watchlistWallets.source} IN (${dsql.join(
        sources.map((s) => dsql`${s}`),
        dsql`, `,
      )})`,
    )
    .limit(limit);
  return Array.from(new Set(rows.map((r) => r.wallet)));
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

  const transferPages = Number(process.env.ROT_TRANSFER_PAGES ?? 2);
  const minSolPerEdge = Number(process.env.ROT_MIN_SOL_PER_EDGE ?? 0.5);
  const minFunders = Number(process.env.ROT_MIN_FUNDERS ?? 1);
  const fanInCapOverride = process.env.ROT_FAN_IN_CAP
    ? Number(process.env.ROT_FAN_IN_CAP)
    : undefined;
  const verifyTop = Number(process.env.ROT_VERIFY_TOP ?? 80);
  const verifyPages = Number(process.env.ROT_VERIFY_PAGES ?? 1);
  const limit = Number(process.env.ROT_LIMIT ?? 200);
  const dryRun = process.env.ROT_DRY_RUN === '1';
  const purgeOld = process.env.ROT_PURGE_OLD === '1';
  const dumpPath = process.env.ROT_DUMP ?? '';
  const loadPath = process.env.ROT_LOAD ?? '';
  const antiFleet = process.env.ROT_ANTI_FLEET !== '0';
  const bidirectional = process.env.ROT_BIDIRECTIONAL !== '0';
  const minParentChildren = Number(process.env.ROT_MIN_PARENT_CHILDREN ?? 2);
  const promoteParents = process.env.ROT_PROMOTE_PARENTS !== '0';
  const parentLimit = Number(process.env.ROT_PARENT_LIMIT ?? 50);
  const hubBonus = Number(process.env.ROT_HUB_BONUS ?? 30);
  const hubRequiresSwap = process.env.ROT_HUB_REQUIRES_SWAP !== '0';
  const dropRouters = process.env.ROT_DROP_ROUTERS !== '0';
  const routerMinEdges = Number(process.env.ROT_ROUTER_MIN_EDGES ?? 5);
  const routerMinSol = Number(process.env.ROT_ROUTER_MIN_SOL ?? 50);

  let cache: RotationCache;
  let before: Awaited<ReturnType<typeof getUsageSnapshot>> | null = null;
  let seeds: string[] = [];

  if (loadPath) {
    log.info({ path: loadPath }, 'ROT_LOAD: skipping Helius, loading from disk (FREE)');
    const raw = await fs.readFile(loadPath, 'utf8');
    cache = JSON.parse(raw) as RotationCache;
    seeds = Object.keys(cache.seedToTransfers);
    const totalTransfers = Object.values(cache.seedToTransfers).reduce(
      (s, arr) => s + arr.length,
      0,
    );
    const totalSwaps = Object.values(cache.candidateToSwaps).reduce(
      (s, arr) => s + arr.length,
      0,
    );
    log.info(
      {
        seeds: seeds.length,
        totalTransfers,
        verifiedCandidates: Object.keys(cache.candidateToSwaps).length,
        totalSwaps,
      },
      'rotation cache loaded',
    );
  } else {
    seeds = await loadSeeds();
    if (seeds.length === 0) {
      log.error(
        'no seed wallets found — populate watchlist first or pass ROT_SEED_FILE=path.txt',
      );
      process.exit(1);
    }
    const stage1Credits = seeds.length * transferPages * 100;
    const stage2Credits = verifyTop * verifyPages * 100;
    const expectedCredits = stage1Credits + stage2Credits;
    log.info(
      {
        seeds: seeds.length,
        transferPages,
        verifyTop,
        verifyPages,
        stage1Credits,
        stage2Credits,
        expectedCredits,
        dryRun,
      },
      'plan: H8 rotation network discovery',
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
        `would breach daily budget: ${before.today} + ${expectedCredits} > ${before.dailyBudget}; raise HELIUS_DAILY_BUDGET, lower ROT_TRANSFER_PAGES, or lower ROT_VERIFY_TOP`,
      );
      process.exit(1);
    }

    log.info('step 1: fetching SOL price (for USD-equivalent on transfers)');
    const prices = await getJupPrices([QUOTE_MINTS.SOL, QUOTE_MINTS.USDC, QUOTE_MINTS.USDT]);
    const solPriceUsd = prices[QUOTE_MINTS.SOL] ?? 0;
    log.info({ solPriceUsd }, 'sol price resolved');

    const fetchDirection = bidirectional ? 'both' : 'out';
    log.info(
      { direction: fetchDirection, bidirectional },
      'step 2: pulling transfer history per seed (credit-spending)' +
        (bidirectional ? '; using BOTH directions to catch parent operators (no extra cost)' : ''),
    );
    const seedToTransfers: Record<string, TransferEvent[]> = {};
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i]!;
      const txs = await getWalletTransfers(s, transferPages, solPriceUsd, {
        direction: fetchDirection,
        minAmountSol: minSolPerEdge,
      });
      seedToTransfers[s] = txs;
      if ((i + 1) % 10 === 0 || i === seeds.length - 1) {
        log.info(
          { progress: `${i + 1}/${seeds.length}`, transfersThisSeed: txs.length },
          'seed transfers progress',
        );
      }
    }

    log.info('step 3: building funder→candidate graph');
    const { candidates: stage1Candidates } = buildRotationGraph(seedToTransfers, {
      minSolPerEdge,
    });
    log.info(
      {
        rawCandidates: stage1Candidates.size,
        totalSeeds: seeds.length,
      },
      'graph built',
    );

    // Auto-detect CEX/MM fan-in outliers and remove
    const outliers = detectFanInOutliers(stage1Candidates, seeds.length, fanInCapOverride);
    for (const o of outliers) stage1Candidates.delete(o);
    if (outliers.size > 0) {
      log.info(
        { removed: outliers.size, sample: Array.from(outliers).slice(0, 5) },
        'fan-in outliers removed (suspected CEX/MM)',
      );
    }

    // Apply min-funders filter and rank for verification
    let preVerify = Array.from(stage1Candidates.values()).filter(
      (p) => p.funders.length >= minFunders,
    );
    log.info(
      { afterMinFunders: preVerify.length, minFunders },
      'min-funders filter applied',
    );

    // Rank for verification by funding-only score
    preVerify.sort((a, b) => {
      const sa = a.funders.length * 30 + Math.log10(1 + a.totalSol) * 8;
      const sb = b.funders.length * 30 + Math.log10(1 + b.totalSol) * 8;
      return sb - sa;
    });
    const toVerify = preVerify.slice(0, verifyTop);
    log.info({ toVerify: toVerify.length }, 'top candidates selected for swap verification');

    log.info('step 4: verifying candidates with swap history (credit-spending)');
    const candidateToSwaps: Record<string, SwapEvent[]> = {};
    for (let i = 0; i < toVerify.length; i++) {
      const c = toVerify[i]!;
      const swaps = await getWalletSwapHistory(c.wallet, verifyPages, prices);
      candidateToSwaps[c.wallet] = swaps;
      if ((i + 1) % 20 === 0 || i === toVerify.length - 1) {
        log.info(
          { progress: `${i + 1}/${toVerify.length}`, swapsThisCandidate: swaps.length },
          'candidate verification progress',
        );
      }
    }

    cache = {
      seedToTransfers,
      candidateToSwaps,
      solPriceUsd,
    };

    if (dumpPath) {
      await fs.writeFile(dumpPath, JSON.stringify(cache));
      log.info({ path: dumpPath }, 'rotation cache dumped to disk for offline re-tuning');
    }
  }

  // ── SCORING (always runs, on cached or fresh data) ─────────────────────
  log.info('step 5: scoring candidates with behavior modifiers');
  const { candidates: rebuiltCandidates } = buildRotationGraph(cache.seedToTransfers, {
    minSolPerEdge,
  });
  const outliers = detectFanInOutliers(rebuiltCandidates, seeds.length, fanInCapOverride);
  for (const o of outliers) rebuiltCandidates.delete(o);

  // Bidirectional analysis: build the parent (incoming) graph, detect operators
  // and hubs. Free if we already pulled both directions in step 2.
  let parents = new Map<string, ParentOperator>();
  let parentOps: ParentOperator[] = [];
  let hubs = new Set<string>();
  let routers = new Set<string>();
  const hasInbound = Object.values(cache.seedToTransfers).some((arr) =>
    arr.some((t) => t.direction === 'in'),
  );
  if (hasInbound) {
    parents = buildIncomingGraph(cache.seedToTransfers, { minSolPerEdge });
    parentOps = detectParentOperators(parents, seeds.length, {
      minChildren: minParentChildren,
      fanInCap: fanInCapOverride,
    });
    hubs = detectBidirectionalHubs(rebuiltCandidates, parents, minParentChildren);

    // Pass-through router detection (likely CEX hot wallets / aggregators we
    // don't have in the static blacklist). These look very strong on the graph
    // (high BI-HUB) but they don't actually trade — they just route capital.
    if (dropRouters) {
      routers = detectPassThroughRouters(rebuiltCandidates, parents, cache.candidateToSwaps, {
        minBidirectionalEdges: routerMinEdges,
        minSolFlow: routerMinSol,
      });
    }
    log.info(
      {
        rawParents: parents.size,
        confirmedParentOperators: parentOps.length,
        bidirectionalHubs: hubs.size,
        passThroughRouters: routers.size,
        minParentChildren,
        routerMinEdges,
        routerMinSol,
      },
      'incoming graph built',
    );
    if (routers.size > 0) {
      log.info(
        { sample: Array.from(routers).slice(0, 5) },
        'pass-through routers will be excluded (likely unblacklisted CEX hot wallets / aggregators)',
      );
    }
  } else {
    log.warn(
      'no inbound transfers in cache — bidirectional analysis skipped (set ROT_BIDIRECTIONAL=1 and re-fetch)',
    );
  }

  const scored: RotationCandidate[] = [];
  let droppedRouters = 0;
  let hubsBoosted = 0;
  for (const profile of rebuiltCandidates.values()) {
    if (profile.funders.length < minFunders) continue;
    if (routers.has(profile.wallet)) {
      droppedRouters++;
      continue;
    }
    const swaps = cache.candidateToSwaps[profile.wallet] ?? [];
    const behavior = computeBehavior(swaps, profile);
    const cand = scoreRotationCandidate(profile, behavior);
    // Bidirectional hub bonus: candidate is also a parent of 2+ seeds = strong
    // signal of an operator's central rotation hub. Only apply when candidate
    // has actual trading activity — otherwise it's a pass-through router.
    if (hubs.has(profile.wallet)) {
      const p = parents.get(profile.wallet)!;
      const eligible = !hubRequiresSwap || (behavior !== null && behavior.swapCount >= 1);
      if (eligible) {
        cand.score += hubBonus;
        cand.reason = `[BI-HUB ${p.children.length}↔] ` + cand.reason;
        hubsBoosted++;
      } else {
        cand.reason = `[BI-HUB-passive ${p.children.length}↔ no_swap] ` + cand.reason;
      }
    }
    scored.push(cand);
  }
  scored.sort((a, b) => b.score - a.score);
  log.info(
    {
      scored: scored.length,
      topScore: scored[0]?.score ?? 0,
      hubsBoosted,
      hubsPassive: hubs.size - hubsBoosted,
      droppedRouters,
    },
    'scoring done',
  );

  // Anti-fleet
  let final = scored;
  if (antiFleet && final.length > 1) {
    const beforeFleet = final.length;
    final = collapseRotationFleets(final);
    if (final.length < beforeFleet) {
      log.info(
        { before: beforeFleet, after: final.length, collapsed: beforeFleet - final.length },
        'anti-fleet: collapsed near-duplicate rotation accounts',
      );
    }
  }

  final = final.slice(0, limit);

  // Print preview
  console.log('\nTop rotation-network wallets:');
  console.log(
    'Wallet                                              Score Funders TotalSOL  Swaps Mints  Reason',
  );
  console.log(
    '--------------------------------------------------  ----- ------- --------  ----- -----  ---------------------------------',
  );
  for (const c of final.slice(0, 30)) {
    const wallet = c.wallet.padEnd(50);
    const score = c.score.toFixed(1).padStart(5);
    const funders = String(c.profile.funders.length).padStart(7);
    const sol = c.profile.totalSol.toFixed(1).padStart(8);
    const swaps = String(c.behavior?.swapCount ?? 0).padStart(5);
    const mints = String(c.behavior?.distinctMints ?? 0).padStart(5);
    const reason = c.reason.slice(0, 60);
    console.log(`${wallet}  ${score} ${funders} ${sol}  ${swaps} ${mints}  ${reason}`);
  }
  console.log('');

  // Parent operators table — wallets that funded multiple seeds. These are
  // likely the OPERATOR'S TREASURY / MAIN WALLET (one level up from rotation).
  if (parentOps.length > 0) {
    console.log('Top PARENT OPERATORS (treasuries that fund multiple seeds):');
    console.log(
      'Wallet                                              Children TotalSOL  WindowDays  Note',
    );
    console.log(
      '--------------------------------------------------  -------- --------  ----------  --------------------------',
    );
    for (const p of parentOps.slice(0, 20)) {
      const wallet = p.wallet.padEnd(50);
      const ch = String(p.children.length).padStart(8);
      const sol = p.totalSol.toFixed(1).padStart(8);
      const win = ((p.lastFundedTs - p.firstFundedTs) / 86_400).toFixed(1).padStart(10);
      const note =
        `funded ${p.children
          .slice(0, 3)
          .map((c) => c.slice(0, 4))
          .join(',')}` + (p.children.length > 3 ? `+${p.children.length - 3}` : '');
      console.log(`${wallet}  ${ch} ${sol}  ${win}  ${note}`);
    }
    console.log('');
  }

  // Diagnostic: distribution of why candidates didn't make it
  const totalRebuilt = rebuiltCandidates.size + outliers.size;
  const dropFanIn = outliers.size;
  const dropMinFunders = Array.from(rebuiltCandidates.values()).filter(
    (p) => p.funders.length < minFunders,
  ).length;
  const dropNoSwap = scored.filter((c) => !c.behavior).length;
  log.info(
    {
      totalCandidatesObserved: totalRebuilt,
      droppedFanInOutlier: dropFanIn,
      droppedMinFunders: dropMinFunders,
      droppedNoSwap: dropNoSwap,
      survivedToFinal: final.length,
    },
    'pipeline funnel',
  );

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
    log.info('ROT_DRY_RUN=1; not writing to DB');
    process.exit(0);
  }

  if (final.length === 0) {
    log.warn('nothing to insert — relax ROT_MIN_FUNDERS or ROT_MIN_SOL_PER_EDGE');
    process.exit(0);
  }

  log.info('step 6: upserting into watchlist_wallets');
  let inserted = 0;
  let updated = 0;
  let purged = 0;
  let parentInserted = 0;
  let parentUpdated = 0;
  const parentsToInsert =
    promoteParents && parentOps.length > 0 ? parentOps.slice(0, parentLimit) : [];
  await db.transaction(async (tx) => {
    if (purgeOld) {
      const finalSet = final.map((c) => c.wallet);
      const stale = await tx.execute(dsql`
        UPDATE watchlist_wallets
        SET removed_at = NOW()
        WHERE source = 'rotation-seed'
          AND removed_at IS NULL
          AND wallet NOT IN (${dsql.join(finalSet.map((w) => dsql`${w}`), dsql`, `)})
        RETURNING wallet
      `);
      purged =
        (stale as { rowCount?: number; length?: number }).rowCount ??
        (Array.isArray(stale) ? stale.length : 0);
    }
    for (const c of final) {
      const note = formatRotationNote(c);
      const existing = await tx
        .select({ wallet: schema.watchlistWallets.wallet })
        .from(schema.watchlistWallets)
        .where(dsql`${schema.watchlistWallets.wallet} = ${c.wallet}`)
        .limit(1);
      if (existing.length === 0) {
        await tx.insert(schema.watchlistWallets).values({
          wallet: c.wallet,
          source: 'rotation-seed',
          note,
        });
        inserted++;
      } else {
        await tx
          .update(schema.watchlistWallets)
          .set({ removedAt: null, note })
          .where(dsql`${schema.watchlistWallets.wallet} = ${c.wallet}`);
        updated++;
      }
    }
    // Promote parent operators as their own watchlist source. These are the
    // operator's treasury/main wallets — different signal than rotation hubs,
    // so we keep them under a distinct source for downstream PnL attribution.
    for (const p of parentsToInsert) {
      const sol = p.totalSol.toFixed(1);
      const note = `parent ch=${p.children.length} cap=${sol}SOL win=${(
        (p.lastFundedTs - p.firstFundedTs) / 86_400
      ).toFixed(1)}d`;
      const existing = await tx
        .select({ wallet: schema.watchlistWallets.wallet })
        .from(schema.watchlistWallets)
        .where(dsql`${schema.watchlistWallets.wallet} = ${p.wallet}`)
        .limit(1);
      if (existing.length === 0) {
        await tx.insert(schema.watchlistWallets).values({
          wallet: p.wallet,
          source: 'rotation-parent',
          note,
        });
        parentInserted++;
      } else {
        await tx
          .update(schema.watchlistWallets)
          .set({ removedAt: null, note })
          .where(dsql`${schema.watchlistWallets.wallet} = ${p.wallet}`);
        parentUpdated++;
      }
    }
  });

  log.info(
    {
      inserted,
      updated,
      purged,
      total: final.length,
      parentInserted,
      parentUpdated,
      parentTotal: parentsToInsert.length,
    },
    'rotation-seed complete',
  );
  log.info('next: `npm run watchlist:show` to inspect, then ensure HELIUS_MODE=wallets and `pm2 restart sa-api`');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'rotation-seed failed');
  process.exit(1);
});

// Re-export helper types so other scripts can introspect cache files
export type { RotationCache, CandidateProfile };
