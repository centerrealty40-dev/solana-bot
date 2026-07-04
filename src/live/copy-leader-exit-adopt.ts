/**
 * Live-oscar adopts copy-leader positions for wave_b half8_runner exit (no leader mirror sell).
 * Copy-trader sets `oscarPromotedAt` on buy; this module seeds tracker `open` + journal durability.
 */
import fs from 'node:fs';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { applyEntryCosts } from '../papertrader/costs.js';
import { applyWaveBGridOverrides } from '../papertrader/executor/exit-policy-wave-b.js';
import { resolveLiveOscarMcapTier } from '../papertrader/live-oscar-mcap-tier.js';
import type { DexId, Metrics, OpenTrade, PositionLeg } from '../papertrader/types.js';
import type { ClosedTrade } from '../papertrader/types.js';
import {
  copyLeaderStatePathFromEnv,
  readCopyLeaderMintAttribution,
} from './copy-leader-attribution.js';
import {
  COPY_HANDOFF_WALLET_DUST_RAW,
  shouldSkipCopyLeaderExitAdopt,
} from './copy-oscar-handoff-lifecycle.js';
import { serializeOpenTrade } from './strategy-snapshot.js';

const EMPTY_METRICS: Metrics = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

function inferDex(mint: string): DexId {
  return mint.toLowerCase().endsWith('pump') ? 'pumpswap' : 'raydium';
}

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

export function copyLeaderExitAdoptEnabled(): boolean {
  return envBool(process.env.LIVE_COPY_LEADER_EXIT_ADOPT_ENABLED, true);
}

export type CopyLeaderExitAdoptResult = {
  adopted: string[];
  skippedAlreadyOpen: string[];
  skippedHandoffClosed: string[];
};

function buildOpenFromCopyLeader(args: {
  mint: string;
  symbol: string;
  investedUsd: number;
  entryPriceUsd: number;
  entryTs: number;
  entryMcapUsd?: number;
  entrySig?: string;
  paperCfg: PaperTraderConfig;
}): OpenTrade {
  const dex = inferDex(args.mint);
  const marketPrice = args.entryPriceUsd > 0 ? args.entryPriceUsd : args.investedUsd;
  const { effectivePrice } = applyEntryCosts(args.paperCfg, marketPrice, dex, args.investedUsd, null);
  const leg: PositionLeg = {
    ts: args.entryTs,
    price: effectivePrice,
    marketPrice,
    sizeUsd: args.investedUsd,
    reason: 'open',
  };
  const mcap = args.entryMcapUsd ?? 0;
  const tierRaw = resolveLiveOscarMcapTier(args.paperCfg, mcap);
  const tier =
    tierRaw === 'micro' || tierRaw === 'low' || tierRaw === 'prod' || tierRaw === 'scalp_wave'
      ? tierRaw
      : 'prod';

  const ot: OpenTrade = {
    mint: args.mint,
    symbol: args.symbol,
    lane: 'post_migration',
    metricType: 'price',
    dex,
    entryTs: args.entryTs,
    entryMcUsd: marketPrice,
    entryMarketCapUsd: mcap > 0 ? mcap : null,
    entryMetrics: { ...EMPTY_METRICS },
    peakMcUsd: marketPrice,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [leg],
    partialSells: [],
    totalInvestedUsd: args.investedUsd,
    avgEntry: effectivePrice,
    avgEntryMarket: marketPrice,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    liveOscarMcapTier: tier === 'scalp_wave' ? 'scalp_wave' : tier,
    liveOscarTradeLane: tier === 'scalp_wave' ? 'scalp_wave' : 'prod',
    copyToOscarPromoted: true,
    liveAnchorMode: args.entrySig ? 'chain' : 'simulate',
    entryLegSignatures: args.entrySig ? [args.entrySig] : undefined,
  };

  ot.liveExitPolicyId = 'wave_b_v1';
  ot.liveWaveFlatTpMode = 'half8_runner';
  ot.liveWaveTrailAnchorPnlFrac = 0;
  ot.liveWaveTrailLevelsTaken = [];
  ot.liveWavePeakPnlFrac = 0;
  ot.liveWaveMaxExecutedTpFrac = 0;
  applyWaveBGridOverrides(ot);
  if (ot.liveWaveFlatTpMode === 'half8_runner') {
    ot.tpGridOverrides = {
      ...ot.tpGridOverrides,
      gridStepPnl: 0.08,
      gridSellFractionByStep: [0.5],
      gridFirstRungRetraceMinPnlPct: 0,
    };
  }
  return ot;
}

