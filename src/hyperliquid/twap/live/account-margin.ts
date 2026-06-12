import type { HlAccountMargin } from '../hyperliquid-meta.js';
import type { HlTwapLiveOpen } from './types.js';

/** Collateral reserved on top of each new open (USD). */
export const HL_TWAP_MARGIN_RESERVE_USD = 50;

/** Sum journal margin = Σ(currentNotional / entryLeverage). */
export function marginUsedFromJournalOpens(opens: Map<string, HlTwapLiveOpen>): number {
  let used = 0;
  for (const pos of opens.values()) {
    const lev = Math.max(1, pos.entryLeverage);
    used += pos.currentNotionalUsd / lev;
  }
  return used;
}

/** Estimated free collateral for a new open (USD). Unified HL: use withdrawable (spot USDC free). */
export function freeMarginUsd(account: HlAccountMargin, _opens?: Map<string, HlTwapLiveOpen>): number {
  if (account.withdrawableUsd > 0) {
    return account.withdrawableUsd;
  }
  if (
    account.spotUsdcTotalUsd != null &&
    account.spotUsdcHoldUsd != null &&
    account.spotUsdcTotalUsd > 0
  ) {
    return Math.max(0, account.spotUsdcTotalUsd - account.spotUsdcHoldUsd);
  }
  return Math.max(0, account.accountValueUsd - account.totalMarginUsedUsd);
}

/** True when account can allocate margin for another TWAP open. */
export function hasMarginForNewOpen(
  account: HlAccountMargin,
  opens: Map<string, HlTwapLiveOpen>,
  newMarginUsd: number,
  reserveUsd = HL_TWAP_MARGIN_RESERVE_USD,
): boolean {
  return freeMarginUsd(account, opens) >= newMarginUsd + reserveUsd;
}
