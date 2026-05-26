import { fetch } from 'undici';
import { sql as dsql } from 'drizzle-orm';
import { jupiterJsonHeaders, jupiterPriceV3Url } from '../core/jupiter-http.js';
import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from './config.js';
import { SOL_MINT } from './config.js';
import {
  medianSupplyFromRows,
  pickBestSnapshotMcapRow,
  type SnapshotMcapRow,
} from './pricing/mcap-snapshot.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T = unknown>(
  url: string,
  retries = 2,
  headers: Record<string, string> = { accept: 'application/json' },
): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 429) {
        await sleep(1500);
        continue;
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      await sleep(800);
    }
  }
  return null;
}

let solUsd = 100;
export function getSolUsd(): number {
  return solUsd;
}

type JupiterPriceV3 = Record<string, { usdPrice?: number; price?: number }> & {
  data?: Record<string, { price?: number; usdPrice?: number }>;
};

export async function refreshSolPrice(): Promise<void> {
  const j = await fetchJson<JupiterPriceV3>(jupiterPriceV3Url(SOL_MINT), 2, jupiterJsonHeaders());
  const px = Number(j?.[SOL_MINT]?.usdPrice ?? j?.data?.[SOL_MINT]?.price ?? 0);
  if (px > 20 && px < 5000) solUsd = px;
}

/** Best-effort token USD price (Jupiter API); used when DB snapshot price missing. */
export async function fetchJupiterTokenUsdPrice(mint: string): Promise<number | null> {
  const id = mint.trim();
  if (!id) return null;
  const j = await fetchJson<JupiterPriceV3>(jupiterPriceV3Url(id), 2, jupiterJsonHeaders());
  const row = j?.[id] ?? j?.data?.[id];
  const px = Number(row?.usdPrice ?? row?.price ?? 0);
  return px > 0 && Number.isFinite(px) ? px : null;
}

let btcRet1hPct: number | null = null;
let btcRet4hPct: number | null = null;
let btcLastUpdateTs = 0;

export function getBtcContext(): {
  ret1h_pct: number | null;
  ret4h_pct: number | null;
  updated_ts: number | null;
} {
  return {
    ret1h_pct: btcRet1hPct !== null ? +btcRet1hPct.toFixed(2) : null,
    ret4h_pct: btcRet4hPct !== null ? +btcRet4hPct.toFixed(2) : null,
    updated_ts: btcLastUpdateTs || null,
  };
}

export async function refreshBtcContext(_cfg: PaperTraderConfig): Promise<void> {
  void _cfg;
  const j = await fetchJson<unknown[][]>(
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=5',
  );
  if (!j || !Array.isArray(j) || j.length < 5) {
    btcRet1hPct = null;
    btcRet4hPct = null;
    return;
  }
  const closes = j.map((row) => Number(row[4])).filter((x) => Number.isFinite(x) && x > 0);
  if (closes.length < 5) {
    btcRet1hPct = null;
    btcRet4hPct = null;
    return;
  }
  const last = closes[closes.length - 1];
  const oneAgo = closes[closes.length - 2];
  const fourAgo = closes[closes.length - 5];
  btcRet1hPct = oneAgo > 0 ? (last / oneAgo - 1) * 100 : null;
  btcRet4hPct = fourAgo > 0 ? (last / fourAgo - 1) * 100 : null;
  btcLastUpdateTs = Date.now();
}

export async function fetchPumpfunMc(mint: string): Promise<{ mc: number; ath: number } | null> {
  const j = await fetchJson<{ usd_market_cap?: number; ath_market_cap?: number }>(
    `https://frontend-api-v3.pump.fun/coins/${mint}`,
  );
  if (!j) return null;
  return { mc: Number(j.usd_market_cap ?? 0), ath: Number(j.ath_market_cap ?? 0) };
}

