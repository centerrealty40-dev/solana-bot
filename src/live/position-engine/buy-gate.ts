import type { OpenTrade } from '../../papertrader/types.js';
import { loadPositionEngineConfigFromEnv } from './config.js';
import { canExecuteEntryLeg, onEntryLegConfirmed } from './entry-policy.js';
import type { LiveBuyPipelineResult } from '../phase4-types.js';
import { attachBuyTokensRawFromPipeline } from './ledger-repair.js';

/** True when UPE forbids a new buy leg on this open. */
export function liveEntryBlockedByUpe(ot: OpenTrade, liveExecution = true): boolean {
  if (!liveExecution || !loadPositionEngineConfigFromEnv().enabled) return false;
  return !canExecuteEntryLeg(ot);
}

/** After any confirmed live buy: stamp UPE phase. */
export function notifyLiveBuyLegConfirmed(args: {
  ot: OpenTrade;
  liveExecution?: boolean;
  buyRes?: LiveBuyPipelineResult;
}): void {
  if (!args.liveExecution || !loadPositionEngineConfigFromEnv().enabled) return;
  onEntryLegConfirmed(args.ot);
  attachBuyTokensRawFromPipeline(args.ot, args.buyRes);
}
