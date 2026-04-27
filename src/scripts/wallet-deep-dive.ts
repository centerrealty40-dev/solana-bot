import { promises as fs } from 'node:fs';
import { sql as dsql, isNull, eq, and } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { getWalletSwapHistory, type SwapEvent } from '../collectors/helius-discovery.js';
import { getJupPrices } from '../collectors/jupiter-price.js';
import { QUOTE_MINTS } from '../core/constants.js';
import { getUsageSnapshot } from '../core/helius-guard.js';
import {
  scoreWallet,
  shouldKeep,
  formatDeepDiveNote,
  type DeepDiveMetrics,
} from '../scoring/wallet-deepdive.js';

const log = child('deep-dive');

/**
 * Wallet deep-dive CLI.
 *
 * Pulls each candidate wallet's full SWAP history from Helius, computes
 * trader-quality metrics (sell ratio, roundtrip ratio, hold time, PnL when
 * pricing available), classifies them, and prints a verdict table.
 *
 * Optionally annotates the watchlist_wallets.note field, or soft-removes
 * wallets that classify as throwaway/buy_only/sniper_bot.
 *
 * Source of wallets (in priority order):
 *   1. DEEPDIVE_WALLETS=W1,W2,W3        — explicit list
 *   2. DEEPDIVE_FILE=path/to/file.txt   — newline-separated list
 *   3. else: read all source='pump-seed' active wallets from DB
 *
 * Cost: pages * 100 credits per wallet. Default 5 pages = 500 credits each.
 *   10 wallets * 500 = 5,000 credits (very cheap vs 8M monthly budget).
 *
 * Flags:
 *   DEEPDIVE_PAGES=5         pages per wallet (each = 100 swaps = 100 credits)
 *   DEEPDIVE_DRY_RUN=1       print verdicts only, do not touch DB
 *   DEEPDIVE_PURGE=1         soft-remove wallets that fail shouldKeep()
 *   DEEPDIVE_MIN_SCORE=30    threshold for shouldKeep
 *   DEEPDIVE_DUMP=path.json  cache history to disk for offline re-scoring
 *   DEEPDIVE_LOAD=path.json  skip Helius, use cached history (FREE re-scoring)
 *   DEEPDIVE_SOURCE=pump-seed  watchlist source filter when reading DB
 */

interface DeepDiveCache {
  history: Record<string, SwapEvent[]>;
}

