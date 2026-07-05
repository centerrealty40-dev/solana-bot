/**
 * Live-oscar adopts copy-leader positions for wave_b half8_runner exit (no leader mirror sell).
 * Copy-trader sets `oscarPromotedAt` on buy; this module seeds tracker `open` + journal durability.
 */
import fs from 'node:fs';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { applyEntryCosts } from '../papertrader/costs.js';
import { applyWaveBGridOverrides } from '../papertrader/executor/exit-policy-wave-b.js';
import {
  buildLiveStagedEntryState,
  markEntrySplitLeg1Filled,
} from '../papertrader/executor/live-staged-entry-gates.js';
import { applyCanonicalOpenLegUsd } from '../papertrader/live-oscar-entry-sizing.js';
import {
  resolveLiveOscarMcapTier,
  type LiveOscarMcapTier,
  type LiveOscarTradeTier,
} from '../papertrader/live-oscar-mcap-tier.js';
import { resolveBirdeyeMarketQuote } from '../papertrader/pricing/birdeye-market.js';
import type { DexId, Metrics, OpenTrade, PositionLeg } from '../papertrader/types.js';
import type { ClosedTrade } from '../papertrader/types.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';
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

export type CopyLeaderAdoptBlockReason = 'mcap_unknown' | 'mcap_below_threshold';

export type CopyLeaderAdoptTierResolution = {
  mcapUsd: number | null;
  mcapTier: LiveOscarMcapTier;
  tradeTier: LiveOscarTradeTier | undefined;
  adoptBlocked: boolean;
  blockReason?: CopyLeaderAdoptBlockReason;
};

/** Resolve trade tier for copy adopt — mirrors discovery mcap gate (below → block). */
export function resolveCopyLeaderAdoptTier(
  cfg: PaperTraderConfig,
  mcapUsd: number | null | undefined,
): CopyLeaderAdoptTierResolution {
  if (mcapUsd == null || !(mcapUsd > 0)) {
    return {
      mcapUsd: null,
      mcapTier: 'below',
      tradeTier: undefined,
      adoptBlocked: true,
      blockReason: 'mcap_unknown',
    };
  }
  const mcapTier = resolveLiveOscarMcapTier(cfg, mcapUsd);
  if (mcapTier === 'below') {
    return {
      mcapUsd,
      mcapTier,
      tradeTier: undefined,
      adoptBlocked: true,
      blockReason: 'mcap_below_threshold',
    };
  }
  const tradeTier: LiveOscarTradeTier | undefined =
    mcapTier === 'micro' || mcapTier === 'low' || mcapTier === 'prod' || mcapTier === 'scalp_wave'
      ? mcapTier
      : undefined;
  if (!tradeTier) {
    return {
      mcapUsd,
      mcapTier,
      tradeTier: undefined,
      adoptBlocked: true,
      blockReason: 'mcap_below_threshold',
    };
  }
  return { mcapUsd, mcapTier, tradeTier, adoptBlocked: false };
}

export type CopyLeaderExitAdoptResult = {
  adopted: string[];
  retroAttachedStagedEntry: string[];
  skippedAlreadyOpen: string[];
  skippedHandoffClosed: string[];
  skippedBelowMcap: string[];
};

function copyLeaderLiveStagedEntryActive(cfg: PaperTraderConfig): boolean {
  return isLiveOscarTradingStrategyId(cfg.strategyId) && cfg.liveStagedEntryEnabled;
}

function stampCopyLeaderAdoptTierFields(
  ot: OpenTrade,
  args: { entryMcapUsd: number; tradeTier: LiveOscarTradeTier },
): void {
  ot.entryMarketCapUsd = args.entryMcapUsd;
  ot.liveOscarMcapTier = args.tradeTier;
  if (args.tradeTier !== 'scalp_wave') {
    ot.liveOscarTradeLane = 'prod';
  }
}

