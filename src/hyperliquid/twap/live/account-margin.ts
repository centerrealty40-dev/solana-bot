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

/** Estimated free collateral for a new open (USD). */
export function freeMarginUsd(account: HlAccountMargin, opens: Map<string, HlTwapLiveOpen>): number {
  const fromJournal = marginUsedFromJournalOpens(opens);
  const used = Math.max(fromJournal, account.totalMarginUsedUsd);
  return Math.max(0, account.accountValueUsd - used);
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
