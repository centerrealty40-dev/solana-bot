import type { OpenTrade, PartialSell } from '../../papertrader/types.js';
import type { LiveBuyPipelineResult, LiveTokenToSolSellResult } from '../phase4-types.js';

/**
 * UPE-I4: ensure partial sell row carries chain tx signature + proceeds after live slice.
 * Idempotent — skips if last partial already has this signature.
 */
export function repairPartialSellFromLiveResult(args: {
  ot: OpenTrade;
  sellOut: LiveTokenToSolSellResult;
  partialReason: PartialSell['reason'];
  proceedsUsd: number;
  marketPrice: number;
  effectivePrice: number;
}): void {
  const sig = args.sellOut.txSignature;
  if (typeof sig !== 'string' || sig.length < 16) return;

  const last = args.ot.partialSells[args.ot.partialSells.length - 1];
  if (last?.exitTxSignature === sig) return;

  if (last && !last.exitTxSignature) {
    last.exitTxSignature = sig;
    if (args.sellOut.solProceedsLamports != null && args.sellOut.solProceedsLamports > 0n) {
      last.solProceedsLamports = args.sellOut.solProceedsLamports.toString();
      last.proceedsUsdSource = 'chain_sol';
    }
    return;
  }

  const rawSold = args.sellOut.tokenAmountRawSold;
  args.ot.partialSells.push({
    ts: Date.now(),
    price: args.effectivePrice,
    marketPrice: args.marketPrice,
    sellFraction: 0,
    reason: args.partialReason,
    proceedsUsd: args.proceedsUsd,
    grossProceedsUsd: args.proceedsUsd,
    pnlUsd: 0,
    grossPnlUsd: 0,
    exitTxSignature: sig,
    ...(args.sellOut.solProceedsLamports != null && args.sellOut.solProceedsLamports > 0n
      ? {
          solProceedsLamports: args.sellOut.solProceedsLamports.toString(),
          proceedsUsdSource: 'chain_sol' as const,
        }
      : {}),
    ...(typeof rawSold === 'string' && /^\d+$/.test(rawSold)
      ? { walletDrainedFlush: false }
      : {}),
  });
}

/** Attach token raw amounts from buy pipeline to parallel array (ledger SSOT). */
export function attachBuyTokensRawFromPipeline(
  ot: OpenTrade,
  buyRes: LiveBuyPipelineResult | { tokenAmountRawReceived?: string } | undefined,
): void {
  const raw = (buyRes as { tokenAmountRawReceived?: string } | undefined)?.tokenAmountRawReceived;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || raw === '0') return;
  ot.liveUpeLegTokensRaw = [...(ot.liveUpeLegTokensRaw ?? []), raw];
}
