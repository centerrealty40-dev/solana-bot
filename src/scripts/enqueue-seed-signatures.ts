/**
 * Enqueueer for the signatures-seed-worker.
 *
 * Источники кандидатов:
 *   1) `tokens.metadata->>'source' = ENQ_SOURCE` (default `dexscreener_seed`).
 *   2) `pumpswap_pair_snapshots` — свежие PumpSwap-мяты (если включён ENQ_INCLUDE_PUMPSWAP=1).
 *
 * Только мяты, у которых нет строк в `swaps` (если ENQ_REQUIRE_NO_SWAPS=1) и которых
 * ещё нет в очереди.
 *
 * Env:
 *   ENQ_SOURCE=dexscreener_seed
 *   ENQ_INCLUDE_PUMPSWAP=1
 *   ENQ_PUMPSWAP_MIN_LIQ_USD=15000
 *   ENQ_PUMPSWAP_MAX_AGE_HOURS=48
 *   ENQ_BATCH=60                 — общий потолок добавленных за раз
 *   ENQ_MAX_AGE_HOURS=48
 *   ENQ_REQUIRE_NO_SWAPS=1
 *   ENQ_DRY_RUN=1
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('enqueue-seed-signatures');

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const SRC = (process.env.ENQ_SOURCE || 'dexscreener_seed').replace(/'/g, "''");
const BATCH = Math.max(1, Math.min(envNum('ENQ_BATCH', 60), 500));
const MAX_AGE_HOURS = Math.max(1, envNum('ENQ_MAX_AGE_HOURS', 48));
const REQUIRE_NO_SWAPS = process.env.ENQ_REQUIRE_NO_SWAPS !== '0';
const DRY = process.env.ENQ_DRY_RUN === '1';
const INCLUDE_PUMPSWAP = process.env.ENQ_INCLUDE_PUMPSWAP !== '0';
const PUMPSWAP_MIN_LIQ_USD = envNum('ENQ_PUMPSWAP_MIN_LIQ_USD', 15_000);
const PUMPSWAP_MAX_AGE_HOURS = Math.max(1, envNum('ENQ_PUMPSWAP_MAX_AGE_HOURS', 48));

interface CandidateRow {
  mint: string;
}

async function ensureQueue(): Promise<void> {
  await db.execute(dsql.raw(`
    CREATE TABLE IF NOT EXISTS signatures_seed_queue (
      mint text PRIMARY KEY,
      added_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'queued',
      attempts int NOT NULL DEFAULT 0,
      last_error text,
      signatures_fetched int NOT NULL DEFAULT 0,
      tx_fetched int NOT NULL DEFAULT 0,
      finished_at timestamptz
    );
  `));
}

async function tableExists(name: string): Promise<boolean> {
  const r = await db.execute(
    dsql.raw(`SELECT to_regclass('public.${name.replace(/[^a-z0-9_]/gi, '')}') AS t`),
  );
  const row = (Array.isArray(r) ? r[0] : (r as { rows?: { t?: unknown }[] }).rows?.[0]) as
    | { t?: unknown }
    | undefined;
  return Boolean(row?.t);
}

async function pickFromTokensSource(limit: number): Promise<CandidateRow[]> {
  if (limit <= 0) return [];
  const noSwapsCond = REQUIRE_NO_SWAPS
    ? `AND NOT EXISTS (SELECT 1 FROM swaps s WHERE s.base_mint = t.mint LIMIT 1)`
    : '';
  const r: unknown = await db.execute(dsql.raw(`
    SELECT t.mint
    FROM tokens t
    LEFT JOIN signatures_seed_queue q ON q.mint = t.mint
    WHERE t.metadata->>'source' = '${SRC}'
      AND t.first_seen_at >= now() - interval '${MAX_AGE_HOURS} hours'
      AND q.mint IS NULL
      ${noSwapsCond}
    ORDER BY t.first_seen_at DESC
    LIMIT ${limit}
  `));
  const rows = Array.isArray(r) ? r : ((r as { rows?: CandidateRow[] }).rows ?? []);
  return rows as CandidateRow[];
}

async function pickFromPumpSwap(limit: number): Promise<CandidateRow[]> {
  if (limit <= 0 || !INCLUDE_PUMPSWAP) return [];
  if (!(await tableExists('pumpswap_pair_snapshots'))) return [];
  const noSwapsCond = REQUIRE_NO_SWAPS
    ? `AND NOT EXISTS (SELECT 1 FROM swaps s WHERE s.base_mint = p.base_mint LIMIT 1)`
    : '';
  const r: unknown = await db.execute(dsql.raw(`
    WITH latest AS (
      SELECT base_mint, MAX(ts) AS ts, MAX(liquidity_usd) AS liq
      FROM pumpswap_pair_snapshots
      WHERE ts >= now() - interval '${PUMPSWAP_MAX_AGE_HOURS} hours'
      GROUP BY base_mint
    )
    SELECT p.base_mint AS mint
    FROM latest p
    LEFT JOIN signatures_seed_queue q ON q.mint = p.base_mint
    WHERE q.mint IS NULL
      AND COALESCE(p.liq, 0) >= ${PUMPSWAP_MIN_LIQ_USD}
      ${noSwapsCond}
    ORDER BY p.ts DESC
    LIMIT ${limit}
  `));
  const rows = Array.isArray(r) ? r : ((r as { rows?: CandidateRow[] }).rows ?? []);
  return rows as CandidateRow[];
}

async function pickCandidates(): Promise<CandidateRow[]> {
  const halfA = Math.ceil(BATCH / 2);
  const halfB = BATCH - halfA;
  const a = await pickFromTokensSource(halfA);
  const b = await pickFromPumpSwap(halfB + (halfA - a.length));
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const x of [...a, ...b]) {
    if (!seen.has(x.mint)) {
      out.push(x);
      seen.add(x.mint);
    }
    if (out.length >= BATCH) break;
  }
  return out;
}

async function main(): Promise<void> {
  await ensureQueue();
  const list = await pickCandidates();
  if (list.length === 0) {
    log.info({ src: SRC, batch: BATCH }, 'no new candidates');
    process.exit(0);
  }
  if (DRY) {
    log.info({ candidates: list.length, dryRun: true }, 'enqueue (dry run)');
    for (const r of list) console.log(r.mint);
    process.exit(0);
  }
  for (const r of list) {
    try {
      await db.execute(dsql.raw(`
        INSERT INTO signatures_seed_queue (mint) VALUES ('${r.mint.replace(/'/g, "''")}')
        ON CONFLICT (mint) DO NOTHING
      `));
    } catch (e) {
      log.warn({ mint: r.mint, err: String(e) }, 'enqueue failed');
    }
  }
  log.info({ enqueued: list.length, src: SRC }, 'done');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