/** Mirror discovery `attachLiveStagedEntryPlan`: copy buy = entry-split leg1 + pending avg legs. */
function attachCopyLeaderLiveStagedEntryPlan(
  ot: OpenTrade,
  args: {
    paperCfg: PaperTraderConfig;
    entryTs: number;
    entryPriceUsd: number;
    entryMcapUsd: number;
    tradeTier: LiveOscarTradeTier;
  },
): boolean {
  if (!copyLeaderLiveStagedEntryActive(args.paperCfg)) return false;
  const signalPriceUsd =
    args.entryPriceUsd > 0 ? args.entryPriceUsd : ot.avgEntryMarket ?? ot.avgEntry ?? 0;
  if (!(signalPriceUsd > 0)) return false;

  stampCopyLeaderAdoptTierFields(ot, {
    entryMcapUsd: args.entryMcapUsd,
    tradeTier: args.tradeTier,
  });

  ot.liveStagedEntry = buildLiveStagedEntryState(
    args.paperCfg,
    { signalTs: args.entryTs, signalPriceUsd },
    { marketCapUsd: args.entryMcapUsd },
  );
  markEntrySplitLeg1Filled(ot.liveStagedEntry, ot);
  applyCanonicalOpenLegUsd(args.paperCfg, ot);
  return true;
}

