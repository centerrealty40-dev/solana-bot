import type { LiveOscarMcapTier } from '../papertrader/live-oscar-mcap-tier.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { resolveLiveOscarTradeTierFromOpen } from '../papertrader/live-oscar-mcap-tier.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveBuyPipelineResult } from './phase4-types.js';

/** Tier ≥ $2M (low $2–3M, prod ≥ $3M) — Jupiter buy slicing for staged adds. */
export function isEntryBuySliceTierEligible(tier: LiveOscarMcapTier | undefined): boolean {
  return tier === 'low' || tier === 'prod';
}

export function entryBuySliceEligibleForOpen(
  cfg: PaperTraderConfig,
  ot: {
    liveOscarMcapTier?: 'micro' | 'low' | 'prod' | 'scalp_wave';
    entryMarketCapUsd?: number | null;
  },
): boolean {
  const tier = resolveLiveOscarTradeTierFromOpen(cfg, ot);
  return isEntryBuySliceTierEligible(tier);
}

/** Plan USD slices for a live entry/averaging buy when notional exceeds `maxUsdPerSlice`. */
export function planEntryBuySlices(args: {
  totalUsdNotional: number;
  maxUsdPerSlice: number;
}): number[] {
  const { totalUsdNotional, maxUsdPerSlice } = args;
  if (
    !(totalUsdNotional > 0) ||
    !(maxUsdPerSlice > 0) ||
    totalUsdNotional <= maxUsdPerSlice + 1e-9
  ) {
    return [totalUsdNotional];
  }

  const slices: number[] = [];
  let remaining = totalUsdNotional;
  while (remaining > maxUsdPerSlice + 1e-9) {
    slices.push(maxUsdPerSlice);
    remaining -= maxUsdPerSlice;
  }
  if (remaining > 1e-9) {
    slices.push(remaining);
  }
  return slices;
}

type SolToTokenPipelineArgs = {
  mint: string;
  symbol: string;
  usdNotional: number;
  intentKind: 'buy_open' | 'dca_add' | 'buy_scale_in';
};

type RunSolToTokenPipeline = (
  liveCfg: LiveOscarConfig,
  args: SolToTokenPipelineArgs,
) => Promise<LiveBuyPipelineResult>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function shouldRunEntryBuySlices(args: {
  liveCfg: LiveOscarConfig;
  usdNotional: number;
  intentKind: 'buy_open' | 'dca_add' | 'buy_scale_in';
  entryBuySliceEligible?: boolean;
}): boolean {
  if (args.intentKind === 'buy_open') return false;
  if (!args.entryBuySliceEligible) return false;
  const maxUsd = args.liveCfg.liveEntrySliceMaxUsd;
  return maxUsd > 0 && args.usdNotional > maxUsd + 1e-9;
}

/**
 * When planned buy notional exceeds `liveEntrySliceMaxUsd` on low/prod tier staged adds,
 * execute multiple Jupiter buys with `liveEntrySliceDelayMs` gap.
 */
export async function runSlicedSolToTokenPipeline(
  liveCfg: LiveOscarConfig,
  args: SolToTokenPipelineArgs & { entryBuySliceEligible?: boolean },
  runOne: RunSolToTokenPipeline,
): Promise<LiveBuyPipelineResult> {
  if (
    !shouldRunEntryBuySlices({
      liveCfg,
      usdNotional: args.usdNotional,
      intentKind: args.intentKind,
      entryBuySliceEligible: args.entryBuySliceEligible,
    })
  ) {
    return runOne(liveCfg, args);
  }

  const maxUsd = liveCfg.liveEntrySliceMaxUsd;
  const plan = planEntryBuySlices({
    totalUsdNotional: args.usdNotional,
    maxUsdPerSlice: maxUsd,
  });
  if (plan.length <= 1) {
    return runOne(liveCfg, args);
  }

  appendLiveJsonlEvent({
    kind: 'entry_slice_plan',
    mint: args.mint.slice(0, 12),
    intentKind: args.intentKind,
    totalUsdNotional: +args.usdNotional.toFixed(4),
    maxUsdPerSlice: maxUsd,
    sliceCount: plan.length,
    delayMs: liveCfg.liveEntrySliceDelayMs,
  });

  let totalExecutedUsd = 0;
  let lastTxSig: string | null | undefined;
  const allTxSigs: string[] = [];
  let anchorMode: LiveBuyPipelineResult['anchorMode'] = 'simulate';

  for (let i = 0; i < plan.length; i++) {
    if (i > 0 && liveCfg.liveEntrySliceDelayMs > 0) {
      await sleep(liveCfg.liveEntrySliceDelayMs);
    }
    const sliceUsd = plan[i]!;
    appendLiveJsonlEvent({
      kind: 'entry_slice_attempt',
      mint: args.mint.slice(0, 12),
      sliceIndex: i,
      sliceCount: plan.length,
      usdNotional: +sliceUsd.toFixed(4),
      intentKind: args.intentKind,
    });

    const r = await runOne(liveCfg, {
      mint: args.mint,
      symbol: args.symbol,
      usdNotional: sliceUsd,
      intentKind: args.intentKind,
    });

    if (!r.ok) {
      /**
       * Partial fill: one or more EARLIER slices already confirmed on-chain. Those buys are
       * real (tokens are in the wallet), so we must NOT discard them — return `ok:true`
       * with the executed notional + all confirmed signatures so the caller records the
       * leg (and stops re-firing the whole add). Only a fill of ZERO slices is a real failure.
       */
      const anyFilled = totalExecutedUsd > 0 || allTxSigs.length > 0;
      appendLiveJsonlEvent({
        kind: 'entry_slice_result',
        mint: args.mint.slice(0, 12),
        sliceIndex: i,
        sliceCount: plan.length,
        ok: anyFilled,
        partial: anyFilled,
        slicesCompleted: i,
        executedUsdNotional: +totalExecutedUsd.toFixed(4),
      });
      if (anyFilled) {
        return {
          ok: true,
          partial: true,
          anchorMode,
          confirmedBuyTxSignature: lastTxSig ?? r.confirmedBuyTxSignature,
          confirmedBuyTxSignatures: allTxSigs.length > 0 ? allTxSigs : undefined,
          executedUsdNotional: totalExecutedUsd,
        };
      }
      return {
        ...r,
        executedUsdNotional: r.executedUsdNotional,
        confirmedBuyTxSignature: r.confirmedBuyTxSignature,
        anchorMode,
      };
    }

    anchorMode = r.anchorMode;
    totalExecutedUsd += r.executedUsdNotional ?? sliceUsd;
    if (r.confirmedBuyTxSignatures?.length) {
      for (const sig of r.confirmedBuyTxSignatures) {
        if (sig && !allTxSigs.includes(sig)) allTxSigs.push(sig);
      }
    } else if (r.confirmedBuyTxSignature) {
      allTxSigs.push(r.confirmedBuyTxSignature);
    }
    lastTxSig = allTxSigs[allTxSigs.length - 1];
  }

  appendLiveJsonlEvent({
    kind: 'entry_slice_result',
    mint: args.mint.slice(0, 12),
    sliceCount: plan.length,
    ok: true,
    slicesCompleted: plan.length,
  });

  return {
    ok: true,
    anchorMode,
    confirmedBuyTxSignature: lastTxSig,
    confirmedBuyTxSignatures: allTxSigs.length > 0 ? allTxSigs : undefined,
    executedUsdNotional: totalExecutedUsd,
  };
}
