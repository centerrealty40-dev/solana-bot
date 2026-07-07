import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from './config.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type LeraOverlayVerdict = 'BUY' | 'WAIT' | 'SKIP';

export type LeraOverlayHitKind =
  | 'BLOCK_TRADE'
  | 'bad_tag'
  | 'atlas_cluster'
  | 'scam_farm_meta'
  | 'coord_sell'
  | 'whale_dump'
  | 'multi_large_sell';

export type LeraOverlayHit = {
  wallet: string;
  kind: LeraOverlayHitKind;
  amountUsd?: number;
  ageSec?: number;
};

export type LeraOverlaySellRow = {
  wallet: string;
  amountUsd: number;
  ageSec: number;
  intelBlock: boolean;
  badTag: boolean;
  clustered: boolean;
  scamMeta: boolean;
};

export type LeraEntryOnchainOverlayResult = {
  mode: 'shadow';
  verdict: LeraOverlayVerdict;
  /** True when shadow verdict would block entry (SKIP/WAIT) — for later gate flip. */
  wouldBlock: boolean;
  /** Always false in shadow mode (never blocks live entry). */
  blocked: false;
  reasons: string[];
  hits: LeraOverlayHit[];
  recentSellCount: number;
  largeSellCount: number;
  totalSellUsd: number;
  lookbackSec: number;
  queryMs?: number;
  error?: string;
};

function walletShort(w: string): string {
  return w.length > 8 ? w.slice(0, 8) : w;
}

function sellerBad(row: LeraOverlaySellRow): boolean {
  return row.intelBlock || row.badTag || row.clustered || row.scamMeta;
}

/**
 * Pure verdict from enriched recent sells — unit-tested without PG.
 * Priority: SKIP (toxic sellers / coordination) → WAIT (active dump) → BUY.
 */
export function resolveLeraEntryOnchainOverlayVerdict(
  cfg: PaperTraderConfig,
  sells: LeraOverlaySellRow[],
): Pick<
  LeraEntryOnchainOverlayResult,
  'verdict' | 'wouldBlock' | 'blocked' | 'reasons' | 'hits' | 'recentSellCount' | 'largeSellCount' | 'totalSellUsd'
