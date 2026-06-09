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
  targetUsdcUsd: number;
  usdcDeltaUsd: number;
};

/** Liquid SOL (after gas reserve) + USDC → rebalance plan toward target USDC %. */
export function planTreasuryRebalance(args: {
  solLamports: bigint;
  usdcMicro: bigint;
  solUsd: number;
  targetUsdcPct: number;
  minFreeSolLamports: bigint;
  minSwapUsd: number;
  /** Rebalance only when |delta| exceeds this fraction of liquid total (0.03 = 3%). */
  bandPct: number;
}): TreasuryRebalancePlan {
  const reserve = args.minFreeSolLamports > 0n ? args.minFreeSolLamports : 0n;
  const tradableSolLamports = args.solLamports > reserve ? args.solLamports - reserve : 0n;
  const solUsd = args.solUsd > 0 ? args.solUsd : 0;
  const solValueUsd = (Number(tradableSolLamports) / 1e9) * solUsd;
  const usdcUsd = Number(args.usdcMicro) / 1e6;
  const liquidTotalUsd = solValueUsd + usdcUsd;
  const targetFrac = Math.min(1, Math.max(0, args.targetUsdcPct / 100));
  const targetUsdcUsd = liquidTotalUsd * targetFrac;
  const usdcDeltaUsd = targetUsdcUsd - usdcUsd;
  const usdcPct = liquidTotalUsd > 0 ? (usdcUsd / liquidTotalUsd) * 100 : 0;

  const bandUsd = Math.max(args.minSwapUsd, liquidTotalUsd * Math.max(0, args.bandPct));
  let action: TreasuryRebalanceAction = 'none';
  let swapUsd = 0;

  if (liquidTotalUsd >= args.minSwapUsd * 2) {
    if (usdcDeltaUsd >= bandUsd) {
      action = 'buy_usdc';
      swapUsd = Math.min(usdcDeltaUsd, solValueUsd * 0.95);
    } else if (-usdcDeltaUsd >= bandUsd) {
      action = 'sell_usdc';
      swapUsd = Math.min(-usdcDeltaUsd, usdcUsd * 0.95);
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
    targetUsdcUsd,
    usdcDeltaUsd,
  };
}

export const FOLLOW_TREASURY_USDC_MINT = QUOTE_MINTS.USDC;
