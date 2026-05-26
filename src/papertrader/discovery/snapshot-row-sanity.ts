import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import {
  pickCanonicalByVolumeRow,
  pickCanonicalSnapshotRow,
} from './snapshot-canonical-pick.js';

/** Knobs for discovery snapshot sanity (mirrors spike alert liq/mcap + dead-pool share). */
export type DiscoverySnapshotSanityCfg = {
  enabled: boolean;
  refMcapMinUsd: number;
  minLiqToRefMcapRatio: number;
  minLiqShareOfMintMax: number;
  zeroLiqMaxMcapUsd: number;
};

export function discoverySnapshotSanityCfg(cfg: PaperTraderConfig): DiscoverySnapshotSanityCfg {
  return {
    enabled: cfg.discoverySnapshotSanityEnabled,
    refMcapMinUsd: cfg.discoverySnapshotSanityRefMcapMinUsd,
    minLiqToRefMcapRatio: cfg.discoverySnapshotSanityMinLiqToMcapRatio,
    minLiqShareOfMintMax: cfg.discoverySnapshotSanityMinLiqShareOfMintMax,
    zeroLiqMaxMcapUsd: cfg.discoverySnapshotSanityZeroLiqMaxMcapUsd,
  };
}

/**
 * Отсекает битые PG-снимки: liq≈0 при крупной mcap, liq несоразмерна mcap, dead pool (< share max liq mint).
 */
export function isDiscoverySnapshotRowSane(
  row: Pick<SnapshotCandidateRow, 'liquidity_usd' | 'market_cap_usd' | 'price_usd'>,
  sanity: DiscoverySnapshotSanityCfg,
  mintMaxLiqUsd?: number,
): boolean {
  if (!sanity.enabled) return true;

  const liq = Number(row.liquidity_usd ?? 0);
  const mcap = Number(row.market_cap_usd ?? 0);
  const price = Number(row.price_usd ?? 0);
  if (!(price > 0)) return false;

  if (liq <= 0 && mcap > sanity.zeroLiqMaxMcapUsd) return false;

  if (mcap >= sanity.refMcapMinUsd && sanity.minLiqToRefMcapRatio > 0) {
    if (!(liq > 0)) return false;
    if (liq + 1e-9 < mcap * sanity.minLiqToRefMcapRatio) return false;
  }

  if (
    mintMaxLiqUsd != null &&
    mintMaxLiqUsd > 0 &&
    sanity.minLiqShareOfMintMax > 0 &&
    liq + 1e-9 < mintMaxLiqUsd * sanity.minLiqShareOfMintMax
  ) {
    return false;
  }

  return true;
}

export function filterSaneDiscoverySnapshotRows(
  rows: SnapshotCandidateRow[],
  sanity: DiscoverySnapshotSanityCfg,
): SnapshotCandidateRow[] {
  if (!sanity.enabled || rows.length === 0) return rows;

  const maxLiqByMint = new Map<string, number>();
  for (const row of rows) {
    const liq = Number(row.liquidity_usd ?? 0);
    const prev = maxLiqByMint.get(row.mint) ?? 0;
    if (liq > prev) maxLiqByMint.set(row.mint, liq);
  }

  return rows.filter((row) =>
    isDiscoverySnapshotRowSane(row, sanity, maxLiqByMint.get(row.mint)),
  );
}

/** SQL AND-clauses for eligible CTE (expects `mint_max_liq` column on row). Empty when disabled. */
export function buildDiscoverySnapshotSanitySqlClause(cfg: PaperTraderConfig): string {
  const s = discoverySnapshotSanityCfg(cfg);
  if (!s.enabled) return '';

  const shareClause =
    s.minLiqShareOfMintMax > 0
      ? `AND COALESCE(liquidity_usd, 0) >= mint_max_liq * ${s.minLiqShareOfMintMax}`
      : '';

  return `
    AND NOT (COALESCE(liquidity_usd, 0) <= 0 AND COALESCE(market_cap_usd, 0) > ${s.zeroLiqMaxMcapUsd})
    AND (
      COALESCE(market_cap_usd, 0) < ${s.refMcapMinUsd}
      OR (
        COALESCE(liquidity_usd, 0) > 0
        AND liquidity_usd >= COALESCE(market_cap_usd, 0) * ${s.minLiqToRefMcapRatio}
      )
    )
    ${shareClause}`;
}

export function pickCanonicalSnapshotRowFromPool(
  rows: SnapshotCandidateRow[],
  sanity: DiscoverySnapshotSanityCfg,
  opts?: { canonicalByVolume?: boolean },
): SnapshotCandidateRow | null {
  const sane = filterSaneDiscoverySnapshotRows(rows, sanity);
  if (sane.length === 0) return null;
  return opts?.canonicalByVolume === true
    ? pickCanonicalByVolumeRow(sane)
    : pickCanonicalSnapshotRow(sane);
}

export function pickCanonicalSnapshotRowsByMint(
  rows: SnapshotCandidateRow[],
  sanity: DiscoverySnapshotSanityCfg,
  opts?: { canonicalByVolume?: boolean },
): Map<string, SnapshotCandidateRow> {
  const byMint = new Map<string, SnapshotCandidateRow[]>();
  for (const row of rows) {
    const arr = byMint.get(row.mint) ?? [];
    arr.push(row);
    byMint.set(row.mint, arr);
  }
  const out = new Map<string, SnapshotCandidateRow>();
  for (const [mint, group] of byMint) {
    const pick = pickCanonicalSnapshotRowFromPool(group, sanity, opts);
    if (pick) out.set(mint, pick);
  }
  return out;
}
