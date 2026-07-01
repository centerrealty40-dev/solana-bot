/**
 * Copy-leader → live-oscar handoff when discovery passes on a mint copy already holds.
 * Top-up wallet to Oscar mcap-tier target; copy-trader stops mirror sells after promotion.
 */
import {
  isCopyLeaderPromotedToOscar,
  markCopyLeaderPromotedToOscar,
  readCopyLeaderMintAttribution,
} from './copy-leader-attribution.js';
import type { LivePhase4BuyOpenContext } from './phase4-types.js';
import { resolveLiveOscarStagedEntryMaxUsd } from '../papertrader/live-oscar-entry-sizing.js';
import { resolveLiveOscarMcapTier } from '../papertrader/live-oscar-mcap-tier.js';
import type { LiveOscarTradeLane } from '../papertrader/live-oscar-scalp-wave.js';
import type { OpenTrade, PositionLeg } from '../papertrader/types.js';
import {
  entrySplitTimedLegIndices,
  setEntrySplitLegDone,
} from '../papertrader/entry-split-legs.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import type { LiveBuyPipelineResult } from './phase4-types.js';

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

export function copyToOscarPromotionEnabled(): boolean {
  return envBool(process.env.LIVE_COPY_TO_OSCAR_PROMOTION_ENABLED, true);
}

export type CopyToOscarPromotionPlan = {
  copyCostBasisUsd: number;
  walletGrossUsd: number;
  targetUsd: number;
  topUpUsd: number;
  tier: 'micro' | 'low' | 'prod';
  copyEntryPriceUsd?: number;
};

/** Minimum top-up before skipping market buy (handoff-only when below). */
const MIN_TOP_UP_USD = 5;

function decisionTradeLane(ctx: LivePhase4BuyOpenContext): LiveOscarTradeLane {
  if (ctx.decision.liveOscarTradeLane) return ctx.decision.liveOscarTradeLane;
  if (ctx.decision.positionSource === 'runner_probe') return 'runner_probe';
  return 'prod';
}

export function evaluateCopyToOscarPromotionPlan(args: {
  ctx: LivePhase4BuyOpenContext;
  walletGrossUsd: number;
}): CopyToOscarPromotionPlan | null {
  if (!copyToOscarPromotionEnabled()) return null;
  const { ctx, walletGrossUsd } = args;
  const lane = decisionTradeLane(ctx);
  if (lane === 'runner_probe' || lane === 'scalp_wave') return null;

  const copy = readCopyLeaderMintAttribution(ctx.ot.mint);
  if (!copy || isCopyLeaderPromotedToOscar(ctx.ot.mint)) return null;

  const mcap = ctx.decision.features.market_cap_usd ?? ctx.ot.entryMarketCapUsd ?? null;
  const tier = resolveLiveOscarMcapTier(ctx.paperCfg, mcap ?? 0);
  if (tier !== 'micro' && tier !== 'low' && tier !== 'prod') return null;

  const targetUsd = resolveLiveOscarStagedEntryMaxUsd(ctx.paperCfg, tier, mcap);
  if (!(targetUsd > 0)) return null;

  const topUpUsd = Math.max(0, targetUsd - walletGrossUsd);
  return {
    copyCostBasisUsd: copy.costBasisUsd,
    walletGrossUsd,
    targetUsd,
    topUpUsd,
    tier,
    copyEntryPriceUsd: copy.entryPriceUsd,
  };
}

export function defaultBuyOpenLegUsd(ctx: LivePhase4BuyOpenContext): number {
  return (
    ctx.ot.legs[0]?.sizeUsd ??
    ctx.paperCfg.positionUsd * ctx.paperCfg.entryFirstLegFraction
  );
}

/** Intended buy notional for Phase 5 capital gate + execution (promotion top-up or first leg). */
export function resolveLiveBuyOpenIntendedUsd(args: {
  ctx: LivePhase4BuyOpenContext;
  walletGrossUsd: number | null;
}): { usd: number; promotion: CopyToOscarPromotionPlan | null } {
  const firstUsd = defaultBuyOpenLegUsd(args.ctx);
  if (args.walletGrossUsd == null) return { usd: firstUsd, promotion: null };

  const promotion = evaluateCopyToOscarPromotionPlan({
    ctx: args.ctx,
    walletGrossUsd: args.walletGrossUsd,
  });
  if (!promotion) return { usd: firstUsd, promotion: null };

  if (promotion.topUpUsd >= MIN_TOP_UP_USD) {
    return { usd: promotion.topUpUsd, promotion };
  }
  return { usd: 0, promotion };
}

function markStagedEntryFullyAllocated(ot: OpenTrade): void {
  const st = ot.liveStagedEntry;
  if (!st) return;
  for (const legIndex of entrySplitTimedLegIndices()) {
    setEntrySplitLegDone(st, legIndex, true);
  }
  st.avgFirstLegDone = true;
  st.avgSecondLegDone = true;
  st.secondLegDone = true;
  if (st.avgThirdLegUsd != null && st.avgThirdLegUsd > 0) {
    st.thirdLegDone = true;
  }
}

/** Seed open trade with copy leg + reconcile after promotion top-up buy. */
export function applyCopyToOscarPromotionAccounting(args: {
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  res: LiveBuyPipelineResult;
  plan: CopyToOscarPromotionPlan;
  snapshotPriceUsd: number;
}): void {
  const { ot, plan, snapshotPriceUsd } = args;
  const copyPx =
    plan.copyEntryPriceUsd != null && plan.copyEntryPriceUsd > 0
      ? plan.copyEntryPriceUsd
      : snapshotPriceUsd;

  const copyLeg: PositionLeg = {
    ts: ot.entryTs,
    price: copyPx,
    marketPrice: snapshotPriceUsd,
    sizeUsd: plan.copyCostBasisUsd,
    reason: 'open',
  };

  const topUpUsd = args.res.executedUsdNotional ?? plan.topUpUsd;
  if (topUpUsd >= MIN_TOP_UP_USD) {
    const topUpLeg: PositionLeg = {
      ts: Date.now(),
      price: snapshotPriceUsd,
      marketPrice: snapshotPriceUsd,
      sizeUsd: topUpUsd,
      reason: 'open',
    };
    ot.legs = [copyLeg, topUpLeg];
  } else {
    ot.legs = [copyLeg];
  }

  ot.totalInvestedUsd = ot.legs.reduce((s, l) => s + l.sizeUsd, 0);
  if (ot.totalInvestedUsd > 0) {
    const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
    ot.avgEntry = num / ot.totalInvestedUsd;
    const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
    ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  }

  ot.copyToOscarPromoted = true;

  if (ot.totalInvestedUsd + 1e-6 >= plan.targetUsd) {
    markStagedEntryFullyAllocated(ot);
  }
}

export function finalizeCopyToOscarHandoff(mint: string): boolean {
  return markCopyLeaderPromotedToOscar({ mint });
}
