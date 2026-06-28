import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveTokenToSolPipelineResult } from './phase4-types.js';

export type ExitSellSlicePlan = {
  usdNotional: number;
  intentKind: 'sell_partial' | 'sell_full';
};

/** Plan USD slices for a live exit when notional exceeds `maxUsdPerSlice`. */
export function planExitSellSlices(args: {
  totalUsdNotional: number;
  maxUsdPerSlice: number;
  intentKind: 'sell_partial' | 'sell_full';
}): ExitSellSlicePlan[] {
  const { totalUsdNotional, maxUsdPerSlice, intentKind } = args;
  if (
    !(totalUsdNotional > 0) ||
    !(maxUsdPerSlice > 0) ||
    totalUsdNotional <= maxUsdPerSlice + 1e-9
  ) {
    return [{ usdNotional: totalUsdNotional, intentKind }];
  }

  const slices: ExitSellSlicePlan[] = [];
  let remaining = totalUsdNotional;
  while (remaining > maxUsdPerSlice + 1e-9) {
    slices.push({ usdNotional: maxUsdPerSlice, intentKind: 'sell_partial' });
    remaining -= maxUsdPerSlice;
  }

  if (remaining > 1e-9) {
    slices.push({
      usdNotional: remaining,
      intentKind: intentKind === 'sell_full' ? 'sell_full' : 'sell_partial',
    });
  } else if (intentKind === 'sell_full' && slices.length > 0) {
    slices[slices.length - 1]!.intentKind = 'sell_full';
  }

  return slices;
}

type TokenToSolPipelineArgs = {
  mint: string;
  symbol: string;
  usdNotional: number;
  priceUsdPerToken: number;
  decimals: number;
  intentKind: 'sell_partial' | 'sell_full';
};

type RunTokenToSolPipeline = (
  liveCfg: LiveOscarConfig,
  args: TokenToSolPipelineArgs,
) => Promise<LiveTokenToSolPipelineResult>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * When planned sell notional exceeds `liveExitSliceMaxUsd`, execute multiple Jupiter sells
 * with `liveExitSliceDelayMs` gap (partial TP, kill stop, full close, etc.).
 */
export async function runSlicedTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: TokenToSolPipelineArgs,
  runOne: RunTokenToSolPipeline,
): Promise<LiveTokenToSolPipelineResult> {
  const maxUsd = liveCfg.liveExitSliceMaxUsd;
  if (!(maxUsd > 0) || !(args.usdNotional > maxUsd + 1e-9)) {
    return runOne(liveCfg, args);
  }

  const plan = planExitSellSlices({
    totalUsdNotional: args.usdNotional,
    maxUsdPerSlice: maxUsd,
    intentKind: args.intentKind,
  });
  if (plan.length <= 1) {
    return runOne(liveCfg, args);
  }

  appendLiveJsonlEvent({
    kind: 'exit_slice_plan',
    mint: args.mint.slice(0, 12),
    intentKind: args.intentKind,
    totalUsdNotional: +args.usdNotional.toFixed(4),
    maxUsdPerSlice: maxUsd,
    sliceCount: plan.length,
    delayMs: liveCfg.liveExitSliceDelayMs,
  });

  let totalLamports = 0n;
  let lastTxSig: string | null | undefined;
  let solProceedsSource: LiveTokenToSolPipelineResult['solProceedsSource'];
  let maxPriceImpact: number | undefined;
  let totalRetryAttempts = 0;
  let lastSellAmountSource: LiveTokenToSolPipelineResult['sellAmountSource'];
  let lastWalletDrained: boolean | undefined;

  for (let i = 0; i < plan.length; i++) {
    if (i > 0 && liveCfg.liveExitSliceDelayMs > 0) {
      await sleep(liveCfg.liveExitSliceDelayMs);
    }
    const slice = plan[i]!;
    appendLiveJsonlEvent({
      kind: 'exit_slice_attempt',
      mint: args.mint.slice(0, 12),
      sliceIndex: i,
      sliceCount: plan.length,
      usdNotional: +slice.usdNotional.toFixed(4),
      intentKind: slice.intentKind,
    });

    const r = await runOne(liveCfg, {
      ...args,
      usdNotional: slice.usdNotional,
      intentKind: slice.intentKind,
    });

    if (!r.ok) {
      appendLiveJsonlEvent({
        kind: 'exit_slice_result',
        mint: args.mint.slice(0, 12),
        sliceIndex: i,
        sliceCount: plan.length,
        ok: false,
        slicesCompleted: i,
      });
      const walletDrainedAfterPartial =
        r.preflightSkipReason === 'wallet_spl_balance_zero' ||
        r.walletDrained === true ||
        lastWalletDrained === true;
      return {
        ok: false,
        preflightSkipReason: r.preflightSkipReason,
        wsolOutLamports: totalLamports > 0n ? totalLamports : undefined,
        solProceedsSource,
        txSignature: lastTxSig,
        priceImpactPct: maxPriceImpact,
        retryAttempts: totalRetryAttempts,
        sellAmountSource: lastSellAmountSource ?? r.sellAmountSource,
        walletDrained: walletDrainedAfterPartial || undefined,
      };
    }

    if (r.wsolOutLamports != null && r.wsolOutLamports > 0n) {
      totalLamports += r.wsolOutLamports;
    }
    lastTxSig = r.txSignature;
    solProceedsSource = r.solProceedsSource ?? solProceedsSource;
    lastSellAmountSource = r.sellAmountSource ?? lastSellAmountSource;
    lastWalletDrained = r.walletDrained ?? lastWalletDrained;
    if (r.priceImpactPct != null && Number.isFinite(r.priceImpactPct)) {
      maxPriceImpact =
        maxPriceImpact == null ? r.priceImpactPct : Math.max(maxPriceImpact, r.priceImpactPct);
    }
    totalRetryAttempts += r.retryAttempts ?? 0;
  }

  appendLiveJsonlEvent({
    kind: 'exit_slice_result',
    mint: args.mint.slice(0, 12),
    sliceCount: plan.length,
    ok: true,
    slicesCompleted: plan.length,
  });

  return {
    ok: true,
    wsolOutLamports: totalLamports > 0n ? totalLamports : undefined,
    solProceedsSource,
    txSignature: lastTxSig,
    priceImpactPct: maxPriceImpact,
    retryAttempts: totalRetryAttempts,
    sellAmountSource: lastSellAmountSource,
    walletDrained: lastWalletDrained,
  };
}
