import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PreEntryDynamics } from '../types.js';

function classifyTrend(curr: number, prev: number): 'rising' | 'flat' | 'falling' | 'unknown' {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev <= 0) return 'unknown';
  const r = curr / prev - 1;
  if (r >= 0.1) return 'rising';
  if (r <= -0.1) return 'falling';
  return 'flat';
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

const bsRatio = (buy: unknown, sell: unknown): number | null => {
  const b = num(buy);
  const s = num(sell);
  if (b + s <= 0) return null;
  if (s === 0) return b > 0 ? 99 : null;
  return +(b / s).toFixed(3);
};

const pctChange = (curr: number | null, prev: number | null): number | null => {
  if (curr === null || prev === null || prev <= 0) return null;
  return +((curr / prev - 1) * 100).toFixed(2);
};

export async function fetchPreEntryDynamics(
  mint: string,
  anchorTs: number,
): Promise<PreEntryDynamics | null> {
  try {
    const safeMint = mint.replace(/'/g, "''");
    const anchorIso = new Date(anchorTs).toISOString();
    const r = await db.execute(dsql.raw(`
      SELECT
        COUNT(DISTINCT wallet) FILTER (WHERE block_time <= '${anchorIso}'::timestamptz - interval '30 minutes' AND side='buy')::int AS holders_30m_ago,
        COUNT(DISTINCT wallet) FILTER (WHERE block_time <= '${anchorIso}'::timestamptz - interval '10 minutes' AND side='buy')::int AS holders_10m_ago,
        COUNT(DISTINCT wallet) FILTER (WHERE block_time <= '${anchorIso}'::timestamptz AND side='buy')::int AS holders_now,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '35 minutes' AND '${anchorIso}'::timestamptz - interval '30 minutes'), 0)::float AS vol5m_30m_ago,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '15 minutes' AND '${anchorIso}'::timestamptz - interval '10 minutes'), 0)::float AS vol5m_10m_ago,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '5 minutes' AND '${anchorIso}'::timestamptz), 0)::float AS vol5m_now,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '35 minutes' AND '${anchorIso}'::timestamptz - interval '30 minutes' AND side='buy'), 0)::float AS buy_30m,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '35 minutes' AND '${anchorIso}'::timestamptz - interval '30 minutes' AND side='sell'), 0)::float AS sell_30m,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '15 minutes' AND '${anchorIso}'::timestamptz - interval '10 minutes' AND side='buy'), 0)::float AS buy_10m,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '15 minutes' AND '${anchorIso}'::timestamptz - interval '10 minutes' AND side='sell'), 0)::float AS sell_10m,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '5 minutes' AND '${anchorIso}'::timestamptz AND side='buy'), 0)::float AS buy_now,
        COALESCE(SUM(amount_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '5 minutes' AND '${anchorIso}'::timestamptz AND side='sell'), 0)::float AS sell_now,
        AVG(price_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '32 minutes' AND '${anchorIso}'::timestamptz - interval '28 minutes' AND price_usd > 0)::float AS price_30m_ago,
        AVG(price_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '12 minutes' AND '${anchorIso}'::timestamptz - interval '8 minutes' AND price_usd > 0)::float AS price_10m_ago,
        AVG(price_usd) FILTER (WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '2 minutes' AND '${anchorIso}'::timestamptz AND price_usd > 0)::float AS price_now
      FROM swaps
      WHERE base_mint = '${safeMint}'
        AND block_time >= '${anchorIso}'::timestamptz - interval '40 minutes'
        AND block_time <= '${anchorIso}'::timestamptz
    `));
    const rows = r as unknown as Array<Record<string, unknown>>;
    const x = rows[0];
    if (!x) return null;

    const holders_now = num(x.holders_now);
    const holders_10 = num(x.holders_10m_ago);
    const holders_30 = num(x.holders_30m_ago);
    const vol_now = num(x.vol5m_now);
    const vol_10 = num(x.vol5m_10m_ago);
    const vol_30 = num(x.vol5m_30m_ago);
    const bs_now = bsRatio(x.buy_now, x.sell_now);
    const bs_10 = bsRatio(x.buy_10m, x.sell_10m);
    const bs_30 = bsRatio(x.buy_30m, x.sell_30m);
    const p_now = numOrNull(x.price_now);
    const p_10 = numOrNull(x.price_10m_ago);
    const p_30 = numOrNull(x.price_30m_ago);

    return {
      holders_30m_ago: holders_30,
      holders_10m_ago: holders_10,
      holders_now,
      holders_delta_30_to_now: holders_now - holders_30,
      holders_delta_10_to_now: holders_now - holders_10,
      vol5m_30m_ago_usd: +vol_30.toFixed(2),
      vol5m_10m_ago_usd: +vol_10.toFixed(2),
      vol5m_now_usd: +vol_now.toFixed(2),
      vol_growth_30m_pct: pctChange(vol_now, vol_30),
      vol_growth_10m_pct: pctChange(vol_now, vol_10),
      bs_5m_30m_ago: bs_30,
      bs_5m_10m_ago: bs_10,
      bs_5m_now: bs_now,
      price_30m_ago: p_30 !== null ? +p_30.toFixed(10) : null,
      price_10m_ago: p_10 !== null ? +p_10.toFixed(10) : null,
      price_now: p_now !== null ? +p_now.toFixed(10) : null,
      price_growth_30m_pct: pctChange(p_now, p_30),
      price_growth_10m_pct: pctChange(p_now, p_10),
      trend_holders: classifyTrend(holders_now, holders_30),
      trend_volume: classifyTrend(vol_now, vol_30),
      trend_price: p_now !== null && p_30 !== null ? classifyTrend(p_now, p_30) : 'unknown',
    };
  } catch (err) {
    console.warn(`fetchPreEntryDynamics failed for ${mint}: ${(err as Error).message}`);
    return null;
  }
}
