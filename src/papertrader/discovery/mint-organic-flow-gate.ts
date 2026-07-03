/**
 * L3 organic flow positive gate — unique buyers + cluster buyer ratio (Pervyy Vystrel PR2).
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PervyyVystrelConfig } from '../live-oscar-pervyy-vystrel-config.js';

export interface OrganicFlowBuyerRow {
  wallet: string;
  buyUsd: number;
  clusterId: string | null;
}

export interface OrganicFlowSnapshot {
  mint: string;
  windowHours: number;
  computedAtMs: number;
  uniqueBuyers1h: number;
  clusterBuyerRatio: number | null;
  unclusteredBuyers: number;
  unclusteredBuyUsd: number;
  totalBuyUsd: number;
  pass: boolean;
  shadowPass: boolean;
  reasons: string[];
}

export interface OrganicFlowThresholds {
  minUniqueBuyers1h: number;
  maxClusterBuyerRatio: number;
  minUnclusteredBuyers: number;
}

export function organicFlowThresholdsFromConfig(
  pv: Pick<
    PervyyVystrelConfig,
    'minUniqueBuyers1h' | 'maxClusterBuyerRatio' | 'minUnclusteredBuyers1h'
  >,
): OrganicFlowThresholds {
  return {
    minUniqueBuyers1h: pv.minUniqueBuyers1h,
    maxClusterBuyerRatio: pv.maxClusterBuyerRatio,
    minUnclusteredBuyers: pv.minUnclusteredBuyers1h,
  };
}

export function evaluateOrganicFlowGate(args: {
  mint: string;
  windowHours: number;
  buyers: OrganicFlowBuyerRow[];
  thresholds: OrganicFlowThresholds;
  computedAtMs?: number;
}): OrganicFlowSnapshot {
  const { mint, windowHours, buyers, thresholds, computedAtMs = Date.now() } = args;
  const reasons: string[] = [];

  const uniqueBuyers1h = buyers.length;
  let clusterBuyUsd = 0;
  let totalBuyUsd = 0;
  let unclusteredBuyers = 0;
  let unclusteredBuyUsd = 0;

  for (const b of buyers) {
    totalBuyUsd += b.buyUsd;
    if (b.clusterId) {
      clusterBuyUsd += b.buyUsd;
    } else {
      unclusteredBuyers += 1;
      unclusteredBuyUsd += b.buyUsd;
    }
  }

  const clusterBuyerRatio = totalBuyUsd > 0 ? clusterBuyUsd / totalBuyUsd : null;

  if (uniqueBuyers1h < thresholds.minUniqueBuyers1h) {
    reasons.push(`unique_buyers_1h<${thresholds.minUniqueBuyers1h}`);
  }
  if (clusterBuyerRatio != null && clusterBuyerRatio > thresholds.maxClusterBuyerRatio) {
    reasons.push(`cluster_buyer_ratio>${thresholds.maxClusterBuyerRatio}`);
  }
  if (unclusteredBuyers < thresholds.minUnclusteredBuyers) {
    reasons.push(`unclustered_buyers<${thresholds.minUnclusteredBuyers}`);
  }

  const pass =
    uniqueBuyers1h >= thresholds.minUniqueBuyers1h &&
    (clusterBuyerRatio == null || clusterBuyerRatio <= thresholds.maxClusterBuyerRatio) &&
    unclusteredBuyers >= thresholds.minUnclusteredBuyers;

  return {
    mint,
    windowHours,
    computedAtMs,
    uniqueBuyers1h,
    clusterBuyerRatio,
    unclusteredBuyers,
    unclusteredBuyUsd,
    totalBuyUsd,
    pass,
    shadowPass: pass,
    reasons,
  };
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchOrganicFlowBuyersFromPg(
  mint: string,
  windowHours: number,
): Promise<OrganicFlowBuyerRow[]> {
  const h = Math.max(0.25, Math.min(24, windowHours));
  const mintSql = sqlQuote(mint);
  const rows = (await db.execute(dsql.raw(`
    SELECT s.wallet AS wallet,
           SUM(s.amount_usd)::float8 AS buy_usd,
           ew.cluster_id AS cluster_id
    FROM swaps s
    LEFT JOIN entity_wallets ew ON ew.wallet = s.wallet
    WHERE s.base_mint = ${mintSql}
      AND s.side = 'buy'
      AND s.block_time >= now() - interval '${h} hours'
    GROUP BY s.wallet, ew.cluster_id
    ORDER BY buy_usd DESC
    LIMIT 200
  `))) as unknown as Array<{ wallet: string; buy_usd: number; cluster_id: string | null }>;

  return rows.map((r) => ({
    wallet: r.wallet,
    buyUsd: Number(r.buy_usd),
    clusterId: r.cluster_id,
  }));
}
