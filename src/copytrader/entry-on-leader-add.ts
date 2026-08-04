import type { CopyTraderConfig } from './config.js';
import { roundUsd } from './entry-probe.js';
import { absRawAmount } from './proportional.js';
import { walletNotionalUsdFromRaw } from './position-reconcile.js';

/** Skip the leader's first buy; enter only when he averages into an open bag. */
export function usesEnterOnlyOnLeaderAdd(
  cfg: Pick<CopyTraderConfig, 'enterOnlyOnLeaderAdd'>,
): boolean {
  return cfg.enterOnlyOnLeaderAdd === true;
}

/** Leader first buy while we are flat — watch only. */
export function shouldIgnoreLeaderFirstBuyForAddEntry(
  cfg: Pick<CopyTraderConfig, 'enterOnlyOnLeaderAdd'>,
  preLeaderRaw: bigint,
): boolean {
  return usesEnterOnlyOnLeaderAdd(cfg) && preLeaderRaw <= 0n;
}

/**
 * After we already entered on a leader add, do not chase further adds —
 * sizing was already X% of his full bag at entry.
 */
export function shouldIgnoreFurtherAddsAfterBagEntry(
  cfg: Pick<CopyTraderConfig, 'enterOnlyOnLeaderAdd'>,
): boolean {
  return usesEnterOnlyOnLeaderAdd(cfg);
}

/** Leader total position USD after this buy (pre + buy raw × mark). */
export function leaderTotalBagUsdAfterBuy(args: {
  preLeaderRaw: bigint;
  buyRaw: bigint;
  priceUsd: number;
}): number {
  const totalRaw = args.preLeaderRaw + absRawAmount(args.buyRaw);
  return walletNotionalUsdFromRaw(totalRaw, args.priceUsd);
}

/** Our single-shot entry = ratio × leader total bag after his add. */
export function enterOnLeaderAddSizeUsd(
  cfg: Pick<CopyTraderConfig, 'enterOnlyOnLeaderAdd' | 'enterOnLeaderAddBagRatio' | 'minLeaderBuyUsd'>,
  args: { preLeaderRaw: bigint; buyRaw: bigint; priceUsd: number },
): number {
  if (!usesEnterOnlyOnLeaderAdd(cfg)) return 0;
  const ratio = cfg.enterOnLeaderAddBagRatio;
  if (!(ratio > 0) || !(args.priceUsd > 0)) return 0;
  const bagUsd = leaderTotalBagUsdAfterBuy(args);
  if (!(bagUsd > 0)) return 0;
  return roundUsd(bagUsd * ratio);
}
