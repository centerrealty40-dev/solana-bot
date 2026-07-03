/**
 * Volume authenticity analyzer — wash vs organic swap flow (Pervyy Vystrel PR2, spec §6.4).
 * Pure compute from swap rows; PG fetch optional for batch materialize.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PervyyVystrelConfig } from '../live-oscar-pervyy-vystrel-config.js';

export interface VolAuthSwapRow {
  wallet: string;
  side: 'buy' | 'sell' | string;
  amountUsd: number;
  blockTimeMs: number;
}

export interface VolumeAuthenticitySignals {
  swapCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  uniqueBuyerSellerRatio: number | null;
  roundTripShare: number | null;
  selfTradeRatio: number | null;
  netNewWalletShare: number | null;
  cycleShare: number | null;
  totalVolumeUsd: number;
  holderDelta30mPct: number | null;
  volumeWithoutHolderGrowth: boolean;
}

export interface VolumeAuthenticitySnapshot {
  mint: string;
  windowHours: number;
  computedAtMs: number;
  signals: VolumeAuthenticitySignals;
  washScore: number;
  organicScore: number;
  authenticPass: boolean;
  insufficientData: boolean;
  reasons: string[];
}

export interface VolumeAuthenticityThresholds {
  minSwaps: number;
  washMax: number;
  organicMin: number;
  maxRoundTripShare: number;
  maxCycleShare: number;
  minBuyerSellerRatio: number;
  maxSelfTradeRatio: number;
  minNetNewShare: number;
  holderStallPct: number;
  minVol1hUsd: number;
  failOpen: boolean;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function bucket5m(tsMs: number): number {
  return Math.floor(tsMs / FIVE_MIN_MS);
}

export function volumeAuthenticityThresholdsFromConfig(
  pv: Pick<
    PervyyVystrelConfig,
    | 'volAuthWashMax'
    | 'volAuthOrganicMin'
    | 'volAuthMaxRoundTripShare'
    | 'volAuthFailOpen'
    | 'minVol1hUsd'
    | 'volAuthMinSwaps'
    | 'volAuthMaxCycleShare'
    | 'volAuthMinBsRatio'
    | 'volAuthMaxSelfTrade'
    | 'volAuthMinNetNewShare'
    | 'volAuthHolderStallPct'
  >,
): VolumeAuthenticityThresholds {
  return {
    minSwaps: pv.volAuthMinSwaps,
    washMax: pv.volAuthWashMax,
    organicMin: pv.volAuthOrganicMin,
    maxRoundTripShare: pv.volAuthMaxRoundTripShare,
    maxCycleShare: pv.volAuthMaxCycleShare,
    minBuyerSellerRatio: pv.volAuthMinBsRatio,
    maxSelfTradeRatio: pv.volAuthMaxSelfTrade,
    minNetNewShare: pv.volAuthMinNetNewShare,
    holderStallPct: pv.volAuthHolderStallPct,
    minVol1hUsd: pv.minVol1hUsd,
    failOpen: pv.volAuthFailOpen,
  };
}

/** Prior swap history on mint before window — for net-new wallet share (V6). */
export function computeVolumeAuthenticitySnapshot(args: {
  mint: string;
  windowHours: number;
  swaps: VolAuthSwapRow[];
  priorBuyerWallets?: Set<string>;
  holderDelta30mPct?: number | null;
  roundTripMaxMin?: number;
  computedAtMs?: number;
  thresholds: VolumeAuthenticityThresholds;
}): VolumeAuthenticitySnapshot {
  const {
    mint,
    windowHours,
    swaps,
    priorBuyerWallets = new Set<string>(),
    holderDelta30mPct = null,
    roundTripMaxMin = 60,
    computedAtMs = Date.now(),
    thresholds,
  } = args;

  const reasons: string[] = [];
  const swapCount = swaps.length;

  if (swapCount < thresholds.minSwaps) {
    return {
      mint,
      windowHours,
      computedAtMs,
      signals: emptySignals(swapCount),
      washScore: 0,
      organicScore: 0,
      authenticPass: thresholds.failOpen,
      insufficientData: true,
      reasons: [`swap_count<${thresholds.minSwaps}`],
    };
  }

  let totalVol = 0;
  const buyVolByWallet = new Map<string, number>();
  const sellVolByWallet = new Map<string, number>();
  const buyBuckets = new Map<string, Set<number>>();
  const sellBuckets = new Map<string, Set<number>>();

  for (const s of swaps) {
    const usd = Math.max(0, Number(s.amountUsd) || 0);
    if (usd <= 0) continue;
    totalVol += usd;
    const side = String(s.side).toLowerCase();
    const b = bucket5m(s.blockTimeMs);
    if (side === 'buy') {
      buyVolByWallet.set(s.wallet, (buyVolByWallet.get(s.wallet) ?? 0) + usd);
      const set = buyBuckets.get(s.wallet) ?? new Set<number>();
      set.add(b);
      buyBuckets.set(s.wallet, set);
    } else if (side === 'sell') {
      sellVolByWallet.set(s.wallet, (sellVolByWallet.get(s.wallet) ?? 0) + usd);
      const set = sellBuckets.get(s.wallet) ?? new Set<number>();
      set.add(b);
      sellBuckets.set(s.wallet, set);
    }
  }

  if (totalVol <= 0) {
    return {
      mint,
      windowHours,
      computedAtMs,
      signals: emptySignals(swapCount),
      washScore: 1,
      organicScore: 0,
      authenticPass: false,
      insufficientData: true,
      reasons: ['zero_volume'],
    };
  }

  const uniqueBuyers = buyVolByWallet.size;
  const uniqueSellers = sellVolByWallet.size;
  const uniqueBuyerSellerRatio =
    uniqueSellers > 0 ? uniqueBuyers / uniqueSellers : uniqueBuyers > 0 ? uniqueBuyers : null;

  let roundTripVol = 0;
  const roundTripWindowMs = roundTripMaxMin * 60 * 1000;
  const minTs = Math.min(...swaps.map((s) => s.blockTimeMs));
  const maxTs = Math.max(...swaps.map((s) => s.blockTimeMs));
  const windowSpanOk = maxTs - minTs <= roundTripWindowMs + 1;

  for (const [wallet, buyUsd] of buyVolByWallet) {
    const sellUsd = sellVolByWallet.get(wallet) ?? 0;
    if (sellUsd > 0 && windowSpanOk) {
      roundTripVol += Math.min(buyUsd, sellUsd);
    }
  }
  const roundTripShare = roundTripVol / totalVol;

  let selfTradeVol = 0;
  for (const wallet of new Set([...buyBuckets.keys(), ...sellBuckets.keys()])) {
    const bb = buyBuckets.get(wallet);
    const sb = sellBuckets.get(wallet);
    if (!bb || !sb) continue;
    for (const b of bb) {
      if (sb.has(b)) {
        selfTradeVol += (buyVolByWallet.get(wallet) ?? 0) + (sellVolByWallet.get(wallet) ?? 0);
        break;
      }
    }
  }
  const selfTradeRatio = Math.min(1, selfTradeVol / (2 * totalVol));

  let netNewBuyVol = 0;
  for (const [wallet, usd] of buyVolByWallet) {
    if (!priorBuyerWallets.has(wallet)) netNewBuyVol += usd;
  }
  const buyVolTotal = [...buyVolByWallet.values()].reduce((a, b) => a + b, 0);
  const netNewWalletShare = buyVolTotal > 0 ? netNewBuyVol / buyVolTotal : null;

  const cycleShare = roundTripShare;

  const holderStall =
    holderDelta30mPct != null &&
    totalVol >= thresholds.minVol1hUsd &&
    holderDelta30mPct <= thresholds.holderStallPct;
  const volumeWithoutHolderGrowth = holderStall;

  const ratioNorm =
    uniqueBuyerSellerRatio != null
      ? clamp01((uniqueBuyerSellerRatio - 1) / Math.max(0.15, thresholds.minBuyerSellerRatio - 1))
      : 0;

  const washComponents = [
    roundTripShare / Math.max(thresholds.maxRoundTripShare, 1e-9),
    cycleShare / Math.max(thresholds.maxCycleShare, 1e-9),
    selfTradeRatio / Math.max(thresholds.maxSelfTradeRatio, 1e-9),
  ];
  let washScore = clamp01(Math.max(...washComponents));
  if (volumeWithoutHolderGrowth) washScore = clamp01(washScore + 0.15);

  const netNewNorm =
    netNewWalletShare != null
      ? clamp01(netNewWalletShare / Math.max(thresholds.minNetNewShare, 1e-9))
      : 0;
  const organicScore = clamp01(netNewNorm * ratioNorm * (1 - washScore));

  if (washScore >= thresholds.washMax) reasons.push(`wash_score>=${thresholds.washMax}`);
  if (organicScore < thresholds.organicMin) reasons.push(`organic_score<${thresholds.organicMin}`);
  if (roundTripShare > thresholds.maxRoundTripShare) reasons.push('round_trip_high');
  if (uniqueBuyerSellerRatio != null && uniqueBuyerSellerRatio < thresholds.minBuyerSellerRatio) {
    reasons.push('buyer_seller_ratio_low');
  }
  if (volumeWithoutHolderGrowth) reasons.push('volume_without_holder_growth');

  const authenticPass =
    washScore < thresholds.washMax &&
    organicScore >= thresholds.organicMin &&
    !volumeWithoutHolderGrowth;

  return {
    mint,
    windowHours,
    computedAtMs,
    signals: {
      swapCount,
      uniqueBuyers,
      uniqueSellers,
      uniqueBuyerSellerRatio,
      roundTripShare,
      selfTradeRatio,
      netNewWalletShare,
      cycleShare,
      totalVolumeUsd: totalVol,
      holderDelta30mPct,
      volumeWithoutHolderGrowth,
    },
    washScore,
    organicScore,
    authenticPass,
    insufficientData: false,
    reasons,
  };
}

