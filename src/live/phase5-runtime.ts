/**
 * W8.0 Phase 5 — wraps Phase 4 bundle with §3.3–§3.4 gates.
 */
import type {
  LiveBuyPipelineResult,
  LiveOscarRuntimeBundle,
  LiveOscarStrategyDeps,
  LivePhase4BuyOpenContext,
} from './phase4-types.js';
import type { LiveOscarConfig } from './config.js';
import { createLiveOscarPhase4Bundle, estimateLiveWalletMintHoldingGrossUsd } from './phase4-execution.js';
import { resolveLiveBuyOpenIntendedUsd } from './copy-to-oscar-promotion.js';
import { phase5AllowIncreaseExposure } from './phase5-gates.js';

export function createLiveOscarPhase5Bundle(
  liveCfg: LiveOscarConfig,
  deps: LiveOscarStrategyDeps,
  /** Fallback for X when LIVE_ENTRY_NOTIONAL_USD / LIVE_MAX_POSITION_USD unset (paper ticket size). */
  paperPositionUsd: number,
): LiveOscarRuntimeBundle {
  const core = createLiveOscarPhase4Bundle(liveCfg);
  return {
    liveCfg,
    discovery: {
      async tryExecuteBuyOpen(ctx: LivePhase4BuyOpenContext): Promise<LiveBuyPipelineResult> {
        const dec = ctx.tokenDecimals ?? ctx.ot.tokenDecimals ?? 6;
        const walletGrossUsd = await estimateLiveWalletMintHoldingGrossUsd({
          liveCfg,
          mint: ctx.ot.mint,
          tokenDecimals: dec,
          dexSource: ctx.ot.source,
        });
        const { usd: intendedUsd } = resolveLiveBuyOpenIntendedUsd({ ctx, walletGrossUsd });
        const allowed = await phase5AllowIncreaseExposure({
          liveCfg,
          deps,
          paperPositionUsd,
          intendedUsd: intendedUsd > 0 ? intendedUsd : ctx.paperCfg.positionUsd,
          isNewPosition: true,
        });
        if (!allowed) {
          return { ok: false, anchorMode: liveCfg.executionMode === 'simulate' ? 'simulate' : 'chain' };
        }
        return core.discovery.tryExecuteBuyOpen(ctx);
      },
    },
    tracker: {
      trySolToTokenBuy(args) {
        return (async () => {
          const allowed = await phase5AllowIncreaseExposure({
            liveCfg,
            deps,
            paperPositionUsd,
            intendedUsd: args.usdNotional,
            isNewPosition: false,
          });
          if (!allowed) {
            return { ok: false, anchorMode: liveCfg.executionMode === 'simulate' ? 'simulate' : 'chain' };
          }
          return core.tracker.trySolToTokenBuy(args);
        })();
      },
      tryTokenToSolSell(args) {
        return core.tracker.tryTokenToSolSell(args);
      },
    },
  };
}
