/**
 * Pending-buy queue hygiene: fresh entries first; structural eval fails die instead
 * of monopolising the buy loop for the whole retry window.
 */

import type { PendingBuy } from './state.js';

/** Newest leader signal first so a hot chase is not stuck behind hour-old junk. */
export function sortPendingBuysNewestFirst(pending: PendingBuy[]): PendingBuy[] {
  return [...pending].sort((a, b) => {
    const ta = a.leaderBuyTs || a.dueTs || 0;
    const tb = b.leaderBuyTs || b.dueTs || 0;
    if (tb !== ta) return tb - ta;
    return (b.dueTs || 0) - (a.dueTs || 0);
  });
}

/**
 * Failures that will not self-heal by waiting (unlike premium / RPC blips).
 * Keep retrying these only burns Jupiter/RPC and blocks fresh entries.
 */
export function isTerminalCopyBuyEvalFailure(reasons: string[]): boolean {
  for (const r of reasons) {
    if (r.startsWith('mcap_missing')) return true;
    if (r.startsWith('mcap=') && (r.includes('<min=') || r.includes('>max='))) return true;
    if (r.startsWith('liq_missing')) return true;
    if (r.startsWith('liq=') && r.includes('<min=')) return true;
  }
  return false;
}

/** Drop queued rows whose stored entry mcap already cannot clear the floor. */
export function isPendingBuyDoomedByMcap(
  pending: Pick<PendingBuy, 'entryMcapUsd'>,
  minMarketCapUsd: number,
): boolean {
  if (!(minMarketCapUsd > 0)) return false;
  const m = pending.entryMcapUsd;
  if (m == null || !(m > 0)) return false;
  return m < minMarketCapUsd;
}