async function loadCandidateWallets(): Promise<string[]> {
  if (process.env.DEEPDIVE_WALLETS) {
    return process.env.DEEPDIVE_WALLETS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (process.env.DEEPDIVE_FILE) {
    const raw = await fs.readFile(process.env.DEEPDIVE_FILE, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
  }
  const source = process.env.DEEPDIVE_SOURCE ?? 'pump-seed';
  const rows = await db
    .select({ wallet: schema.watchlistWallets.wallet })
    .from(schema.watchlistWallets)
    .where(
      and(
        eq(schema.watchlistWallets.source, source),
        isNull(schema.watchlistWallets.removedAt),
      ),
    );
  return rows.map((r) => r.wallet);
}

async function main(): Promise<void> {
  const dryRun = process.env.DEEPDIVE_DRY_RUN === '1';
  const purge = process.env.DEEPDIVE_PURGE === '1';
  const pages = Number(process.env.DEEPDIVE_PAGES ?? 5);
  const minScore = Number(process.env.DEEPDIVE_MIN_SCORE ?? 30);
  const dumpPath = process.env.DEEPDIVE_DUMP ?? '';
  const loadPath = process.env.DEEPDIVE_LOAD ?? '';

  const wallets = await loadCandidateWallets();
  if (wallets.length === 0) {
    log.error('no wallets to deep-dive — provide DEEPDIVE_WALLETS, DEEPDIVE_FILE, or seed pump-seed first');
    process.exit(1);
  }
  log.info({ wallets: wallets.length, pages, dryRun, purge, minScore }, 'plan: deep-dive');

  let history: Record<string, SwapEvent[]>;
  let before: Awaited<ReturnType<typeof getUsageSnapshot>> | null = null;

  if (loadPath) {
    log.info({ path: loadPath }, 'DEEPDIVE_LOAD: reading history from disk (FREE)');
    const raw = await fs.readFile(loadPath, 'utf8');
    const cache = JSON.parse(raw) as DeepDiveCache;
    history = cache.history;
    log.info({ wallets: Object.keys(history).length }, 'cache loaded');
  } else {
    if (config.heliusMode === 'off') {
      log.error('HELIUS_MODE=off; set HELIUS_MODE=wallets in .env first');
      process.exit(1);
    }
    if (!config.heliusApiKey) {
      log.error('HELIUS_API_KEY is empty');
      process.exit(1);
    }

    const expectedCredits = wallets.length * pages * 100;
    before = await getUsageSnapshot();
    log.info(
      {
        mode: before.mode,
        todayUsed: before.today,
        todayBudget: before.dailyBudget,
        expectedCredits,
      },
      'helius credit snapshot (before run)',
    );
    if (before.today + expectedCredits > before.dailyBudget) {
      log.error(
        `would breach daily budget: ${before.today} + ${expectedCredits} > ${before.dailyBudget}; raise HELIUS_DAILY_BUDGET or lower DEEPDIVE_PAGES`,
      );
      process.exit(1);
    }

    log.info('pulling wallet histories from Helius');
    const quotePrices = await getJupPrices([QUOTE_MINTS.SOL, QUOTE_MINTS.USDC, QUOTE_MINTS.USDT]);
    history = {};
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i]!;
      const evs = await getWalletSwapHistory(w, pages, quotePrices);
      history[w] = evs;
      log.info(
        { progress: `${i + 1}/${wallets.length}`, wallet: w.slice(0, 8), events: evs.length },
        'history pulled',
      );
    }

    if (dumpPath) {
      await fs.writeFile(dumpPath, JSON.stringify({ history }));
      log.info({ path: dumpPath }, 'history cache dumped');
    }
  }

  // Score every wallet
  const metrics: DeepDiveMetrics[] = [];
  for (const w of wallets) {
    const evs = history[w] ?? [];
    metrics.push(scoreWallet(w, evs));
  }
  metrics.sort((a, b) => b.score - a.score);

  // Print verdict table
  console.log('\nWallet deep-dive verdicts (sorted by score):');
  console.log(
    'Wallet                                              Class         Score Swaps Mints SellR Round Days  Hold       Win  PnL$',
  );
  console.log(
    '--------------------------------------------------  ------------  ----- ----- ----- ----- ----- ----  ---------  ---  -------',
  );
  for (const m of metrics) {
    const wallet = m.wallet.padEnd(50);
    const klass = m.klass.padEnd(12);
    const score = m.score.toFixed(1).padStart(5);
    const swaps = String(m.totalSwaps).padStart(5);
    const mints = String(m.distinctMints).padStart(5);
    const sellR = `${(m.sellRatio * 100).toFixed(0)}%`.padStart(5);
    const round = `${(m.roundtripRatio * 100).toFixed(0)}%`.padStart(5);
    const days = m.daysActive.toFixed(1).padStart(4);
    const h = m.medianHoldSec;
    const hold = (h === 0
      ? '-'
      : h < 60
        ? `${Math.round(h)}s`
        : h < 3600
          ? `${(h / 60).toFixed(0)}m`
          : h < 86400
            ? `${(h / 3600).toFixed(1)}h`
            : `${(h / 86400).toFixed(1)}d`
    ).padStart(9);
    const win =
      m.pricedClosedPositions >= 3 ? `${(m.winRate * 100).toFixed(0)}%`.padStart(3) : ' - ';
    const pnl =
      m.pricedClosedPositions >= 3 ? `$${Math.round(m.sumPnlUsd)}`.padStart(7) : '      -';
    console.log(
      `${wallet}  ${klass}  ${score} ${swaps} ${mints} ${sellR} ${round} ${days}  ${hold}  ${win}  ${pnl}`,
    );
  }
  console.log('');

  // Class distribution summary
  const classCount = new Map<string, number>();
  for (const m of metrics) classCount.set(m.klass, (classCount.get(m.klass) ?? 0) + 1);
  log.info(
    {
      classDistribution: Object.fromEntries(classCount),
      kept: metrics.filter((m) => shouldKeep(m, { minScore })).length,
      dropped: metrics.filter((m) => !shouldKeep(m, { minScore })).length,
    },
    'classification summary',
  );

  if (before) {
    const after = await getUsageSnapshot();
    log.info(
      {
        todayUsed: after.today,
        delta: after.today - before.today,
      },
      'helius credit snapshot (after run)',
    );
  }

  if (dryRun) {
    log.info('DEEPDIVE_DRY_RUN=1; not writing to DB');
    process.exit(0);
  }

  // Annotate watchlist with the verdict (note + optionally remove)
  log.info('annotating watchlist_wallets with deep-dive notes');
  let annotated = 0;
  let removed = 0;
  await db.transaction(async (tx) => {
    for (const m of metrics) {
      const note = formatDeepDiveNote(m);
      const existing = await tx
        .select({ wallet: schema.watchlistWallets.wallet, note: schema.watchlistWallets.note })
        .from(schema.watchlistWallets)
        .where(dsql`${schema.watchlistWallets.wallet} = ${m.wallet}`)
        .limit(1);
      if (existing.length === 0) continue; // not in watchlist (came from CLI list); skip
      const merged = existing[0]!.note ? `${existing[0]!.note} | dd: ${note}` : `dd: ${note}`;
      if (purge && !shouldKeep(m, { minScore })) {
        await tx
          .update(schema.watchlistWallets)
          .set({ removedAt: new Date(), note: merged })
          .where(dsql`${schema.watchlistWallets.wallet} = ${m.wallet}`);
        removed++;
      } else {
        await tx
          .update(schema.watchlistWallets)
          .set({ note: merged })
          .where(dsql`${schema.watchlistWallets.wallet} = ${m.wallet}`);
        annotated++;
      }
    }
  });

  log.info({ annotated, removed }, 'deep-dive complete');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'deep-dive failed');
  process.exit(1);
});
