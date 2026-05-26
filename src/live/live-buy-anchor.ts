/**
 * W8.0-p7.1 — attach chain/simulate anchor metadata to `OpenTrade` after SOL→token fills.
 */
import type { OpenTrade } from '../papertrader/types.js';
import type { LiveBuyPipelineResult } from './phase4-types.js';

export function applyLiveBuyAnchorsAfterOpen(ot: OpenTrade, res: LiveBuyPipelineResult): void {
  if (!res.ok) return;
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
  if (!res.ok) return;
  if (res.anchorMode === 'chain' && res.confirmedBuyTxSignature) {
    ot.liveAnchorMode = 'chain';
    ot.entryLegSignatures = [...(ot.entryLegSignatures ?? []), res.confirmedBuyTxSignature];
    return;
  }
  if (res.anchorMode === 'simulate') {
    ot.liveAnchorMode = 'simulate';
  }
}