function emptySignals(swapCount: number): VolumeAuthenticitySignals {
  return {
    swapCount,
    uniqueBuyers: 0,
    uniqueSellers: 0,
    uniqueBuyerSellerRatio: null,
    roundTripShare: null,
    selfTradeRatio: null,
    netNewWalletShare: null,
    cycleShare: null,
    totalVolumeUsd: 0,
    holderDelta30mPct: null,
    volumeWithoutHolderGrowth: false,
  };
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchVolAuthSwapsFromPg(
  mint: string,
  windowHours: number,
): Promise<VolAuthSwapRow[]> {
  const h = Math.max(0.25, Math.min(24, windowHours));
  const mintSql = sqlQuote(mint);
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

export async function fetchPriorBuyerWallets(mint: string, beforeHours: number): Promise<Set<string>> {
  const mintSql = sqlQuote(mint);
  const rows = (await db.execute(dsql.raw(`
    SELECT DISTINCT wallet
    FROM swaps
    WHERE base_mint = ${mintSql}
      AND side = 'buy'
      AND block_time < now() - interval '${beforeHours} hours'
    LIMIT 500
  `))) as unknown as Array<{ wallet: string }>;
  return new Set(rows.map((r) => r.wallet));
}

export async function fetchHolderCount(mint: string): Promise<number | null> {
  const mintSql = sqlQuote(mint);
  const rows = (await db.execute(dsql.raw(`
    SELECT holder_count FROM tokens WHERE mint = ${mintSql} LIMIT 1
  `))) as unknown as Array<{ holder_count: number | null }>;
  const v = rows[0]?.holder_count;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}
