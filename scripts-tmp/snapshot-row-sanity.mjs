/**
 * Drop ghost price/mcap spikes before PG upsert (LAYOFF-like DexScreener/Gecko glitches).
 * Compares tick to the previous minute bar for the same pair.
 */

const MIN_PREV_MCAP = 500_000;
const MAX_PX_JUMP = 50;
const MAX_MCAP_JUMP = 50;

/**
 * @param {object} row
 * @param {object | null | undefined} prev
 * @returns {object}
 */
export function sanitizeSnapshotRow(row, prev) {
  if (!prev || !(prev.price_usd > 0)) return row;
  const px = row.price_usd;
  const prevPx = prev.price_usd;
  if (!(px > 0)) return row;

  const mcap = row.market_cap_usd ?? row.fdv_usd ?? null;
  const prevMcap = prev.market_cap_usd ?? prev.fdv_usd ?? null;
  const pxRatio = px / prevPx;
  const mcapRatio =
    mcap != null && prevMcap != null && prevMcap > 0 ? mcap / prevMcap : null;

  const mature = (prevMcap ?? 0) >= MIN_PREV_MCAP;
  const pxSpike = pxRatio >= MAX_PX_JUMP || pxRatio <= 1 / MAX_PX_JUMP;
  const mcapSpike =
    mcapRatio != null && (mcapRatio >= MAX_MCAP_JUMP || mcapRatio <= 1 / MAX_MCAP_JUMP);

  if (!mature || (!pxSpike && !mcapSpike)) return row;

  return {
    ...row,
    price_usd: prevPx,
    market_cap_usd: prev.market_cap_usd ?? prev.fdv_usd ?? row.market_cap_usd,
    fdv_usd: prev.fdv_usd ?? prev.market_cap_usd ?? row.fdv_usd,
  };
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} table
 * @param {string[]} pairAddresses
 * @returns {Promise<Map<string, object>>}
 */
export async function fetchPrevSnapshotByPair(pool, table, pairAddresses) {
  const uniq = [...new Set(pairAddresses.filter(Boolean))];
  const out = new Map();
  if (uniq.length === 0) return out;

  const res = await pool.query(
    `SELECT DISTINCT ON (pair_address)
       pair_address, price_usd, market_cap_usd, fdv_usd, ts
     FROM ${table}
     WHERE pair_address = ANY($1::text[])
     ORDER BY pair_address, ts DESC`,
    [uniq],
  );
  for (const row of res.rows) {
    out.set(row.pair_address, row);
  }
  return out;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} table
 * @param {object[]} rows
 * @returns {Promise<object[]>}
 */
export async function sanitizeSnapshotRows(pool, table, rows) {
  if (rows.length === 0) return rows;
  const prevMap = await fetchPrevSnapshotByPair(
    pool,
    table,
    rows.map((r) => r.pair_address),
  );
  return rows.map((r) => sanitizeSnapshotRow(r, prevMap.get(r.pair_address)));
}
