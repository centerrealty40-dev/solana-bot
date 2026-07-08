/**
 * W8.0-p7.1 — attach chain/simulate anchor metadata to `OpenTrade` after SOL→token fills.
 */
import type { OpenTrade, PositionLeg } from '../papertrader/types.js';
import type { LiveBuyPipelineResult } from './phase4-types.js';

function reconcileLegExecutedUsd(ot: OpenTrade, leg: PositionLeg, executedUsd: number): void {
  if (!(executedUsd > 0) || leg.sizeUsd === executedUsd) return;
  const prev = leg.sizeUsd;
  leg.sizeUsd = executedUsd;
  ot.totalInvestedUsd = ot.totalInvestedUsd - prev + executedUsd;
  if (ot.totalInvestedUsd > 0) {
    const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
    ot.avgEntry = num / ot.totalInvestedUsd;
    const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
    ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  }
}

/** Adjust open or add leg USD after partial wallet slice (1.11.506). */
export function reconcileOpenTradeLegExecutedUsd(
  ot: OpenTrade,
  executedUsd: number,
  reason: PositionLeg['reason'],
): void {
  const leg = [...ot.legs].reverse().find((l) => l.reason === reason) ?? ot.legs[ot.legs.length - 1];
  if (!leg) return;
  reconcileLegExecutedUsd(ot, leg, executedUsd);
  const st = ot.liveStagedEntry;
  if (st && reason === 'open') {
    st.firstLegUsd = executedUsd;
    if (st.entrySplitLegUsd != null) st.entrySplitLegUsd = executedUsd;
  }
}

export function executedBuyUsd(plannedUsd: number, res: LiveBuyPipelineResult): number {
  return res.executedUsdNotional ?? plannedUsd;
}

export function applyLiveBuyAnchorsAfterOpen(ot: OpenTrade, res: LiveBuyPipelineResult): void {
  if (!res.ok) return;
  if (res.executedUsdNotional != null) {
    reconcileOpenTradeLegExecutedUsd(ot, res.executedUsdNotional, 'open');
  }
  if (res.anchorMode === 'chain' && res.confirmedBuyTxSignature) {
    ot.liveAnchorMode = 'chain';
    ot.entryLegSignatures = [res.confirmedBuyTxSignature];
    return;
  }
  if (res.anchorMode === 'simulate') {
    ot.liveAnchorMode = 'simulate';
    ot.entryLegSignatures = [];
  }
}

export function appendLiveBuyAnchorsAfterDca(ot: OpenTrade, res: LiveBuyPipelineResult): void {
  /**
   * Record confirmed on-chain buys even on a non-ok partial result: any slice that landed
   * on-chain is a real fill and must be attached to the position (no orphaned buys).
   */
  const hasChainFill =
    res.anchorMode === 'chain' &&
    ((res.confirmedBuyTxSignatures?.length ?? 0) > 0 || !!res.confirmedBuyTxSignature);
  if (!res.ok && !hasChainFill) return;
  if (res.executedUsdNotional != null) {
    const last = ot.legs[ot.legs.length - 1];
    if (last) reconcileLegExecutedUsd(ot, last, res.executedUsdNotional);
  }
  if (res.anchorMode === 'chain') {
    const sigs =
      res.confirmedBuyTxSignatures ??
      (res.confirmedBuyTxSignature ? [res.confirmedBuyTxSignature] : []);
    if (sigs.length > 0) {
      ot.liveAnchorMode = 'chain';
      ot.entryLegSignatures = [...(ot.entryLegSignatures ?? []), ...sigs];
      return;
    }
  }
  if (res.anchorMode === 'simulate') {
    ot.liveAnchorMode = 'simulate';
  }
}