> {
  const minSellUsd = cfg.leraEntryOnchainOverlayMinSellUsd;
  const largeUsd = cfg.leraEntryOnchainOverlayLargeSellUsd;
  const whaleMaxAge = cfg.leraEntryOnchainOverlayWhaleDumpMaxAgeSec;
  const coordMin = cfg.leraEntryOnchainOverlayCoordSellWalletMin;

  const recent = sells.filter((s) => s.amountUsd >= minSellUsd);
  const large = recent.filter((s) => s.amountUsd >= largeUsd);
  const totalSellUsd = recent.reduce((sum, s) => sum + s.amountUsd, 0);

  const reasons: string[] = [];
  const hits: LeraOverlayHit[] = [];

  for (const row of large) {
    const w = walletShort(row.wallet);
    if (cfg.leraEntryOnchainOverlayBlockIntelBlockTrade && row.intelBlock) {
      reasons.push(`intel_BLOCK_TRADE:${w}`);
      hits.push({ wallet: row.wallet, kind: 'BLOCK_TRADE', amountUsd: row.amountUsd, ageSec: row.ageSec });
      return skipResult(recent, large, totalSellUsd, reasons, hits);
    }
    if (cfg.leraEntryOnchainOverlayBlockBadTags && row.badTag) {
      reasons.push(`wallet_tag_bad:${w}`);
      hits.push({ wallet: row.wallet, kind: 'bad_tag', amountUsd: row.amountUsd, ageSec: row.ageSec });
      return skipResult(recent, large, totalSellUsd, reasons, hits);
    }
    if (cfg.leraEntryOnchainOverlayBlockClusteredWallets && row.clustered) {
      reasons.push(`atlas_cluster_seller:${w}`);
      hits.push({ wallet: row.wallet, kind: 'atlas_cluster', amountUsd: row.amountUsd, ageSec: row.ageSec });
      return skipResult(recent, large, totalSellUsd, reasons, hits);
    }
    if (cfg.leraEntryOnchainOverlayBlockScamFarmMeta && row.scamMeta) {
      reasons.push(`scam_farm_meta_seller:${w}`);
      hits.push({ wallet: row.wallet, kind: 'scam_farm_meta', amountUsd: row.amountUsd, ageSec: row.ageSec });
      return skipResult(recent, large, totalSellUsd, reasons, hits);
    }
  }

  const badSellers = new Set(
    recent.filter((s) => sellerBad(s)).map((s) => s.wallet),
  );
  if (badSellers.size >= coordMin) {
    reasons.push(`coordinated_bad_sellers:${badSellers.size}`);
    for (const w of [...badSellers].slice(0, 5)) {
      const row = recent.find((s) => s.wallet === w);
      hits.push({
        wallet: w,
        kind: 'coord_sell',
        amountUsd: row?.amountUsd,
        ageSec: row?.ageSec,
      });
    }
    return skipResult(recent, large, totalSellUsd, reasons, hits);
  }

  const freshLarge = large.filter((s) => s.ageSec <= whaleMaxAge);
  if (freshLarge.length >= 2) {
    reasons.push(`multiple_large_sells:${freshLarge.length}`);
    for (const row of freshLarge.slice(0, 3)) {
      hits.push({
        wallet: row.wallet,
        kind: 'multi_large_sell',
        amountUsd: row.amountUsd,
        ageSec: row.ageSec,
      });
    }
    return waitResult(recent, large, totalSellUsd, reasons, hits);
  }

  const whaleDump = large.find((s) => s.ageSec <= whaleMaxAge);
  if (whaleDump) {
    reasons.push(`whale_dump_active:${Math.round(whaleDump.amountUsd)}usd`);
    hits.push({
      wallet: whaleDump.wallet,
      kind: 'whale_dump',
      amountUsd: whaleDump.amountUsd,
      ageSec: whaleDump.ageSec,
    });
    return waitResult(recent, large, totalSellUsd, reasons, hits);
  }

  return {
    verdict: 'BUY',
    wouldBlock: false,
    blocked: false,
    reasons: ['shadow_allow'],
    hits: [],
    recentSellCount: recent.length,
    largeSellCount: large.length,
    totalSellUsd,
  };
}

function skipResult(
  recent: LeraOverlaySellRow[],
  large: LeraOverlaySellRow[],
  totalSellUsd: number,
  reasons: string[],
  hits: LeraOverlayHit[],
): Pick<
  LeraEntryOnchainOverlayResult,
  'verdict' | 'wouldBlock' | 'blocked' | 'reasons' | 'hits' | 'recentSellCount' | 'largeSellCount' | 'totalSellUsd'
> {
  return {
    verdict: 'SKIP',
    wouldBlock: true,
    blocked: false,
    reasons,
    hits,
    recentSellCount: recent.length,
    largeSellCount: large.length,
    totalSellUsd,
  };
}

function waitResult(
  recent: LeraOverlaySellRow[],
  large: LeraOverlaySellRow[],
  totalSellUsd: number,
  reasons: string[],
  hits: LeraOverlayHit[],
): Pick<
  LeraEntryOnchainOverlayResult,
  'verdict' | 'wouldBlock' | 'blocked' | 'reasons' | 'hits' | 'recentSellCount' | 'largeSellCount' | 'totalSellUsd'
> {
  return {
    verdict: 'WAIT',
    wouldBlock: true,
    blocked: false,
    reasons,
    hits,
    recentSellCount: recent.length,
    largeSellCount: large.length,
    totalSellUsd,
  };
}

