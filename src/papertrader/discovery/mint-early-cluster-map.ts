/**
 * Early buyer cluster map stub — Phase B/C surveillance shadow (Pervyy Vystrel PR2).
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
  retailPanicMax?: number;
}): ClusterDumpShadowEval {
  const {
    mint,
    clusterMap,
    dumpSells,
    clusterSellRatioMin = 0.55,
    retailPanicMax = 0.45,
  } = args;

  const reasons: string[] = [];
  const earlySet = new Set(clusterMap.clusterWalletIds);
  const clusterIdByWallet = new Map(
    clusterMap.earlyWallets.map((w) => [w.wallet, w.clusterId] as const),
  );

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

    const inEarlyCluster =
      earlySet.has(s.wallet) || (clusterIdByWallet.get(s.wallet) != null && earlySet.size > 0);
    if (inEarlyCluster || clusterIdByWallet.get(s.wallet)) {
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
  if (clusterSellers.size < 3) reasons.push('cluster_unique_sellers<3');
  if (retailPanicScore != null && retailPanicScore > retailPanicMax) {
    reasons.push(`retail_panic>${retailPanicMax}`);
  }

  const pass =
    clusterSellRatio != null &&
    clusterSellRatio >= clusterSellRatioMin &&
    clusterSellers.size >= 3 &&
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

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchWalletClusterMap(wallets: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (wallets.length === 0) return map;
  const uniq = [...new Set(wallets)].slice(0, 200);
  const inSql = uniq.map(sqlQuote).join(',');
  const rows = (await db.execute(dsql.raw(`
    SELECT wallet, cluster_id FROM entity_wallets WHERE wallet IN (${inSql})
  `))) as unknown as Array<{ wallet: string; cluster_id: string | null }>;
  for (const r of rows) map.set(r.wallet, r.cluster_id);
  for (const w of uniq) if (!map.has(w)) map.set(w, null);
  return map;
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
