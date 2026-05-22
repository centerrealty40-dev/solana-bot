/**
 * Circulating market cap from PG pair snapshots.
 *
 * Secondary pools (esp. Meteora) often carry FDV-style mcap (~1B supply) while the
 * canonical pool (Pumpswap) tracks ~900M circulating — picking latest row across all
 * DEX tables inflates mcap (~18M vs ~16M on MANIFEST).
 */

export type SnapshotMcapRow = {
  priceUsd: number;
  marketCapUsd: number;
};

export function impliedCirculatingSupplyTokens(
  marketCapUsd: number,
  priceUsd: number,
): number | null {
  if (!(marketCapUsd > 0 && priceUsd > 0) || !Number.isFinite(marketCapUsd) || !Number.isFinite(priceUsd)) {
    return null;
  }
  return marketCapUsd / priceUsd;
}

/** Prefer rows whose implied supply matches canonical pool (~900M), not FDV (~1B). */
export function scoreSnapshotMcapRow(
  row: SnapshotMcapRow,
  refSupplyTokens: number | null,
): number {
  const sup = impliedCirculatingSupplyTokens(row.marketCapUsd, row.priceUsd);
  if (sup == null) return -Infinity;
  const supM = sup / 1_000_000;
  let score = 100;
  if (refSupplyTokens != null && refSupplyTokens > 0) {
    score -= (Math.abs(sup - refSupplyTokens) / refSupplyTokens) * 80;
  }
  if (supM >= 980) score -= 40;
  if (supM >= 880 && supM <= 960) score += 10;
  return score;
}

export function pickBestSnapshotMcapRow(
  rows: SnapshotMcapRow[],
  refSupplyTokens: number | null = null,
): SnapshotMcapRow | null {
  let best: SnapshotMcapRow | null = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    const s = scoreSnapshotMcapRow(row, refSupplyTokens);
    if (s > bestScore) {
      bestScore = s;
      best = row;
    }
  }
  return best;
}

export function medianSupplyFromRows(rows: SnapshotMcapRow[]): number | null {
  const supplies = rows
    .map((r) => impliedCirculatingSupplyTokens(r.marketCapUsd, r.priceUsd))
    .filter((s): s is number => s != null && s > 0)
    .sort((a, b) => a - b);
  if (!supplies.length) return null;
  return supplies[Math.floor(supplies.length / 2)] ?? null;
}

/** Scale mcap when only price was refreshed (Jupiter) but stored mcap is stale. */
export function scaleMcapWithPrice(
  oldPriceUsd: number,
  newPriceUsd: number,
  oldMcapUsd: number,
): number | null {
  if (!(oldPriceUsd > 0 && newPriceUsd > 0 && oldMcapUsd > 0)) return null;
  return oldMcapUsd * (newPriceUsd / oldPriceUsd);
}
