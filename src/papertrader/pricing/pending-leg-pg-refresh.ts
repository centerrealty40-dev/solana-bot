/**
 * Solo DexScreener refresh → PG upsert for open mints with pending entry-split legs.
 *
 * Meteora (and other) collectors tick every 2 min with 1-min `ts` buckets; Lera stale-price
 * block at 120s can reject leg-2 while the row age stays high. This path writes 30s-bucket rows
 * between collector ticks so `fetchLatestSnapshotQuote` sees a younger `MAX(ts)`.
 */
import { sql as pgSql } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { DexSnapshotSource } from '../pricing.js';
import type { OpenTrade } from '../types.js';
import { openTradeNeedsEntrySplitFastPoll } from '../executor/live-staged-entry-gates.js';
import {
  fetchDexScreenerPairDetails,
  type DexScreenerPairDetails,
} from './dexscreener-quote-cache.js';

const log = child('pending-leg-pg-refresh');

const VALID_SNAPSHOT_TABLES = new Set([
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
]);

const DEX_SOURCES: readonly DexSnapshotSource[] = [
  'raydium',
  'meteora',
  'orca',
  'moonshot',
  'pumpswap',
];

const lastRefreshByMint = new Map<string, number>();

/** Floor `nowMs` to a fixed-second UTC bucket for pending-leg PG rows. */
export function pendingLegPgRefreshBucketTs(nowMs: number, bucketSec: number): Date {
  const sec = Math.max(15, Math.min(120, Math.floor(bucketSec)));
  const bucketMs = sec * 1000;
  return new Date(Math.floor(nowMs / bucketMs) * bucketMs);
}

/** Whether cooldown elapsed since the last solo refresh for this mint. */
export function pendingLegPgRefreshDue(
  mint: string,
  nowMs: number,
  cooldownMs: number,
  lastByMint: ReadonlyMap<string, number>,
): boolean {
  if (!mint || !Number.isFinite(cooldownMs) || cooldownMs <= 0) return true;
  const last = lastByMint.get(mint) ?? 0;
  return nowMs - last >= cooldownMs;
}

export function isDexSnapshotSource(v: string | undefined | null): v is DexSnapshotSource {
  return !!v && (DEX_SOURCES as readonly string[]).includes(v);
}

/** Map DexScreener `dexId` (+ optional trade `source`) to a PG snapshot table key. */
export function resolvePendingLegSnapshotSource(
  dexId: string | null | undefined,
  tradeSource?: string | null,
): DexSnapshotSource | null {
  const preferred = tradeSource?.trim().toLowerCase();
  if (isDexSnapshotSource(preferred)) return preferred;
  const d = String(dexId ?? '').toLowerCase();
  if (!d) return null;
  if (d.includes('meteora')) return 'meteora';
  if (d.includes('raydium')) return 'raydium';
  if (d.includes('orca')) return 'orca';
  if (d.includes('moonshot')) return 'moonshot';
  if (d.includes('pumpswap') || d.includes('pump')) return 'pumpswap';
  return null;
}

export function snapshotTableForDexSource(source: DexSnapshotSource): string {
  return `${source}_pair_snapshots`;
}

export function buildPendingLegSnapshotUpsertRow(args: {
  details: DexScreenerPairDetails;
  bucketTs: Date;
  source: DexSnapshotSource;
}): {
  ts: Date;
  source: DexSnapshotSource;
  pairAddress: string;
  baseMint: string;
  quoteMint: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume5m: number | null;
  volume1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
} | null {
  const { details, bucketTs, source } = args;
  if (!details.pairAddress || !details.baseMint || !details.quoteMint) return null;
  if (!(details.priceUsd != null && details.priceUsd > 0)) return null;
  return {
    ts: bucketTs,
    source,
    pairAddress: details.pairAddress,
    baseMint: details.baseMint,
    quoteMint: details.quoteMint,
    priceUsd: details.priceUsd,
    liquidityUsd: details.liquidityUsd,
    volume5m: details.volume5mUsd,
    volume1h: details.volume1hUsd,
    buys5m: details.buys5m,
    sells5m: details.sells5m,
    fdvUsd: details.marketCapUsd,
    marketCapUsd: details.marketCapUsd,
  };
}