/**
 * Seed live-oscar tracker opens from copy-trader state (`oscarPromotedAt` positions).
 */
export function adoptCopyLeaderExitOpens(args: {
  open: Map<string, OpenTrade>;
  paperCfg: PaperTraderConfig;
  journalLiveStrategy?: (body: Record<string, unknown>) => void;
  statePath?: string;
  /** Pre-fetched wallet SPL balances — skip adopt when chain empty (ghost heal guard). */
  chainMap?: Map<string, bigint> | null;
  /** Oscar closed trades — skip re-adopt after handoff exit. */
  closedTrades?: readonly ClosedTrade[];
}): CopyLeaderExitAdoptResult {
  const adopted: string[] = [];
  const skippedAlreadyOpen: string[] = [];
  const skippedHandoffClosed: string[] = [];
  if (!copyLeaderExitAdoptEnabled()) {
    return { adopted, skippedAlreadyOpen, skippedHandoffClosed };
  }

  const fp = args.statePath ?? copyLeaderStatePathFromEnv();
  if (!fp) return { adopted, skippedAlreadyOpen, skippedHandoffClosed };

  let parsed: { positions?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as typeof parsed;
  } catch {
    return { adopted, skippedAlreadyOpen, skippedHandoffClosed };
  }

  for (const [mint, row] of Object.entries(parsed.positions ?? {})) {
    const promotedAt = row.oscarPromotedAt;
    if (typeof promotedAt !== 'number' || !(promotedAt > 0)) continue;

    const attr = readCopyLeaderMintAttribution(mint, fp);
    if (!attr || !(attr.costBasisUsd > 0)) continue;

    if (args.open.has(mint)) {
      skippedAlreadyOpen.push(mint);
      continue;
    }

    const chainRaw = args.chainMap?.get(mint);
    const skipReason = shouldSkipCopyLeaderExitAdopt({
      mint,
      statePath: fp,
      chainRaw: chainRaw ?? (args.chainMap ? 0n : undefined),
      closedTrades: args.closedTrades,
      open: args.open,
    });
    if (skipReason) {
      skippedHandoffClosed.push(mint);
      continue;
    }

    if (args.chainMap && (chainRaw == null || chainRaw <= COPY_HANDOFF_WALLET_DUST_RAW)) {
      skippedHandoffClosed.push(mint);
      continue;
    }

    const symbol =
      typeof row.symbol === 'string' && row.symbol.trim() ? String(row.symbol).trim().slice(0, 32) : '?';
    const entryTs = typeof row.entryTs === 'number' && row.entryTs > 0 ? row.entryTs : promotedAt;
    const entryPriceUsd =
      typeof row.entryPriceUsd === 'number' && row.entryPriceUsd > 0
        ? row.entryPriceUsd
        : attr.entryPriceUsd ?? 0;
    const entryMcapUsd =
      typeof row.entryMcapUsd === 'number' && row.entryMcapUsd > 0 ? row.entryMcapUsd : undefined;
    const entrySig =
      typeof row.ourEntrySig === 'string' && row.ourEntrySig.length > 8 ? row.ourEntrySig : undefined;

    const ot = buildOpenFromCopyLeader({
      mint,
      symbol,
      investedUsd: attr.costBasisUsd,
      entryPriceUsd,
      entryTs,
      entryMcapUsd,
      entrySig,
      paperCfg: args.paperCfg,
    });

    args.open.set(mint, ot);
    adopted.push(mint);

    args.journalLiveStrategy?.({
      kind: 'live_position_open',
      mint,
      entryPath: 'copy_leader_exit_adopt',
      openTrade: {
        ...serializeOpenTrade(ot),
        copyLeaderExitAdopted: true,
      },
    });
  }

  return { adopted, skippedAlreadyOpen, skippedHandoffClosed };
}
