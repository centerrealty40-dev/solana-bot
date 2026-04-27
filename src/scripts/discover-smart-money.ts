/**
 * Discover wallets that look like *real* early smart money (repeatedly early on
 * runner tokens) and are NOT in our scam tag set. Intended for daily cron.
 *
 * Heuristic (conservative for copy-trading safety):
 * - "Runner" mint: max(market_cap) from DEX snapshots >= MIN_RUNNER_MCAP_USD.
 * - "Early" buy: first buy window [mint_t0, mint_t0 + EARLY_WINDOW_MIN) from swaps.
 * - "Clean mint": no early buyer in the same window has a scam/operator tag
 *   (primary_tag or wallet_tags) — if a scammer was early, the whole mint is
 *   discarded for everyone.
 * - "Clean wallet": buyer not in scam tag / primary set.
 * - Tag smart_money (source=discover_sm_run) if wallet has >= MIN_GOOD_HITS
 *   distinct clean runner mints where they were early.
 *
 * After inserting tags, re-runs wallet-tagger on each wallet so primary_tag
 * respects PRIORITY (scam > smart, etc.).
 *
 * Limitation (v1): only wallets already marked scam/operator in bad_wallets are
 * excluded; unknown scammers with no tag can still be counted as “clean” until
 * manual review or future detectors add them to the atlas.
 *
 * Env:
 *   LOOKBACK_DAYS (default 90) — swaps window
 *   EARLY_WINDOW_MIN (default 15)
 *   MIN_RUNNER_MCAP_USD (default 200_000)
 *   MIN_GOOD_HITS (default 3)
 *   MIN_EARLY_BUY_USD (default 0) — if >0, early buy must have amount_usd >= this
 *   MAX_CANDIDATES (default 5000) — cap on ranked candidates (safety in live run)
 *   DRY_RUN=1 — only print candidates, no DB writes
 *   DISCOVER_SM_TELEGRAM=0 — отключить суточное уведомление в Telegram
 *   DISCOVER_SM_SEND_IN_DRY=1 — слать в Telegram и при DRY_RUN (для теста)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — из .env (как у остальных job)
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';
import { tagWallet } from '../intel/wallet-tagger.js';
import { notifyDiscoverSmartMoneyRun } from '../runner/telegram.js';

const log = child('discover-smart-money');

/** Aligned with live-paper PAPER_SCAM_TAGS / wallet-tagger scam classes */
const SCAM_TAGS = [
  'scam_operator',
  'scam_proxy',
  'scam_treasury',
  'scam_payout',
  'bot_farm_distributor',
  'bot_farm_boss',
  'gas_distributor',
  'terminal_distributor',
  'insider',
  'cex_hot_wallet',
] as const;

const SCAM_IN = SCAM_TAGS.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const LOOKBACK_DAYS = envNum('LOOKBACK_DAYS', 90);
const EARLY_WINDOW_MIN = envNum('EARLY_WINDOW_MIN', 15);
const MIN_RUNNER_MCAP = envNum('MIN_RUNNER_MCAP_USD', 200_000);
const MIN_GOOD_HITS = envNum('MIN_GOOD_HITS', 3);
const MIN_EARLY_BUY_USD = envNum('MIN_EARLY_BUY_USD', 0);
const MAX_CANDIDATES = Math.max(1, Math.min(envNum('MAX_CANDIDATES', 5000), 1_000_000));
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const EARLY_BUY_USD_FILTER =
  MIN_EARLY_BUY_USD > 0
    ? `AND s.amount_usd >= ${MIN_EARLY_BUY_USD}`
    : '';

interface Candidate {
  wallet: string;
  good_hits: number;
  early_mints: number;
}

