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

export async function refreshBtcContext(cfg: PaperTraderConfig): Promise<void> {
  if (!cfg.btcMints.length) return;
  const mintsSql = cfg.btcMints.map((m) => `'${m.replace(/'/g, "''")}'`).join(',');
  const r = await db.execute(dsql.raw(`
    SELECT block_time AS ts, price_usd
    FROM swaps
    WHERE base_mint IN (${mintsSql})
      AND price_usd > 0
      AND block_time >= now() - interval '6 hours'
    ORDER BY block_time ASC
  `));
  const rows = r as unknown as Array<{ ts: unknown; price_usd: number | string }>;
  if (rows.length < 2) {
    btcRet1hPct = null;
    btcRet4hPct = null;
    return;
  }
  const series = rows.map((row) => ({
    t: new Date(String(row.ts)).getTime(),
    p: Number(row.price_usd),
  }));
  const latest = series[series.length - 1];
  const findClosest = (targetTs: number) => {
    let best = series[0];
    let bestDiff = Math.abs(series[0].t - targetTs);
    for (const s of series) {
      const d = Math.abs(s.t - targetTs);
      if (d < bestDiff) {
        best = s;
        bestDiff = d;
      }
    }
    return best;
  };
  const a1 = findClosest(latest.t - 60 * 60_000);
  const a4 = findClosest(latest.t - 4 * 60 * 60_000);
  btcRet1hPct = a1 && a1.p > 0 ? (latest.p / a1.p - 1) * 100 : null;
  btcRet4hPct = a4 && a4.p > 0 ? (latest.p / a4.p - 1) * 100 : null;
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
  source?: 'raydium' | 'meteora' | 'orca' | 'moonshot',
): Promise<number | null> {
  const tables: string[] = source
    ? [`${source}_pair_snapshots`]
    : ['raydium_pair_snapshots', 'meteora_pair_snapshots', 'orca_pair_snapshots', 'moonshot_pair_snapshots'];
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
