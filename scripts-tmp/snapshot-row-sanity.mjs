/**
 * Drop ghost price/mcap spikes before PG upsert (LAYOFF-like DexScreener/Gecko glitches).
 * Uses in-process prev-bar cache (no extra PG read per tick).
 */

const MIN_PREV_MCAP = 500_000;
const MAX_PX_JUMP = 50;
const MAX_MCAP_JUMP = 50;

/** @type {Map<string, Map<string, object>>} */
const prevByTable = new Map();

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

/** @param {object} row */
function rememberRow(table, row) {
  if (!row?.pair_address) return;
  let cache = prevByTable.get(table);
  if (!cache) {
    cache = new Map();
    prevByTable.set(table, cache);
  }
  cache.set(row.pair_address, {
    price_usd: row.price_usd,
    market_cap_usd: row.market_cap_usd,
    fdv_usd: row.fdv_usd,
  });
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} table
 * @param {object[]} rows
 * @returns {Promise<object[]>}
 */
export async function sanitizeSnapshotRows(pool, table, rows) {
  void pool;
  if (rows.length === 0) return rows;
  let cache = prevByTable.get(table);
  if (!cache) {
    cache = new Map();
    prevByTable.set(table, cache);
  }
  const out = rows.map((r) => sanitizeSnapshotRow(r, cache.get(r.pair_address)));
  for (const r of out) rememberRow(table, r);
  return out;
}