export async function discoverSmartMoneyRunners(): Promise<{
  candidates: Candidate[];
  tagged: number;
  dryRun: boolean;
}> {
  const q = `
WITH
-- First swap we ever saw for a mint: must be recent → approx "new" listings we index from the start
mint_t0 AS (
  SELECT base_mint, MIN(block_time) AS t0
  FROM swaps
  GROUP BY base_mint
  HAVING MIN(block_time) >= now() - (interval '1 day' * ${LOOKBACK_DAYS})
),
peak_mcap AS (
  SELECT s.base_mint, MAX(s.mx) AS peak_mcap
  FROM (
    SELECT base_mint, market_cap_usd::double precision AS mx
    FROM raydium_pair_snapshots
    WHERE market_cap_usd IS NOT NULL
    UNION ALL
    SELECT base_mint, market_cap_usd::double precision AS mx
    FROM meteora_pair_snapshots
    WHERE market_cap_usd IS NOT NULL
  ) s
  GROUP BY s.base_mint
),
runners AS (
  SELECT base_mint
  FROM peak_mcap
  WHERE peak_mcap >= ${MIN_RUNNER_MCAP}
),
bad_wallets AS (
  SELECT DISTINCT w.wallet
  FROM (
    SELECT wallet FROM entity_wallets WHERE primary_tag IN (${SCAM_IN})
    UNION
    SELECT wallet FROM wallet_tags WHERE tag IN (${SCAM_IN})
  ) w
),
early_buys AS (
  SELECT s.wallet, s.base_mint, t.t0
  FROM swaps s
  JOIN mint_t0 t ON t.base_mint = s.base_mint
  WHERE s.side = 'buy'
    AND s.block_time >= t.t0
    AND s.block_time <  t.t0 + interval '${EARLY_WINDOW_MIN} minutes'
    AND s.base_mint IN (SELECT base_mint FROM runners)
    ${EARLY_BUY_USD_FILTER}
),
-- Mint is toxic if any early buyer in the window is a known scam-tagged wallet
toxic_mints AS (
  SELECT DISTINCT e.base_mint
  FROM early_buys e
  WHERE e.wallet IN (SELECT wallet FROM bad_wallets)
),
clean_early AS (
  SELECT e.wallet, e.base_mint
  FROM early_buys e
  WHERE e.base_mint NOT IN (SELECT base_mint FROM toxic_mints)
    AND e.wallet NOT IN (SELECT wallet FROM bad_wallets)
    AND e.base_mint IN (SELECT base_mint FROM runners)
),
per_wallet AS (
  SELECT
    wallet,
    COUNT(DISTINCT base_mint)::int AS good_hits,
    COUNT(DISTINCT base_mint)::int AS early_mints
  FROM clean_early
  GROUP BY wallet
)
SELECT wallet, good_hits, early_mints
FROM per_wallet
WHERE good_hits >= ${MIN_GOOD_HITS}
ORDER BY good_hits DESC, early_mints DESC
LIMIT ${MAX_CANDIDATES};
`;

  const r: unknown = await db.execute(dsql.raw(q));
  const raw: Candidate[] = Array.isArray(r) ? (r as Candidate[]) : ((r as { rows?: Candidate[] }).rows ?? []);
  const candidates: Candidate[] = raw.map((row) => ({
    wallet: String(row.wallet),
    good_hits: Number(row.good_hits),
    early_mints: Number(row.early_mints),
  }));

  if (DRY_RUN) {
    log.info(
      {
        n: candidates.length,
        dryRun: true,
        minEarlyBuyUsd: MIN_EARLY_BUY_USD,
        maxCandidates: MAX_CANDIDATES,
      },
      'discover-smart-money (dry run)',
    );
    return { candidates, tagged: 0, dryRun: true };
  }

  const TAG = 'smart_money' as const;
  const SOURCE = 'discover_sm_run';
  const CONF = 62;

  let tagged = 0;
  const BATCH = Math.max(1, Math.min(envNum('DISCOVER_SM_BATCH', 200), 1000));
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    try {
      await db
        .insert(schema.entityWallets)
        .values(slice.map((r) => ({ wallet: r.wallet })))
        .onConflictDoNothing();

      await db
        .insert(schema.walletTags)
        .values(
          slice.map((r) => ({
            wallet: r.wallet,
            tag: TAG,
            source: SOURCE,
            confidence: CONF,
            context: `gh=${r.good_hits}|em=${r.early_mints}|mcmcap>=${MIN_RUNNER_MCAP}|lb=${LOOKBACK_DAYS}d`.slice(0, 2000),
          })),
        )
        .onConflictDoNothing();
    } catch (err) {
      log.warn({ batchSize: slice.length, err: String(err) }, 'batch tag insert failed');
      continue;
    }

    for (const r of slice) {
      try {
        await tagWallet(r.wallet);
        tagged += 1;
      } catch (err) {
        log.warn({ wallet: r.wallet, err: String(err) }, 'tagWallet failed');
      }
    }
  }

  log.info({ candidates: candidates.length, tagged }, 'discover-smart-money done');
  return { candidates, tagged, dryRun: false };
}

async function main(): Promise<void> {
  const { candidates, tagged, dryRun } = await discoverSmartMoneyRunners();
  if (dryRun) {
    console.log(`DRY_RUN: would tag ${candidates.length} wallets (showing up to 30)`);
    for (const c of candidates.slice(0, 30)) {
      console.log(`${c.wallet}\tgh=${c.good_hits}\tem=${c.early_mints}`);
    }
  } else {
    console.log(`tagged ${tagged} / ${candidates.length} candidates`);
  }
  try {
    await notifyDiscoverSmartMoneyRun({
      candidates: candidates.length,
      tagged,
      dryRun,
    });
  } catch (e) {
    log.warn({ err: String(e) }, 'discover-smart-money telegram failed');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
