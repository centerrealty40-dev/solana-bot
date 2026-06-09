import { QUOTE_MINTS } from '../core/constants.js';

export type TreasuryRebalanceAction = 'none' | 'buy_usdc' | 'sell_usdc';

export type TreasuryRebalancePlan = {
  action: TreasuryRebalanceAction;
  /** USD notional to swap via Jupiter. */
  swapUsd: number;
  solLamports: bigint;
  usdcMicro: bigint;
  tradableSolLamports: bigint;
  liquidTotalUsd: number;
  usdcUsd: number;
  usdcPct: number;
  /** Mid-corridor target when correcting (only set when action !== none). */
  rebalanceTargetPct: number;
  targetUsdcUsd: number;
  usdcDeltaUsd: number;
  usdcMinPct: number;
  usdcMaxPct: number;
};

/**
 * Liquid SOL (after gas reserve) + USDC.
 * Rebalance only **outside** [minPct, maxPct] corridor — no micro-adjust toward exact target.
 */
export function planTreasuryRebalance(args: {
  solLamports: bigint;
  usdcMicro: bigint;
  solUsd: number;
  usdcMinPct: number;
  usdcMaxPct: number;
  /** Where to land after leaving the corridor (typically midpoint). */
  rebalanceTargetPct: number;
  minFreeSolLamports: bigint;
  minSwapUsd: number;
}): TreasuryRebalancePlan {
  const reserve = args.minFreeSolLamports > 0n ? args.minFreeSolLamports : 0n;
  const tradableSolLamports = args.solLamports > reserve ? args.solLamports - reserve : 0n;
  const solUsd = args.solUsd > 0 ? args.solUsd : 0;
  const solValueUsd = (Number(tradableSolLamports) / 1e9) * solUsd;
  const usdcUsd = Number(args.usdcMicro) / 1e6;
  const liquidTotalUsd = solValueUsd + usdcUsd;
  const usdcPct = liquidTotalUsd > 0 ? (usdcUsd / liquidTotalUsd) * 100 : 0;

  const minPct = Math.min(args.usdcMinPct, args.usdcMaxPct);
  const maxPct = Math.max(args.usdcMinPct, args.usdcMaxPct);
  const targetPct = Math.min(maxPct, Math.max(minPct, args.rebalanceTargetPct));
  const targetUsdcUsd = liquidTotalUsd * (targetPct / 100);
  const usdcDeltaUsd = targetUsdcUsd - usdcUsd;

  let action: TreasuryRebalanceAction = 'none';
  let swapUsd = 0;

  if (liquidTotalUsd >= args.minSwapUsd * 2) {
    if (usdcPct < minPct) {
      action = 'buy_usdc';
      swapUsd = Math.min(Math.max(0, targetUsdcUsd - usdcUsd), solValueUsd * 0.95);
    } else if (usdcPct > maxPct) {
      action = 'sell_usdc';
      swapUsd = Math.min(Math.max(0, usdcUsd - targetUsdcUsd), usdcUsd * 0.95);
    }
  }

  if (swapUsd < args.minSwapUsd) {
    action = 'none';
    swapUsd = 0;
  }

  return {
    action,
    swapUsd,
    solLamports: args.solLamports,
    usdcMicro: args.usdcMicro,
    tradableSolLamports,
    liquidTotalUsd,
    usdcUsd,
    usdcPct,
    rebalanceTargetPct: targetPct,
    targetUsdcUsd,
    usdcDeltaUsd,
    usdcMinPct: minPct,
    usdcMaxPct: maxPct,
  };
}

export const FOLLOW_TREASURY_USDC_MINT = QUOTE_MINTS.USDC;
