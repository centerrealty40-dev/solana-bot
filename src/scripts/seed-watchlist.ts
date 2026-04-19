import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import {
  getTopSolanaTokens,
  aggregateTopTraders,
  filterSmartMoneyCandidates,
} from '../collectors/birdeye.js';
import { child } from '../core/logger.js';

const log = child('seed-watchlist');

/**
 * Seed `watchlist_wallets` with smart-money candidates discovered via Birdeye.
 *
 * Algorithm:
 *   1. Pull top N tokens by 24h USD volume on Solana (Birdeye /defi/tokenlist).
 *   2. For each token, pull top traders (Birdeye /defi/v2/tokens/top_traders).
 *   3. Aggregate by wallet: count distinct tokens, sum volume, sum trades.
 *   4. Filter junk (CEX hot wallets, MEV bots, one-shot lucky wallets).
 *   5. Take top K by `tokensCount × sqrt(volume)` ranking.
 *   6. UPSERT into watchlist_wallets with source='birdeye-seed'.
 *
 * Helius is NOT touched anywhere in this flow — it's pure Birdeye + Postgres.
 *
 * CLI flags via env vars:
 *   SEED_TOKENS=30          how many tokens to scan (after bluechip filter)
 *   SEED_PER_TOKEN=10       how many top traders per token
 *   SEED_LIMIT=150          max wallets to insert
 *   SEED_MIN_TOKENS=2       wallet must appear in >= this many tokens' top
 *   SEED_MIN_FDV=1000000    min FDV $ for token universe (skip dust/scams)
 *   SEED_MAX_FDV=500000000  max FDV $ for token universe (skip bluechips)
 *   SEED_DRY_RUN=1          show what would be inserted, do not write
 */
async function main(): Promise<void> {
  if (!config.birdeyeApiKey) {
    log.error(
      'BIRDEYE_API_KEY is empty; register a free key at https://bds.birdeye.so/ and put it in .env',
    );
    process.exit(1);
  }

  const seedTokens = Number(process.env.SEED_TOKENS ?? 30);
  const perToken = Number(process.env.SEED_PER_TOKEN ?? 10);
  const limit = Number(process.env.SEED_LIMIT ?? 150);
  const minTokens = Number(process.env.SEED_MIN_TOKENS ?? 2);
  const minFdv = Number(process.env.SEED_MIN_FDV ?? 1_000_000);
  const maxFdv = Number(process.env.SEED_MAX_FDV ?? 500_000_000);
  const dryRun = process.env.SEED_DRY_RUN === '1';

  log.info(
    { seedTokens, perToken, limit, minTokens, minFdv, maxFdv, dryRun },
    'seeding watchlist from Birdeye top traders',
  );

  log.info('step 1: fetching top SOL tokens by 24h USD volume (excluding bluechips)...');
  const tokens = await getTopSolanaTokens(seedTokens, { minFdvUsd: minFdv, maxFdvUsd: maxFdv });
  if (tokens.length === 0) {
    log.error('no tokens returned by Birdeye; check API key and quota');
    process.exit(1);
  }
  log.info(
    {
      count: tokens.length,
      symbols: tokens.map((t) => t.symbol).join(', '),
    },
    'token universe loaded',
  );

  log.info(
    `step 2: fetching top ${perToken} traders per token (~${tokens.length * 2.5}s with polite rate-limit)`,
  );
  const aggregated = await aggregateTopTraders(
    tokens.map((t) => t.address),
    perToken,
  );
  log.info({ uniqueWallets: aggregated.length }, 'aggregation done');

  log.info('step 3: filtering candidates...');
  const candidates = filterSmartMoneyCandidates(aggregated, { minTokens, limit });
  log.info(
    {
      filtered: candidates.length,
      droppedJunk: aggregated.length - candidates.length,
    },
    'filtering done',
  );

  if (candidates.length === 0) {
    log.warn('no candidates passed filters — try lowering SEED_MIN_TOKENS=1');
    process.exit(0);
  }

  console.log('\nTop 10 candidates by ranking:');
  console.log('Wallet                                              Tokens  Trades   Volume USD');
  console.log('--------------------------------------------------  ------  ------  -----------');
  for (const c of candidates.slice(0, 10)) {
    const w = c.wallet.padEnd(50);
    const k = String(c.tokensCount).padStart(6);
    const tr = String(c.totalTrades).padStart(6);
    const v = `$${Math.round(c.totalVolumeUsd).toLocaleString()}`.padStart(11);
    console.log(`${w}  ${k}  ${tr}  ${v}`);
  }
  console.log('');

  if (dryRun) {
    log.info('SEED_DRY_RUN=1; not writing to DB');
    process.exit(0);
  }

  log.info('step 4: upserting into watchlist_wallets...');
  let inserted = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const c of candidates) {
      const existing = await tx
        .select({ wallet: schema.watchlistWallets.wallet })
        .from(schema.watchlistWallets)
        .where(dsql`${schema.watchlistWallets.wallet} = ${c.wallet}`)
        .limit(1);

      if (existing.length === 0) {
        await tx.insert(schema.watchlistWallets).values({
          wallet: c.wallet,
          source: 'birdeye-seed',
          note: `tokens=${c.tokensCount} trades=${c.totalTrades} vol=$${Math.round(c.totalVolumeUsd)}`,
        });
        inserted++;
      } else {
        await tx
          .update(schema.watchlistWallets)
          .set({
            removedAt: null,
            note: `tokens=${c.tokensCount} trades=${c.totalTrades} vol=$${Math.round(c.totalVolumeUsd)}`,
          })
          .where(dsql`${schema.watchlistWallets.wallet} = ${c.wallet}`);
        updated++;
      }
    }
  });

  log.info({ inserted, updated, total: candidates.length }, 'seed complete');
  log.info(
    'Next: review with `npm run watchlist:show`, then set HELIUS_MODE=wallets in .env',
  );
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'seed failed');
  process.exit(1);
});
