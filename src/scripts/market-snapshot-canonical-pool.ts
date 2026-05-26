/**
 * Общая логика выбора канонического пула (max liq) для market alert watchers.
 */

export type CanonicalPoolLatestMeta = {
  base_mint: string;
  pair_address: string;
  liq_usd: number | null;
};

export type CanonicalPoolEntry<T extends CanonicalPoolLatestMeta> = {
  table: string;
  meta: T;
  liq: number;
};

/** Канонический пул mint — max liquidity_usd среди свежих пар всех DEX-таблиц. */
export function buildMintCanonicalPoolMap<T extends CanonicalPoolLatestMeta>(
  tableLatest: Array<{ table: string; rows: T[] }>,
): Map<string, CanonicalPoolEntry<T>> {
  const out = new Map<string, CanonicalPoolEntry<T>>();
  for (const { table, rows } of tableLatest) {
    for (const meta of rows) {
      const liq = meta.liq_usd ?? 0;
      if (!(liq > 0)) continue;
      const prev = out.get(meta.base_mint);
      if (!prev || liq > prev.liq) {
        out.set(meta.base_mint, { table, meta, liq });
      }
    }
  }
  return out;
}

/** Группирует canonical meta по таблице для batch-fetch баров. */
export function groupCanonicalRowsByTable<T extends CanonicalPoolLatestMeta>(
  mintCanonical: Map<string, CanonicalPoolEntry<T>>,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const entry of mintCanonical.values()) {
    const arr = out.get(entry.table) ?? [];
    arr.push(entry.meta);
    out.set(entry.table, arr);
  }
  return out;
}
