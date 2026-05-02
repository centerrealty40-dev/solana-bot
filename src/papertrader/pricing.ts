import { fetch } from 'undici';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from './config.js';
import { SOL_MINT } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T = unknown>(url: string, retries = 2): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
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
  data?: Record<string, { price?: number }>;
};

export async function refreshSolPrice(): Promise<void> {
  const j = await fetchJson<JupiterPriceV3>(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  const px = Number(j?.[SOL_MINT]?.usdPrice ?? j?.data?.[SOL_MINT]?.price ?? 0);
  if (px > 20 && px < 5000) solUsd = px;
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

export async function fetchLatestSnapshotMcap(
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
      SELECT market_cap_usd, fdv_usd
      FROM ${t}
      WHERE base_mint = '${safeMint}'
      ORDER BY ts DESC
      LIMIT 1
    `));
    const rows = r as unknown as Array<{ market_cap_usd: number | string | null; fdv_usd: number | string | null }>;
    const mc = Number(rows[0]?.market_cap_usd ?? 0);
    if (mc > 0) return mc;
    const fdv = Number(rows[0]?.fdv_usd ?? 0);
    if (fdv > 0) return fdv;
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
  source?: 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap',
): Promise<number | null> {
  const cached = _liveMcCache.get(mint);
  if (cached && Date.now() - cached.ts < liveMcTtlMs()) return cached.mc > 0 ? cached.mc : null;
  let mc: number | null = null;
  try {
    mc = await fetchLatestSnapshotMcap(mint, source);
  } catch {
    /* best-effort */
  }
  if (mc == null || !(mc > 0)) {
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
