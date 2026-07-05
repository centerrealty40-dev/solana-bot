/**
 * Early buyer cluster map — Phase B/C surveillance shadow (Pervyy Vystrel PR2).
 * Cluster resolution: entity_wallets → wallets.funding_source → money_flows 1-hop (spec §6.1).
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';

export interface EarlyBuySwapRow {
  wallet: string;
  side: 'buy' | 'sell' | string;
  amountUsd: number;
  blockTimeMs: number;
}

export interface EarlyClusterWallet {
  wallet: string;
  clusterId: string | null;
  buyUsd: number;
  isEarly: boolean;
}

export interface EarlyClusterMapSnapshot {
  mint: string;
  earlyBuyWindowSec: number;
  computedAtMs: number;
  firstBuyMs: number | null;
  earlyWallets: EarlyClusterWallet[];
  clusterWalletIds: string[];
  clusterIds: string[];
}

export interface ClusterDumpShadowEval {
  mint: string;
  clusterSellRatio: number | null;
  clusterUniqueSellers: number;
  top3ClusterSellShare: number | null;
  retailPanicScore: number | null;
  pass: boolean;
  shadowPass: boolean;
  reasons: string[];
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeClusterId(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

/** Union-find for money_flows 1-hop expansion among seed wallets. */
class WalletUnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = this.parent.get(x)!;
    while (root !== this.parent.get(root)) {
      root = this.parent.get(root)!;
    }
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function buildEarlyClusterMapFromSwaps(args: {
  mint: string;
  swaps: EarlyBuySwapRow[];
  earlyBuyWindowSec: number;
  walletClusters?: Map<string, string | null>;
  maxEarlyWallets?: number;
  computedAtMs?: number;
}): EarlyClusterMapSnapshot {
  const {
    mint,
    swaps,
    earlyBuyWindowSec,
    walletClusters = new Map(),
    maxEarlyWallets = 60,
    computedAtMs = Date.now(),
  } = args;

  const buys = swaps
    .filter((s) => String(s.side).toLowerCase() === 'buy')
    .sort((a, b) => a.blockTimeMs - b.blockTimeMs);

  const firstBuyMs = buys.length > 0 ? buys[0]!.blockTimeMs : null;
  const windowEndMs =
    firstBuyMs != null ? firstBuyMs + earlyBuyWindowSec * 1000 : Number.POSITIVE_INFINITY;

  const earlyBuyUsd = new Map<string, number>();
  for (const s of buys) {
    if (firstBuyMs != null && s.blockTimeMs > windowEndMs) continue;
    earlyBuyUsd.set(s.wallet, (earlyBuyUsd.get(s.wallet) ?? 0) + Math.max(0, s.amountUsd));
  }

  const ranked = [...earlyBuyUsd.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEarlyWallets);

  const earlyWallets: EarlyClusterWallet[] = ranked.map(([wallet, buyUsd]) => ({
    wallet,
    clusterId: walletClusters.get(wallet) ?? null,
    buyUsd,
    isEarly: true,
  }));

  const clusterWalletIds = earlyWallets.filter((w) => w.clusterId).map((w) => w.wallet);
  const clusterIds = [...new Set(earlyWallets.map((w) => w.clusterId).filter(Boolean))] as string[];

  return {
    mint,
    earlyBuyWindowSec,
    computedAtMs,
    firstBuyMs,
    earlyWallets,
    clusterWalletIds,
    clusterIds,
  };
}

