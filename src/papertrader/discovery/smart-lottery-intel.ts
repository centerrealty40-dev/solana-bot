import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type SmartLotteryIntelResult = {
  ok: boolean;
  reasons: string[];
  /** True when we saw at least one buy swap for the mint in `swaps`. */
  swapCovered: boolean;
};

/**
 * Block mint if any **early buyer** (buys in the first `smlotEarlyBuyWindowSec` after first pool buy)
 * hits wallet-intel signals (BLOCK_TRADE, scam/bot tags, atlas cluster, scam-farm meta cluster).
 */
export async function evaluateSmartLotteryIntelGate(
  mint: string,
  cfg: PaperTraderConfig,
): Promise<SmartLotteryIntelResult> {
  if (!cfg.smlotIntelGateEnabled) {
    return { ok: true, reasons: [], swapCovered: true };
  }
  if (!MINT_RE.test(mint)) {
    return { ok: false, reasons: ['invalid_mint'], swapCovered: false };
  }

  const mq = sqlQuote(mint);
  const windowSec = Math.max(30, Math.min(7200, Math.floor(cfg.smlotEarlyBuyWindowSec)));
  const cap = Math.max(5, Math.min(300, Math.floor(cfg.smlotEarlyBuyWalletCap)));

  const probe = await db.execute(dsql.raw(`
    SELECT COUNT(*)::int AS n FROM swaps WHERE base_mint = ${mq} AND side = 'buy'
  `));
  const nBuys = Number((probe as unknown as { n: number }[])[0]?.n ?? 0);
  if (nBuys <= 0) {
    if (cfg.smlotRequireEarlySwapCoverage) {
      return { ok: false, reasons: ['no_swap_buys'], swapCovered: false };
    }
    return { ok: true, reasons: [], swapCovered: false };
  }

  const rows = (await db.execute(dsql.raw(`
    WITH fb AS (
      SELECT MIN(block_time) AS t0 FROM swaps WHERE base_mint = ${mq} AND side = 'buy'
    ),
    ew AS (
      SELECT DISTINCT wallet
      FROM swaps s CROSS JOIN fb
      WHERE s.base_mint = ${mq}
        AND s.side = 'buy'
        AND fb.t0 IS NOT NULL
        AND s.block_time <= fb.t0 + (${windowSec} * interval '1 second')
      LIMIT ${cap}
    )
    SELECT w.wallet AS wallet,
      EXISTS (
        SELECT 1 FROM wallet_intel_decisions d
        WHERE d.wallet_address = w.wallet AND d.decision = 'BLOCK_TRADE'
      ) AS intel_block,
      EXISTS (
        SELECT 1 FROM wallet_tags t
        WHERE t.wallet = w.wallet
          AND (t.tag IN ('bot', 'mev_bot') OR t.tag LIKE 'scam%')
      ) AS bad_tag,
      EXISTS (
        SELECT 1 FROM entity_wallets e
        WHERE e.wallet = w.wallet AND e.cluster_id IS NOT NULL
      ) AS clustered,
      EXISTS (
        SELECT 1 FROM scam_farm_meta_cluster_members m
        WHERE m.wallet = w.wallet
      ) AS scam_meta
    FROM ew w
  `))) as unknown as Array<{
    wallet: string;
    intel_block: boolean;
    bad_tag: boolean;
    clustered: boolean;
    scam_meta: boolean;
  }>;

  for (const row of rows) {
    const wshort = row.wallet?.slice(0, 8) ?? '?';
    if (cfg.smlotBlockIntelBlockTrade && row.intel_block) {
      return { ok: false, reasons: [`intel_BLOCK_TRADE:${wshort}`], swapCovered: true };
    }
    if (cfg.smlotBlockBadTags && row.bad_tag) {
      return { ok: false, reasons: [`wallet_tag_bad:${wshort}`], swapCovered: true };
    }
    if (cfg.smlotBlockClusteredWallets && row.clustered) {
      return { ok: false, reasons: [`atlas_cluster:${wshort}`], swapCovered: true };
    }
    if (cfg.smlotBlockScamFarmMeta && row.scam_meta) {
      return { ok: false, reasons: [`scam_farm_meta:${wshort}`], swapCovered: true };
    }
  }

  return { ok: true, reasons: [], swapCovered: true };
}
