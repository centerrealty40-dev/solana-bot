import type { SnapshotCandidateRow } from '../types.js';

/** SQL tie-break для канонического пула mint: max liq, затем свежесть. */
export const CANONICAL_SNAPSHOT_ROW_ORDER_SQL =
  'liquidity_usd DESC, ts DESC, volume_5m DESC, market_cap_usd DESC';

/** Extended lookback when PG collectors lag — avoid picking fresh $5k orca over stale $285k pumpswap. */
export function canonicalPoolLookbackMinutes(fallback = 360): number {
  const n = Number(process.env.DISCOVERY_CANONICAL_POOL_LOOKBACK_MIN ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(30, Math.min(1440, Math.floor(n)));
}

function tsMs(ts: Date | string): number {
  const d = ts instanceof Date ? ts : new Date(ts);
  const n = d.getTime();
  return Number.isFinite(n) ? n : 0;
}

/** Выбор одной строки снимка на mint: канонический пул = max liquidity_usd среди кандидатов. */
export function pickCanonicalSnapshotRow(
  rows: SnapshotCandidateRow[],
): SnapshotCandidateRow | null {
  if (rows.length === 0) return null;
  let best = rows[0]!;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.liquidity_usd !== best.liquidity_usd) {
      if (row.liquidity_usd > best.liquidity_usd) best = row;
      continue;
    }
    const rowTs = tsMs(row.ts);
    const bestTs = tsMs(best.ts);
    if (rowTs !== bestTs) {
      if (rowTs > bestTs) best = row;
      continue;
    }
    if (row.volume_5m !== best.volume_5m) {
      if (row.volume_5m > best.volume_5m) best = row;
      continue;
    }
    const rowMcap = row.market_cap_usd ?? 0;
    const bestMcap = best.market_cap_usd ?? 0;
    if (rowMcap > bestMcap) best = row;
  }
  return best;
}

/**
 * Канонический пул = max liq; цена/vol — с самого свежего бара **этого** pair (не с мёртвого orca).
 */
export function pickCanonicalSnapshotRowWithFreshQuote(
  rows: SnapshotCandidateRow[],
): SnapshotCandidateRow | null {
  const pick = pickCanonicalSnapshotRow(rows);
  if (!pick?.pair_address) return pick;
  let fresh = pick;
  for (const row of rows) {
    if (row.pair_address !== pick.pair_address) continue;
    if (tsMs(row.ts) > tsMs(fresh.ts)) fresh = row;
  }
  if (fresh === pick) return pick;
  const oldPx = pick.price_usd;
  const newPx = fresh.price_usd;
  let mcap = pick.market_cap_usd;
  if (oldPx > 0 && newPx > 0 && mcap != null && mcap > 0 && newPx !== oldPx) {
    mcap = mcap * (newPx / oldPx);
  }
  return {
    ...pick,
    price_usd: newPx,
    volume_5m: fresh.volume_5m,
    volume_1h: fresh.volume_1h,
    buys_5m: fresh.buys_5m,
    sells_5m: fresh.sells_5m,
    ts: fresh.ts,
    market_cap_usd: mcap,
  };
}

export function dedupeSnapshotTaggedByMintCanonical<T extends { row: SnapshotCandidateRow }>(
  tagged: T[],
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of tagged) {
    const arr = groups.get(item.row.mint) ?? [];
    arr.push(item);
    groups.set(item.row.mint, arr);
  }
  const out: T[] = [];
  for (const group of groups.values()) {
    const rows = group.map((g) => g.row);
    const pick = pickCanonicalSnapshotRowWithFreshQuote(rows);
    if (!pick) continue;
    const winner = group.find((g) => g.row.pair_address === pick.pair_address && g.row.source === pick.source) ?? group[0]!;
    out.push({ ...winner, row: pick });
  }
  return out;
}
