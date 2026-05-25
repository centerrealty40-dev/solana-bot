import type { SnapshotCandidateRow } from '../types.js';

/** SQL tie-break для канонического пула mint: max liq, затем свежесть. */
export const CANONICAL_SNAPSHOT_ROW_ORDER_SQL =
  'liquidity_usd DESC, ts DESC, volume_5m DESC, market_cap_usd DESC';

/** Volume-leader tier: активная пара = max volume_1h (торговля), не max liq. */
export const CANONICAL_VOLUME_ROW_ORDER_SQL =
  'volume_1h DESC, volume_5m DESC, ts DESC, liquidity_usd DESC';

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

/** Канонический пул для volume-tier: max volume_1h среди кандидатов. */
export function pickCanonicalByVolumeRow(
  rows: SnapshotCandidateRow[],
): SnapshotCandidateRow | null {
  if (rows.length === 0) return null;
  let best = rows[0]!;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.volume_1h !== best.volume_1h) {
      if (row.volume_1h > best.volume_1h) best = row;
      continue;
    }
    if (row.volume_5m !== best.volume_5m) {
      if (row.volume_5m > best.volume_5m) best = row;
      continue;
    }
    const rowTs = tsMs(row.ts);
    const bestTs = tsMs(best.ts);
    if (rowTs !== bestTs) {
      if (rowTs > bestTs) best = row;
      continue;
    }
    if (row.liquidity_usd > best.liquidity_usd) best = row;
  }
  return best;
}

export function dedupeSnapshotTaggedByMintCanonical<T extends { row: SnapshotCandidateRow }>(
  tagged: T[],
  opts?: { volumeLeaderMints?: ReadonlySet<string> },
): T[] {
  const volSet = opts?.volumeLeaderMints;
  const groups = new Map<string, T[]>();
  for (const item of tagged) {
    const arr = groups.get(item.row.mint) ?? [];
    arr.push(item);
    groups.set(item.row.mint, arr);
  }
  const out: T[] = [];
  for (const [mint, group] of groups) {
    const rows = group.map((g) => g.row);
    const pick =
      volSet?.has(mint) === true
        ? pickCanonicalByVolumeRow(rows)
        : pickCanonicalSnapshotRow(rows);
    if (!pick) continue;
    const winner = group.find((g) => g.row === pick) ?? group[0]!;
    out.push({ ...winner, row: pick });
  }
  return out;
}