function buildOpenFromCopyLeader(args: {
  mint: string;
  symbol: string;
  investedUsd: number;
  entryPriceUsd: number;
  entryTs: number;
  entryMcapUsd: number;
  tradeTier: LiveOscarTradeTier;
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
  const tier = args.tradeTier;

  const ot: OpenTrade = {
    mint: args.mint,
    symbol: args.symbol,
    lane: 'post_migration',
    metricType: 'price',
    dex,
    entryTs: args.entryTs,
    entryMcUsd: marketPrice,
    entryMarketCapUsd: args.entryMcapUsd,
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

  attachCopyLeaderLiveStagedEntryPlan(ot, {
    paperCfg: args.paperCfg,
    entryTs: args.entryTs,
    entryPriceUsd: marketPrice,
    entryMcapUsd: args.entryMcapUsd,
    tradeTier: tier,
  });

  return ot;
}

export type ResolveCopyLeaderAdoptMcapUsd = (
  mint: string,
  entryMcapUsd?: number,
) => Promise<number | null>;

async function defaultResolveCopyLeaderAdoptMcapUsd(
  mint: string,
  paperCfg: PaperTraderConfig,
  entryMcapUsd?: number,
): Promise<number | null> {
  const apiKey = process.env.BIRDEYE_API_KEY?.trim();
  if (apiKey) {
    const quote = await resolveBirdeyeMarketQuote(mint, {
      apiKey,
      ttlMs: paperCfg.birdeyeMarketTtlMs,
      fetchVolume5m: false,
    });
    if (
      quote?.marketCapUsd != null &&
      quote.marketCapUsd > 0 &&
      quote.tierInsufficient !== true
    ) {
      return quote.marketCapUsd;
    }
  }
  if (entryMcapUsd != null && entryMcapUsd > 0) return entryMcapUsd;
  return null;
}

/**
 * Seed live-oscar tracker opens from copy-trader state (`oscarPromotedAt` positions).
 */
export async function adoptCopyLeaderExitOpens(args: {
  open: Map<string, OpenTrade>;
  paperCfg: PaperTraderConfig;
  journalLiveStrategy?: (body: Record<string, unknown>) => void;
  statePath?: string;
  /** Pre-fetched wallet SPL balances — skip adopt when chain empty (ghost heal guard). */
  chainMap?: Map<string, bigint> | null;
  /** Oscar closed trades — skip re-adopt after handoff exit. */
  closedTrades?: readonly ClosedTrade[];
  /** Test hook: override Birdeye mcap resolution. */
  resolveMcapUsd?: ResolveCopyLeaderAdoptMcapUsd;
}): Promise<CopyLeaderExitAdoptResult> {
  const adopted: string[] = [];
  const retroAttachedStagedEntry: string[] = [];
  const skippedAlreadyOpen: string[] = [];
  const skippedHandoffClosed: string[] = [];
  const skippedBelowMcap: string[] = [];
  if (!copyLeaderExitAdoptEnabled()) {
    return { adopted, retroAttachedStagedEntry, skippedAlreadyOpen, skippedHandoffClosed, skippedBelowMcap };
  }

  const fp = args.statePath ?? copyLeaderStatePathFromEnv();
  if (!fp) {
    return { adopted, retroAttachedStagedEntry, skippedAlreadyOpen, skippedHandoffClosed, skippedBelowMcap };
  }

  let parsed: { positions?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as typeof parsed;
  } catch {
    return { adopted, retroAttachedStagedEntry, skippedAlreadyOpen, skippedHandoffClosed, skippedBelowMcap };
  }

  const resolveMcapUsd =
    args.resolveMcapUsd ??
    ((mint, entryMcapUsd) => defaultResolveCopyLeaderAdoptMcapUsd(mint, args.paperCfg, entryMcapUsd));

  for (const [mint, row] of Object.entries(parsed.positions ?? {})) {
    const promotedAt = row.oscarPromotedAt;
    if (typeof promotedAt !== 'number' || !(promotedAt > 0)) continue;

    const attr = readCopyLeaderMintAttribution(mint, fp);
    if (!attr || !(attr.costBasisUsd > 0)) continue;

    const entryTs = typeof row.entryTs === 'number' && row.entryTs > 0 ? row.entryTs : promotedAt;
    const entryPriceUsd =
      typeof row.entryPriceUsd === 'number' && row.entryPriceUsd > 0
        ? row.entryPriceUsd
        : attr.entryPriceUsd ?? 0;
    const stateEntryMcapUsd =
      typeof row.entryMcapUsd === 'number' && row.entryMcapUsd > 0 ? row.entryMcapUsd : undefined;

    const resolvedMcapUsd = await resolveMcapUsd(mint, stateEntryMcapUsd);
    const tierCtx = resolveCopyLeaderAdoptTier(args.paperCfg, resolvedMcapUsd);
    if (tierCtx.adoptBlocked || !tierCtx.tradeTier || tierCtx.mcapUsd == null) {
      skippedBelowMcap.push(mint);
      continue;
    }

    if (args.open.has(mint)) {
      const existing = args.open.get(mint)!;
      if (existing.liveStagedEntry) {
        skippedAlreadyOpen.push(mint);
        continue;
      }
      if (
        existing.copyToOscarPromoted &&
        attachCopyLeaderLiveStagedEntryPlan(existing, {
          paperCfg: args.paperCfg,
          entryTs,
          entryPriceUsd,
          entryMcapUsd: tierCtx.mcapUsd,
          tradeTier: tierCtx.tradeTier,
        })
      ) {
        retroAttachedStagedEntry.push(mint);
        args.journalLiveStrategy?.({
          kind: 'live_staged_entry_attached',
          mint,
          entryPath: 'copy_leader_exit_adopt',
          openTrade: serializeOpenTrade(existing),
        });
      } else {
        skippedAlreadyOpen.push(mint);
      }
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
    const entrySig =
      typeof row.ourEntrySig === 'string' && row.ourEntrySig.length > 8 ? row.ourEntrySig : undefined;

    const ot = buildOpenFromCopyLeader({
      mint,
      symbol,
      investedUsd: attr.costBasisUsd,
      entryPriceUsd,
      entryTs,
      entryMcapUsd: tierCtx.mcapUsd,
      tradeTier: tierCtx.tradeTier,
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

  return { adopted, retroAttachedStagedEntry, skippedAlreadyOpen, skippedHandoffClosed, skippedBelowMcap };
}
