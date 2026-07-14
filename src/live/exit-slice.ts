import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type {
  LiveExitSliceSuccessHook,
  LiveTokenToSolPipelineResult,
} from './phase4-types.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import {
  oscarChainUsdFromRaw,
  planExitSliceUsdNotional,
  shouldBypassExitSlicing,
} from './wallet-balance-exit-reconcile.js';

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
  referencePriceUsd?: number | null;
  decimals: number;
  intentKind: 'sell_partial' | 'sell_full';
  emergencyExit?: boolean;
};

type RunTokenToSolPipeline = (
  liveCfg: LiveOscarConfig,
  args: TokenToSolPipelineArgs,
) => Promise<LiveTokenToSolPipelineResult>;

export type RunSlicedTokenToSolPipelineOpts = {
  onSliceSuccess?: LiveExitSliceSuccessHook;
  /** Test hook — skip RPC chain read. */
  getChainOscarUsd?: () => Promise<number | null>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function resolveChainOscarUsdForExitSlice(
  liveCfg: LiveOscarConfig,
  args: Pick<TokenToSolPipelineArgs, 'mint' | 'decimals' | 'priceUsdPerToken'>,
): Promise<number | null> {
  const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
  if (!chainMap) return null;
  const raw = chainMap.get(args.mint) ?? 0n;
  if (raw === 0n) return 0;
  const { oscarUsd } = oscarChainUsdFromRaw({
    raw,
    decimals: args.decimals,
    priceUsd: args.priceUsdPerToken,
    mint: args.mint,
  });
  return oscarUsd;
}

function aggregateSliceSuccess(
  state: {
    totalLamports: bigint;
    totalTokenRawSold: bigint;
    lastTxSig: string | null | undefined;
    solProceedsSource: LiveTokenToSolPipelineResult['solProceedsSource'];
    maxPriceImpact: number | undefined;
    totalRetryAttempts: number;
    lastSellAmountSource: LiveTokenToSolPipelineResult['sellAmountSource'];
    lastWalletDrained: boolean | undefined;
  },
  r: LiveTokenToSolPipelineResult,
): void {
  if (r.wsolOutLamports != null && r.wsolOutLamports > 0n) {
    state.totalLamports += r.wsolOutLamports;
  }
  if (typeof r.tokenAmountRawSold === 'string' && /^\d+$/.test(r.tokenAmountRawSold)) {
    state.totalTokenRawSold += BigInt(r.tokenAmountRawSold);
  }
  state.lastTxSig = r.txSignature;
  state.solProceedsSource = r.solProceedsSource ?? state.solProceedsSource;
  state.lastSellAmountSource = r.sellAmountSource ?? state.lastSellAmountSource;
  state.lastWalletDrained = r.walletDrained ?? state.lastWalletDrained;
  if (r.priceImpactPct != null && Number.isFinite(r.priceImpactPct)) {
    state.maxPriceImpact =
      state.maxPriceImpact == null
        ? r.priceImpactPct
        : Math.max(state.maxPriceImpact, r.priceImpactPct);
  }
  state.totalRetryAttempts += r.retryAttempts ?? 0;
}

function buildAggregatedResult(
  state: {
    totalLamports: bigint;
    totalTokenRawSold: bigint;
    lastTxSig: string | null | undefined;
    solProceedsSource: LiveTokenToSolPipelineResult['solProceedsSource'];
    maxPriceImpact: number | undefined;
    totalRetryAttempts: number;
    lastSellAmountSource: LiveTokenToSolPipelineResult['sellAmountSource'];
    lastWalletDrained: boolean | undefined;
  },
  ok: boolean,
  extra?: Partial<LiveTokenToSolPipelineResult>,
): LiveTokenToSolPipelineResult {
  return {
    ok,
    wsolOutLamports: state.totalLamports > 0n ? state.totalLamports : undefined,
    solProceedsSource: state.solProceedsSource,
    txSignature: state.lastTxSig,
    priceImpactPct: state.maxPriceImpact,
    retryAttempts: state.totalRetryAttempts,
    sellAmountSource: state.lastSellAmountSource,
    walletDrained: state.lastWalletDrained,
    tokenAmountRawSold:
      state.totalTokenRawSold > 0n ? state.totalTokenRawSold.toString() : undefined,
    ...extra,
  };
}

/**
 * When planned sell notional exceeds `liveExitSliceMaxUsd`, execute multiple Jupiter sells
 * with `liveExitSliceDelayMs` gap (partial TP, kill stop, full close, etc.).
 *
 * Replans each slice from min(journal, chain) so stale journal notional cannot oversize slices.
 */
export async function runSlicedTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: TokenToSolPipelineArgs,
  runOne: RunTokenToSolPipeline,
  opts?: RunSlicedTokenToSolPipelineOpts,
): Promise<LiveTokenToSolPipelineResult> {
  const maxUsd = liveCfg.liveExitSliceMaxUsd;
  if (!(maxUsd > 0) || args.emergencyExit) {
    return runOne(liveCfg, {
      ...args,
      intentKind: args.emergencyExit ? 'sell_full' : args.intentKind,
    });
  }

  const fetchChain =
    opts?.getChainOscarUsd ??
    (() =>
      resolveChainOscarUsdForExitSlice(liveCfg, {
        mint: args.mint,
        decimals: args.decimals,
        priceUsdPerToken: args.priceUsdPerToken,
      }));

  const chainUsd0 = await fetchChain();
  const effective0 = planExitSliceUsdNotional({
    journalUsd: args.usdNotional,
    chainOscarUsd: chainUsd0 ?? args.usdNotional,
  });

  if (!(effective0 > 1e-9)) {
    return { ok: false, preflightSkipReason: 'wallet_spl_balance_zero' };
  }

  if (shouldBypassExitSlicing({ effectiveUsd: effective0, liveCfg })) {
    return runOne(liveCfg, {
      ...args,
      usdNotional: effective0,
      intentKind: 'sell_full',
    });
  }

  appendLiveJsonlEvent({
    kind: 'exit_slice_plan',
    mint: args.mint.slice(0, 12),
    intentKind: args.intentKind,
    totalUsdNotional: +effective0.toFixed(4),
    maxUsdPerSlice: maxUsd,
    delayMs: liveCfg.liveExitSliceDelayMs,
  });

  const state = {
    totalLamports: 0n,
    totalTokenRawSold: 0n,
    lastTxSig: undefined as string | null | undefined,
    solProceedsSource: undefined as LiveTokenToSolPipelineResult['solProceedsSource'],
    maxPriceImpact: undefined as number | undefined,
    totalRetryAttempts: 0,
    lastSellAmountSource: undefined as LiveTokenToSolPipelineResult['sellAmountSource'],
    lastWalletDrained: undefined as boolean | undefined,
  };

  let sliceIndex = 0;
  const maxSlices = Math.max(1, Math.ceil(args.usdNotional / Math.max(maxUsd, 1e-9)) + 2);

  while (sliceIndex < maxSlices) {
    if (sliceIndex > 0 && liveCfg.liveExitSliceDelayMs > 0) {
      await sleep(liveCfg.liveExitSliceDelayMs);
    }

    const chainUsd = await fetchChain();
    const effectiveUsd = planExitSliceUsdNotional({
      journalUsd: args.usdNotional,
      chainOscarUsd: chainUsd ?? 0,
    });

    if (!(effectiveUsd > 1e-9)) {
      if (state.totalLamports > 0n || sliceIndex > 0) {
        appendLiveJsonlEvent({
          kind: 'exit_slice_result',
          mint: args.mint.slice(0, 12),
          sliceCount: sliceIndex,
          ok: true,
          slicesCompleted: sliceIndex,
        });
        return buildAggregatedResult(state, true, { walletDrained: true });
      }
      return { ok: false, preflightSkipReason: 'wallet_spl_balance_zero' };
    }

    const useSingleFull =
      shouldBypassExitSlicing({ effectiveUsd, liveCfg }) || effectiveUsd <= maxUsd + 1e-9;
    const sliceUsd = useSingleFull ? effectiveUsd : Math.min(maxUsd, effectiveUsd);
    const sliceIntent: 'sell_partial' | 'sell_full' = useSingleFull ? 'sell_full' : 'sell_partial';

    appendLiveJsonlEvent({
      kind: 'exit_slice_attempt',
      mint: args.mint.slice(0, 12),
      sliceIndex,
      usdNotional: +sliceUsd.toFixed(4),
      intentKind: sliceIntent,
    });

    const r = await runOne(liveCfg, {
      ...args,
      usdNotional: sliceUsd,
      intentKind: sliceIntent,
    });

    if (!r.ok) {
      appendLiveJsonlEvent({
        kind: 'exit_slice_result',
        mint: args.mint.slice(0, 12),
        sliceIndex,
        sliceCount: sliceIndex + 1,
        ok: false,
        slicesCompleted: sliceIndex,
      });
      const walletDrainedAfterPartial =
        r.preflightSkipReason === 'wallet_spl_balance_zero' ||
        r.walletDrained === true ||
        state.lastWalletDrained === true;
      if (state.totalLamports > 0n || sliceIndex > 0) {
        return buildAggregatedResult(state, false, {
          preflightSkipReason: r.preflightSkipReason,
          walletDrained: walletDrainedAfterPartial || undefined,
          terminalKind: r.terminalKind,
          terminalMessage: r.terminalMessage,
        });
      }
      return {
        ok: false,
        preflightSkipReason: r.preflightSkipReason,
        wsolOutLamports: r.wsolOutLamports,
        solProceedsSource: r.solProceedsSource,
        txSignature: r.txSignature,
        priceImpactPct: r.priceImpactPct,
        retryAttempts: r.retryAttempts,
        sellAmountSource: r.sellAmountSource,
        walletDrained: r.walletDrained,
        tokenAmountRawSold: r.tokenAmountRawSold,
        terminalKind: r.terminalKind,
        terminalMessage: r.terminalMessage,
      };
    }

    aggregateSliceSuccess(state, r);
    sliceIndex += 1;

    if (
      opts?.onSliceSuccess &&
      r.wsolOutLamports != null &&
      r.wsolOutLamports > 0n &&
      sliceIntent === 'sell_partial'
    ) {
      await opts.onSliceSuccess({
        sliceIndex: sliceIndex - 1,
        usdNotional: sliceUsd,
        wsolOutLamports: r.wsolOutLamports,
        tokenAmountRawSold: r.tokenAmountRawSold,
        txSignature: r.txSignature,
        sellAmountSource: r.sellAmountSource,
        walletDrained: r.walletDrained,
        priceImpactPct: r.priceImpactPct,
      });
    }

    const sliceComplete =
      sliceIntent === 'sell_full' ||
      r.walletDrained === true ||
      r.sellAmountSource === 'chain_full_balance';

    if (sliceComplete) {
      appendLiveJsonlEvent({
        kind: 'exit_slice_result',
        mint: args.mint.slice(0, 12),
        sliceCount: sliceIndex,
        ok: true,
        slicesCompleted: sliceIndex,
      });
      return buildAggregatedResult(state, true);
    }
  }

  appendLiveJsonlEvent({
    kind: 'exit_slice_result',
    mint: args.mint.slice(0, 12),
    sliceCount: sliceIndex,
    ok: false,
    slicesCompleted: sliceIndex,
  });
  if (state.totalLamports > 0n || sliceIndex > 0) {
    return buildAggregatedResult(state, false, {
      preflightSkipReason: 'exit_slice_max_iterations',
    });
  }
  return { ok: false, preflightSkipReason: 'exit_slice_max_iterations' };
}