export async function fetchLatestSnapshotPrice(
  mint: string,
  source?: 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap',
): Promise<number | null> {
  const tables: string[] = source
    ? [`${source}_pair_snapshots`]
    : [
        'raydium_pair_snapshots',
        'meteora_pair_snapshots',
        'orca_pair_snapshots',
        'moonshot_pair_snapshots',
        'pumpswap_pair_snapshots',
      ];
  const safeMint = mint.replace(/'/g, "''");
  for (const t of tables) {
    const r = await db.execute(dsql.raw(`
      SELECT price_usd
      FROM ${t}
      WHERE base_mint = '${safeMint}'
      ORDER BY ts DESC
      LIMIT 1
    `));
    const rows = r as unknown as Array<{ price_usd: number | string }>;
    const px = Number(rows[0]?.price_usd ?? 0);
    if (px > 0) return px;
  }
  return null;
}

// ---------------------------------------------------------
// Live USD market cap (W7.2): snapshot tables → pump.fun, RAM cache.
// ---------------------------------------------------------

const DEX_SNAPSHOT_SOURCES = [
  'raydium',
  'meteora',
  'orca',
  'moonshot',
  'pumpswap',
] as const;

export type DexSnapshotSource = (typeof DEX_SNAPSHOT_SOURCES)[number];

function dexSnapshotTables(source?: DexSnapshotSource): string[] {
  if (source) return [`${source}_pair_snapshots`];
  return DEX_SNAPSHOT_SOURCES.map((s) => `${s}_pair_snapshots`);
}

function parseSnapshotMcapRows(
  raw: Array<{ price_usd: number | string | null; market_cap_usd: number | string | null; fdv_usd: number | string | null }>,
): SnapshotMcapRow[] {
  const out: SnapshotMcapRow[] = [];
  for (const row of raw) {
    const priceUsd = Number(row.price_usd ?? 0);
    const marketCapUsd = Number(row.market_cap_usd ?? row.fdv_usd ?? 0);
    if (priceUsd > 0 && marketCapUsd > 0) out.push({ priceUsd, marketCapUsd });
  }
  return out;
}

async function fetchSnapshotMcapRowsFromTable(
  table: string,
  mint: string,
  beforeEpochSec?: number,
  limit = 12,
): Promise<SnapshotMcapRow[]> {
  const safeMint = mint.replace(/'/g, "''");
  const beforeSql =
    beforeEpochSec != null && Number.isFinite(beforeEpochSec) && beforeEpochSec > 0
      ? `AND extract(epoch from ts) <= ${Math.floor(beforeEpochSec)}`
      : '';
  const r = await db.execute(dsql.raw(`
    SELECT price_usd, market_cap_usd, fdv_usd
    FROM ${table}
    WHERE (base_mint = '${safeMint}' OR quote_mint = '${safeMint}')
      ${beforeSql}
      AND price_usd IS NOT NULL AND price_usd > 0
      AND (COALESCE(market_cap_usd, 0) > 0 OR COALESCE(fdv_usd, 0) > 0)
    ORDER BY ts DESC
    LIMIT ${Math.max(1, Math.min(limit, 24))}
  `));
  return parseSnapshotMcapRows(
    r as unknown as Array<{
      price_usd: number | string | null;
      market_cap_usd: number | string | null;
      fdv_usd: number | string | null;
    }>,
  );
}

export async function fetchLatestSnapshotMcap(
  mint: string,
  source?: DexSnapshotSource,
  beforeEpochSec?: number,
): Promise<number | null> {
  const tables = dexSnapshotTables(source);
  const primary = tables[0];
  const refSupply =
    primary != null
      ? medianSupplyFromRows(await fetchSnapshotMcapRowsFromTable(primary, mint, beforeEpochSec, 24))
      : null;

  for (const t of tables) {
    const rows = await fetchSnapshotMcapRowsFromTable(t, mint, beforeEpochSec, 12);
    const best = pickBestSnapshotMcapRow(rows, refSupply);
    if (best != null) return best.marketCapUsd;
  }
  return null;
}

const _liveMcCache = new Map<string, { mc: number; ts: number }>();

function liveMcTtlMs(): number {
  const v = Number(process.env.PAPER_LIVE_MCAP_TTL_MS || 30_000);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 30_000;
}

/**
 * Best-effort live USD market cap for timeline stamping.
 * Order: pair_snapshots → pump.fun → null. Cached per mint (default 30s).
 */
export async function getLiveMcUsd(
  mint: string,
  source?: DexSnapshotSource,
): Promise<number | null> {
  const cached = _liveMcCache.get(mint);
  if (cached && Date.now() - cached.ts < liveMcTtlMs()) return cached.mc > 0 ? cached.mc : null;
  let mc: number | null = null;
  try {
    mc = await fetchLatestSnapshotMcap(mint, source);
  } catch {
    /* best-effort */
  }
  /** Post-migration pools: PG circulating mcap beats pump.fun FDV (~1B supply). */
  if ((mc == null || !(mc > 0)) && !source) {
    try {
      const p = await fetchPumpfunMc(mint);
      if (p && p.mc > 0) mc = p.mc;
    } catch {
      /* best-effort */
    }
  }
  _liveMcCache.set(mint, { mc: mc && mc > 0 ? mc : 0, ts: Date.now() });
  return mc && mc > 0 ? mc : null;
}