/** Shadow Phase C cluster dump attribution from dump-window sells. */
export function evaluateClusterDumpShadow(args: {
  mint: string;
  clusterMap: EarlyClusterMapSnapshot;
  dumpSells: EarlyBuySwapRow[];
  clusterSellRatioMin?: number;
  clusterMinUniqueSellers?: number;
  retailPanicMax?: number;
  walletClusters?: Map<string, string | null>;
}): ClusterDumpShadowEval {
  const {
    mint,
    clusterMap,
    dumpSells,
    clusterSellRatioMin = 0.55,
    clusterMinUniqueSellers = 3,
    retailPanicMax = 0.45,
    walletClusters,
  } = args;

  const reasons: string[] = [];
  const earlyWalletsSet = new Set(clusterMap.earlyWallets.map((w) => w.wallet));
  const clusterIdByWallet = new Map(
    clusterMap.earlyWallets.map((w) => [w.wallet, w.clusterId] as const),
  );
  const earlyClusterIds = new Set(
    clusterMap.earlyWallets.map((w) => w.clusterId).filter(Boolean) as string[],
  );

  const sellerClusterId = (wallet: string): string | null =>
    walletClusters?.get(wallet) ?? clusterIdByWallet.get(wallet) ?? null;

  const isClusterSeller = (wallet: string): boolean => {
    if (earlyWalletsSet.has(wallet)) return true;
    const cid = sellerClusterId(wallet);
    return cid != null && earlyClusterIds.has(cid);
  };

  let totalSellUsd = 0;
  let clusterSellUsd = 0;
  let retailSellUsd = 0;
  const clusterSellers = new Set<string>();
  const sellByWallet = new Map<string, number>();

  for (const s of dumpSells) {
    if (String(s.side).toLowerCase() !== 'sell') continue;
    const usd = Math.max(0, s.amountUsd);
    if (usd <= 0) continue;
    totalSellUsd += usd;
    sellByWallet.set(s.wallet, (sellByWallet.get(s.wallet) ?? 0) + usd);

    if (isClusterSeller(s.wallet)) {
      clusterSellUsd += usd;
      clusterSellers.add(s.wallet);
    } else {
      retailSellUsd += usd;
    }
  }

  const clusterSellRatio = totalSellUsd > 0 ? clusterSellUsd / totalSellUsd : null;
  const retailPanicScore = totalSellUsd > 0 ? retailSellUsd / totalSellUsd : null;

  const top3ClusterSellShare = (() => {
    const clusterSells = [...sellByWallet.entries()]
      .filter(([w]) => clusterSellers.has(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .reduce((sum, [, usd]) => sum + usd, 0);
    return totalSellUsd > 0 ? clusterSells / totalSellUsd : null;
  })();

  if (clusterSellRatio == null || clusterSellRatio < clusterSellRatioMin) {
    reasons.push(`cluster_sell_ratio<${clusterSellRatioMin}`);
  }
  if (clusterSellers.size < clusterMinUniqueSellers) {
    reasons.push(`cluster_unique_sellers<${clusterMinUniqueSellers}`);
  }
  if (retailPanicScore != null && retailPanicScore > retailPanicMax) {
    reasons.push(`retail_panic>${retailPanicMax}`);
  }

  const pass =
    clusterSellRatio != null &&
    clusterSellRatio >= clusterSellRatioMin &&
    clusterSellers.size >= clusterMinUniqueSellers &&
    (retailPanicScore == null || retailPanicScore <= retailPanicMax);

  return {
    mint,
    clusterSellRatio,
    clusterUniqueSellers: clusterSellers.size,
    top3ClusterSellShare,
    retailPanicScore,
    pass,
    shadowPass: pass,
    reasons,
  };
}

/** Atlas cluster_id + wallets.funding_source synthetic clusters (spec §6.1 step 2). */
export async function fetchWalletClusterMap(wallets: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (wallets.length === 0) return map;
  const uniq = [...new Set(wallets)].slice(0, 200);
  const inSql = uniq.map(sqlQuote).join(',');
  const rows = (await db.execute(dsql.raw(`
    SELECT v.wallet,
           COALESCE(
             ew.cluster_id::text,
             NULLIF(w.cluster_id, ''),
             CASE
               WHEN w.funding_source IS NOT NULL AND w.funding_source <> ''
               THEN 'fs:' || w.funding_source
             END
           ) AS cluster_id
    FROM (SELECT unnest(ARRAY[${inSql}]::varchar[]) AS wallet) v
    LEFT JOIN entity_wallets ew ON ew.wallet = v.wallet
    LEFT JOIN wallets w ON w.address = v.wallet
  `))) as unknown as Array<{ wallet: string; cluster_id: string | null }>;

  for (const r of rows) map.set(r.wallet, normalizeClusterId(r.cluster_id));
  for (const w of uniq) if (!map.has(w)) map.set(w, null);
  return map;
}

/** 1-hop money_flows expansion among seed wallets (spec §6.1 step 3). */
export async function expandWalletClustersViaMoneyFlows(
  seedWallets: string[],
  base: Map<string, string | null>,
): Promise<Map<string, string | null>> {
  const seeds = [...new Set(seedWallets)].slice(0, 200);
  if (seeds.length < 2) return base;

  const seedSet = new Set(seeds);
  const inSql = seeds.map(sqlQuote).join(',');
  const rows = (await db.execute(dsql.raw(`
    SELECT source_wallet, target_wallet
    FROM money_flows
    WHERE source_wallet IN (${inSql}) OR target_wallet IN (${inSql})
    LIMIT 2000
  `))) as unknown as Array<{ source_wallet: string; target_wallet: string }>;

  const uf = new WalletUnionFind();
  for (const w of seeds) uf.find(w);

  for (const r of rows) {
    const touchesSeed = seedSet.has(r.source_wallet) || seedSet.has(r.target_wallet);
    if (!touchesSeed) continue;
    uf.find(r.source_wallet);
    uf.find(r.target_wallet);
    uf.union(r.source_wallet, r.target_wallet);
  }

  const out = new Map(base);
  const componentCluster = new Map<string, string>();

  for (const w of seeds) {
    if (out.get(w)) continue;
    const root = uf.find(w);
    let cid = componentCluster.get(root);
    if (!cid) {
      cid = `mf:${root.slice(0, 12)}`;
      componentCluster.set(root, cid);
    }
    out.set(w, cid);
  }

  return out;
}

/** Resolve cluster ids for all swap wallets on a mint (Atlas + funding + money_flows). */
export async function buildWalletClusterMapForSwaps(
  swapWallets: string[],
): Promise<Map<string, string | null>> {
  const base = await fetchWalletClusterMap(swapWallets);
  return expandWalletClustersViaMoneyFlows(swapWallets, base);
}

export async function fetchMintSwapsForClusterMap(
  mint: string,
  lookbackHours = 48,
): Promise<EarlyBuySwapRow[]> {
  const mintSql = sqlQuote(mint);
  const h = Math.max(1, Math.min(72, lookbackHours));
  const rows = (await db.execute(dsql.raw(`
    SELECT wallet, side, amount_usd, EXTRACT(EPOCH FROM block_time) * 1000 AS block_time_ms
    FROM swaps
    WHERE base_mint = ${mintSql}
      AND block_time >= now() - interval '${h} hours'
    ORDER BY block_time ASC
    LIMIT 5000
  `))) as unknown as Array<{
    wallet: string;
    side: string;
    amount_usd: number;
    block_time_ms: number;
  }>;
  return rows.map((r) => ({
    wallet: r.wallet,
    side: r.side,
    amountUsd: Number(r.amount_usd),
    blockTimeMs: Number(r.block_time_ms),
  }));
}
