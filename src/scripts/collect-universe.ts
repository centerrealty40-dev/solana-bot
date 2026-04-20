import { promises as fs } from 'node:fs';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { findPumpedTokens, type PumpedToken } from '../collectors/dex-pumped.js';
import { getSwappersForToken, type SwapEvent } from '../collectors/helius-discovery.js';
import { getUsageSnapshot } from '../core/helius-guard.js';

const log = child('collect-universe');

/**
 * Universe collector — gathers a wide pool of ACTIVE Solana tokens (not just
 * pumped ones) and dumps their recent swap history to disk. The output cache
 * file is in the same shape as `cache/pump.json` so it's a drop-in input
 * for `npm run whales:extract` (and through it, the H8 rotation pipeline).
 *
 * Why a separate command from `seed:pump`:
 *   - seed:pump targets pumped tokens specifically (priceChange filter), and
 *     writes results to `watchlist_wallets`. That's an alpha-discovery flow.
 *   - collect-universe just gathers RAW active-token data without any pump
 *     filter and without DB writes. Output is purely for downstream offline
 *     use (extract-whales → rotation discovery).
 *
 * The shared cache shape lets us keep extract-whales completely unaware of
 * which collector produced its input. Same code path, different breadth.
 *
 * CLI flags via env vars (defaults tuned for "wide net, modest depth"):
 *   UNIV_TARGET_TOKENS=100      tokens to scan (cost: tokens * pages * 100 credits)
 *   UNIV_PAGES=5                Helius pages per token
 *   UNIV_MIN_LIQ=10000          min on-chain liquidity USD
 *   UNIV_MIN_VOL=20000          min 24h volume USD
 *   UNIV_MIN_AGE_HOURS=2        min token age in hours (skip pure launchpads)
 *   UNIV_MAX_AGE_DAYS=30        max token age (older tokens have less rotation signal)
 *   UNIV_OUT=cache/universe.json   output path
 *   UNIV_DRY_RUN=1              show plan + budget check, don't fetch
 */

interface UniverseCache {
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

  const targetTokens = Number(process.env.UNIV_TARGET_TOKENS ?? 100);
  const pages = Number(process.env.UNIV_PAGES ?? 5);
  const minLiq = Number(process.env.UNIV_MIN_LIQ ?? 10_000);
  const minVol = Number(process.env.UNIV_MIN_VOL ?? 20_000);
  const minAgeHours = Number(process.env.UNIV_MIN_AGE_HOURS ?? 2);
  const maxAgeDays = Number(process.env.UNIV_MAX_AGE_DAYS ?? 30);
  const outPath = process.env.UNIV_OUT ?? 'cache/universe.json';
  const dryRun = process.env.UNIV_DRY_RUN === '1';

  const expectedCredits = targetTokens * pages * 100;
  log.info(
    {
      targetTokens,
      pages,
      minLiq,
      minVol,
      minAgeHours,
      maxAgeDays,
      outPath,
      expectedCredits,
      dryRun,
    },
    'plan: universe collection',
  );

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
      `would breach daily budget: ${before.today} + ${expectedCredits} > ${before.dailyBudget}; raise HELIUS_DAILY_BUDGET or lower UNIV_TARGET_TOKENS / UNIV_PAGES`,
    );
    process.exit(1);
  }

  if (dryRun) {
    log.info('UNIV_DRY_RUN=1; not fetching');
    process.exit(0);
  }

  // Step 1: pull WIDE token universe — minPriceChangePct=0 keeps everything
  // active, regardless of whether it pumped. We want operator wallets, and
  // they show up in any token with real flow, not just winners.
  log.info('step 1: collecting wide token universe from DexScreener');
  const tokens = await findPumpedTokens({
    minPriceChangePct: 0,
    maxPriceChangePct: 99_999,
    minLiquidityUsd: minLiq,
    minVolume24hUsd: minVol,
    minAgeHours,
    maxAgeHours: maxAgeDays * 24,
    limit: targetTokens,
  });
  if (tokens.length === 0) {
    log.error('no tokens found — relax UNIV_MIN_LIQ / UNIV_MIN_VOL');
    process.exit(1);
  }
  log.info(
    {
      requested: targetTokens,
      collected: tokens.length,
      preview: tokens.slice(0, 8).map((t) => `${t.symbol ?? t.mint.slice(0, 4)}($${Math.round(t.liquidityUsd / 1000)}k liq)`).join(', '),
    },
    'token universe assembled',
  );

  // Step 2: pull swap history per token (the credit-spending step)
  log.info('step 2: pulling swap history per token via Helius');
  const perTokenEvents: Record<string, SwapEvent[]> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    try {
      const events = await getSwappersForToken(t.mint, pages);
      perTokenEvents[t.mint] = events;
      log.info(
        {
          progress: `${i + 1}/${tokens.length}`,
          mint: t.mint.slice(0, 8),
          symbol: t.symbol,
          events: events.length,
        },
        'token history pulled',
      );
    } catch (err) {
      log.warn(
        { mint: t.mint.slice(0, 8), err: String(err) },
        'token history failed (skipping)',
      );
      perTokenEvents[t.mint] = [];
    }
  }

  const cache: UniverseCache = { pumped: tokens, perTokenEvents };

  // Ensure output directory exists
  const outDir = outPath.substring(0, outPath.lastIndexOf('/'));
  if (outDir) {
    await fs.mkdir(outDir, { recursive: true });
  }
  await fs.writeFile(outPath, JSON.stringify(cache));

  const totalEvents = Object.values(perTokenEvents).reduce((s, arr) => s + arr.length, 0);
  log.info(
    {
      path: outPath,
      tokens: tokens.length,
      totalEvents,
    },
    'universe cache written',
  );

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
  log.info(
    `next: npm run whales:extract -- --in ${outPath} --out seeds/whales-universe.txt --top 300 --min-sol 0`,
  );
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'collect-universe failed');
  process.exit(1);
});
