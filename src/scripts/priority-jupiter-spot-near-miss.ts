/**
 * Near-miss spike mints from PG minute bars — consecutive + rolling (point D).
 */
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import { tierRequiredMinAbsPct } from './market-spike-tier-thresholds.js';

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

type Bar = { tsMs: number; priceUsd: number; refMcap: number };

function isNearMissAbs(absPct: number, refMcap: number, isPump: boolean, signalKind: 'consecutive' | 'rolling', gapPct: number): boolean {
  const minAbs = tierRequiredMinAbsPct(refMcap, isPump, signalKind);
  if (minAbs == null) return false;
  if (absPct >= minAbs) return false;
  return absPct >= minAbs - gapPct;
}

export function nearMissFromConsecutiveBars(bars: Bar[], gapPct: number): boolean {
  if (bars.length < 2) return false;
  const now = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2]!;
  if (!(now.priceUsd > 0 && prev.priceUsd > 0)) return false;
  const pct = ((now.priceUsd - prev.priceUsd) / prev.priceUsd) * 100;
  return isNearMissAbs(Math.abs(pct), now.refMcap, pct >= 0, 'consecutive', gapPct);
}

export function nearMissFromRollingBars(bars: Bar[], gapPct: number, rollingMin: number, rollingMax: number): boolean {
  if (bars.length < 3) return false;
  const now = bars[bars.length - 1]!;
  const nowMs = now.tsMs;
  for (let w = rollingMin; w <= rollingMax; w++) {
    const cutoff = nowMs - w * 60_000;
    const inWin = bars.filter((b) => b.tsMs >= cutoff && b.tsMs <= nowMs);
    if (inWin.length < 2) continue;
    for (const isPump of [true, false]) {
      let anchor = inWin[0]!;
      for (const s of inWin) {
        if (s.tsMs >= nowMs) continue;
        if (isPump ? s.priceUsd > anchor.priceUsd : s.priceUsd < anchor.priceUsd) anchor = s;
      }
      if (anchor.tsMs >= nowMs) continue;
      const pct = ((now.priceUsd - anchor.priceUsd) / anchor.priceUsd) * 100;
      if (isNearMissAbs(Math.abs(pct), now.refMcap, isPump, 'rolling', gapPct)) return true;
    }
  }
  return false;
}

async function loadRecentBarsByMint(minMcap: number, maxMints: number): Promise<Map<string, Bar[]>> {
  const q = `
    WITH snap AS (
      SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd
      FROM (
        SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd FROM meteora_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
        UNION ALL SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd FROM raydium_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
        UNION ALL SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd FROM orca_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
        UNION ALL SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd FROM pumpswap_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
      ) u
      WHERE price_usd > 0
    ),
    top AS (
      SELECT base_mint, MAX(COALESCE(market_cap_usd, fdv_usd, 0)) AS ref_mcap
      FROM snap
      GROUP BY base_mint
      HAVING MAX(COALESCE(market_cap_usd, fdv_usd, 0)) >= ${minMcap}
      ORDER BY MAX(ts) DESC
      LIMIT ${maxMints}
    )
    SELECT s.base_mint, s.ts, s.price_usd, COALESCE(s.market_cap_usd, s.fdv_usd, t.ref_mcap, 0) AS ref_mcap
    FROM snap s
    JOIN top t ON t.base_mint = s.base_mint
    ORDER BY s.base_mint, s.ts ASC
  `;
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out = new Map<string, Bar[]>();
  for (const row of rows) {
    const mint = String(row.base_mint ?? '').trim();
    if (mint.length < 32) continue;
    const tsMs = new Date(String(row.ts)).getTime();
    const priceUsd = Number(row.price_usd);
    const refMcap = Number(row.ref_mcap ?? 0);
    if (!(priceUsd > 0 && refMcap > 0)) continue;
    const arr = out.get(mint) ?? [];
    arr.push({ tsMs, priceUsd, refMcap });
    out.set(mint, arr);
  }
  return out;
}

/**
 * Mints within gap of spike tier (consecutive and/or rolling windows).
 */
export async function loadPgNearMissSpikeMints(limit: number): Promise<string[]> {
  const gapPct = Math.max(0.5, Math.min(8, envNum('PRIORITY_JUPITER_SPOT_NEAR_MISS_GAP_PCT', 3)));
  const minMcap = Math.max(0, envNum('PRIORITY_JUPITER_SPOT_MIN_MCAP_USD', 2_000_000));
  const lim = Math.max(5, Math.min(80, limit));
  const rollingEnabled = envBool('PRIORITY_JUPITER_SPOT_NEAR_MISS_ROLLING', true);
  const rollingMin = Math.max(1, Math.floor(envNum('SPIKE_ALERT_ROLLING_MINUTES', 3)));
  const rollingMax = Math.max(rollingMin, Math.floor(envNum('SPIKE_ALERT_ROLLING_MAX_MINUTES', 10)));

  const barsByMint = await loadRecentBarsByMint(minMcap, lim * 4);
  const scored: Array<{ mint: string; refMcap: number }> = [];

  for (const [mint, bars] of barsByMint) {
    const refMcap = bars[bars.length - 1]?.refMcap ?? 0;
    const hitConsec = nearMissFromConsecutiveBars(bars, gapPct);
    const hitRoll = rollingEnabled && nearMissFromRollingBars(bars, gapPct, rollingMin, rollingMax);
    if (hitConsec || hitRoll) scored.push({ mint, refMcap });
  }

  scored.sort((a, b) => b.refMcap - a.refMcap);
  return scored.slice(0, lim).map((x) => x.mint);
}