async function upsertPendingLegSnapshotRow(
  table: string,
  row: NonNullable<ReturnType<typeof buildPendingLegSnapshotUpsertRow>>,
): Promise<void> {
  if (!VALID_SNAPSHOT_TABLES.has(table)) {
    throw new Error(`invalid snapshot table: ${table}`);
  }
  await pgSql.unsafe(
    `
    INSERT INTO ${table} (
      ts, source, pair_address, base_mint, quote_mint, price_usd, liquidity_usd,
      volume_5m, volume_1h, buys_5m, sells_5m, fdv_usd, market_cap_usd
    ) VALUES (
      $1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    ON CONFLICT (pair_address, ts) DO UPDATE
    SET
      source = EXCLUDED.source,
      base_mint = EXCLUDED.base_mint,
      quote_mint = EXCLUDED.quote_mint,
      price_usd = EXCLUDED.price_usd,
      liquidity_usd = EXCLUDED.liquidity_usd,
      volume_5m = EXCLUDED.volume_5m,
      volume_1h = EXCLUDED.volume_1h,
      buys_5m = EXCLUDED.buys_5m,
      sells_5m = EXCLUDED.sells_5m,
      fdv_usd = EXCLUDED.fdv_usd,
      market_cap_usd = EXCLUDED.market_cap_usd
    `,
    [
      row.ts.toISOString(),
      row.source,
      row.pairAddress,
      row.baseMint,
      row.quoteMint,
      row.priceUsd,
      row.liquidityUsd,
      row.volume5m,
      row.volume1h,
      row.buys5m,
      row.sells5m,
      row.fdvUsd,
      row.marketCapUsd,
    ],
  );
}

export type PendingLegPgRefreshResult =
  | { refreshed: true; source: DexSnapshotSource; bucketTsMs: number }
  | { refreshed: false; reason: string };

export async function maybeRefreshPendingLegPgForOpenTrade(args: {
  cfg: Pick<
    PaperTraderConfig,
    | 'livePendingLegPgRefreshEnabled'
    | 'livePendingLegPgRefreshCooldownMs'
    | 'livePendingLegPgRefreshBucketSec'
  >;
  ot: OpenTrade;
  mint: string;
  nowMs?: number;
  lastRefreshByMint?: Map<string, number>;
  journalAppend?: (event: Record<string, unknown>) => void;
}): Promise<PendingLegPgRefreshResult> {
  const { cfg, ot, mint } = args;
  const nowMs = args.nowMs ?? Date.now();
  const cooldownMap = args.lastRefreshByMint ?? lastRefreshByMint;

  if (!cfg.livePendingLegPgRefreshEnabled) {
    return { refreshed: false, reason: 'disabled' };
  }
  if (!openTradeNeedsEntrySplitFastPoll(ot)) {
    return { refreshed: false, reason: 'no_pending_leg' };
  }
  if (!pendingLegPgRefreshDue(mint, nowMs, cfg.livePendingLegPgRefreshCooldownMs, cooldownMap)) {
    return { refreshed: false, reason: 'cooldown' };
  }

  const preferredDex = isDexSnapshotSource(ot.source) ? ot.source : undefined;
  let details: DexScreenerPairDetails | null;
  try {
    details = await fetchDexScreenerPairDetails(mint, {
      preferredDex,
      bypassCache: true,
      nowMs,
    });
  } catch (err) {
    log.warn({ mint: mint.slice(0, 8), err: String(err) }, 'dexscreener fetch failed');
    return { refreshed: false, reason: 'fetch_error' };
  }

  const snapSource = resolvePendingLegSnapshotSource(details?.dexId, ot.source ?? preferredDex);
  if (!details || !snapSource) {
    return { refreshed: false, reason: 'no_pair' };
  }

  const bucketTs = pendingLegPgRefreshBucketTs(nowMs, cfg.livePendingLegPgRefreshBucketSec);
  const row = buildPendingLegSnapshotUpsertRow({ details, bucketTs, source: snapSource });
  if (!row) {
    return { refreshed: false, reason: 'invalid_row' };
  }

  const table = snapshotTableForDexSource(snapSource);
  try {
    await upsertPendingLegSnapshotRow(table, row);
  } catch (err) {
    log.warn({ mint: mint.slice(0, 8), table, err: String(err) }, 'pg upsert failed');
    return { refreshed: false, reason: 'upsert_error' };
  }

  cooldownMap.set(mint, nowMs);
  const bucketTsMs = bucketTs.getTime();
  args.journalAppend?.({
    kind: 'pending_leg_pg_refresh',
    mint,
    source: snapSource,
    pairAddress: row.pairAddress,
    priceUsd: row.priceUsd,
    bucketTsMs,
    fetchedAtMs: details.fetchedAtMs,
  });
  log.debug(
    { mint: mint.slice(0, 8), source: snapSource, bucketTsMs, priceUsd: row.priceUsd },
    'pending leg pg refresh',
  );
  return { refreshed: true, source: snapSource, bucketTsMs };
}

/** Test-only — clears per-mint cooldown state. */
export function __resetPendingLegPgRefreshForTests(): void {
  lastRefreshByMint.clear();
}