async function fetchRecentSellsWithIntel(
  mint: string,
  lookbackSec: number,
): Promise<LeraOverlaySellRow[]> {
  const mq = sqlQuote(mint);
  const lb = Math.max(30, Math.min(600, Math.floor(lookbackSec)));

  const rows = (await db.execute(dsql.raw(`
    WITH recent_sells AS (
      SELECT
        wallet,
        amount_usd::float AS amount_usd,
        EXTRACT(EPOCH FROM (now() - block_time))::float AS age_sec
      FROM swaps
      WHERE base_mint = ${mq}
        AND side = 'sell'
        AND amount_usd > 0
        AND block_time >= now() - (${lb} * interval '1 second')
      ORDER BY block_time DESC
      LIMIT 40
    )
    SELECT
      r.wallet,
      r.amount_usd,
      r.age_sec,
      EXISTS (
        SELECT 1 FROM wallet_intel_decisions d
        WHERE d.wallet_address = r.wallet AND d.decision = 'BLOCK_TRADE'
      ) AS intel_block,
      EXISTS (
        SELECT 1 FROM wallet_tags t
        WHERE t.wallet = r.wallet
          AND (t.tag IN ('bot', 'mev_bot') OR t.tag LIKE 'scam%')
      ) AS bad_tag,
      EXISTS (
        SELECT 1 FROM entity_wallets e
        WHERE e.wallet = r.wallet AND e.cluster_id IS NOT NULL
      ) AS clustered,
      EXISTS (
        SELECT 1 FROM scam_farm_meta_cluster_members m
        WHERE m.wallet = r.wallet
      ) AS scam_meta
    FROM recent_sells r
  `))) as unknown as Array<{
    wallet: string;
    amount_usd: number;
    age_sec: number;
    intel_block: boolean;
    bad_tag: boolean;
    clustered: boolean;
    scam_meta: boolean;
  }>;

  return rows.map((r) => ({
    wallet: r.wallet,
    amountUsd: Number(r.amount_usd) || 0,
    ageSec: Number(r.age_sec) || 0,
    intelBlock: Boolean(r.intel_block),
    badTag: Boolean(r.bad_tag),
    clustered: Boolean(r.clustered),
    scamMeta: Boolean(r.scam_meta),
  }));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lera_overlay_query_timeout')), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** Entry-moment on-chain overlay for Lera (shadow only — journals verdict, never blocks). */
export async function evaluateLeraEntryOnchainOverlay(
  mint: string,
  cfg: PaperTraderConfig,
): Promise<LeraEntryOnchainOverlayResult> {
  const lookbackSec = cfg.leraEntryOnchainOverlayLookbackSec;
  const base = {
    mode: 'shadow' as const,
    blocked: false as const,
    lookbackSec,
  };

  if (!cfg.leraEntryOnchainOverlayEnabled) {
    return {
      ...base,
      verdict: 'BUY',
      wouldBlock: false,
      reasons: ['overlay_disabled'],
      hits: [],
      recentSellCount: 0,
      largeSellCount: 0,
      totalSellUsd: 0,
    };
  }

  if (!MINT_RE.test(mint)) {
    return {
      ...base,
      verdict: 'BUY',
      wouldBlock: false,
      reasons: ['invalid_mint'],
      hits: [],
      recentSellCount: 0,
      largeSellCount: 0,
      totalSellUsd: 0,
      error: 'invalid_mint',
    };
  }

  const t0 = Date.now();
  try {
    const sells = await withTimeout(
      fetchRecentSellsWithIntel(mint, lookbackSec),
      cfg.leraEntryOnchainOverlayQueryTimeoutMs,
    );
    const queryMs = Date.now() - t0;
    const core = resolveLeraEntryOnchainOverlayVerdict(cfg, sells);
    return { ...base, ...core, queryMs };
  } catch (err) {
    const queryMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      verdict: 'BUY',
      wouldBlock: false,
      reasons: ['overlay_pg_error'],
      hits: [],
      recentSellCount: 0,
      largeSellCount: 0,
      totalSellUsd: 0,
      queryMs,
      error: msg.slice(0, 200),
    };
  }
}
