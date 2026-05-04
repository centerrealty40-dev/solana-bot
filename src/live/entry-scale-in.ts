/**
 * Live Oscar — вторая нога входа: после задержки докупка остатка notional, если Jupiter-цена в коридоре к якорю первой ноги.
 */
import { getLiveMcUsd, getSolUsd } from '../papertrader/pricing.js';
import { quoteResilienceFromPaperCfg, type PaperTraderConfig } from '../papertrader/config.js';
import { jupiterQuoteBuyPriceUsd } from '../papertrader/pricing/price-verify.js';
import { applyEntryCosts } from '../papertrader/costs.js';
import type { OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';
import type { LiveOscarPhase4Tracker } from './phase4-types.js';
import { appendLiveBuyAnchorsAfterDca } from './live-buy-anchor.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { getPriorityFeeUsd } from '../papertrader/pricing/priority-fee.js';
import { serializeOpenTrade } from './strategy-snapshot.js';

function parsePending(raw: unknown): NonNullable<OpenTrade['livePendingScaleIn']> | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const anchorMarketUsd = Number(o.anchorMarketUsd);
  const secondLegUsd = Number(o.secondLegUsd);
  const executeAfterTs = Number(o.executeAfterTs);
  const corridorPct = Number(o.corridorPct);
  const maxSwapAttempts = Number(o.maxSwapAttempts);
  const swapAttempts = Number(o.swapAttempts ?? 0);
  const nextAttemptAfterTs = Number(o.nextAttemptAfterTs ?? 0);
  if (
    !(anchorMarketUsd > 0) ||
    !(secondLegUsd > 0) ||
    !Number.isFinite(executeAfterTs) ||
    !(corridorPct > 0) ||
    !Number.isFinite(maxSwapAttempts) ||
    maxSwapAttempts < 1
  ) {
    return null;
  }
  return {
    anchorMarketUsd,
    secondLegUsd,
    executeAfterTs,
    corridorPct,
    maxSwapAttempts: Math.floor(maxSwapAttempts),
    swapAttempts: Number.isFinite(swapAttempts) ? Math.max(0, Math.floor(swapAttempts)) : 0,
    nextAttemptAfterTs: Number.isFinite(nextAttemptAfterTs) ? Math.max(0, nextAttemptAfterTs) : 0,
  };
}

export async function tryLiveEntryScaleInTrackerStep(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  mint: string;
  curMetric: number;
  livePhase4: LiveOscarPhase4Tracker;
  liveOscarCfg: LiveOscarConfig;
  journalAppend: (event: Record<string, unknown>) => void;
  journalLiveStrategy?: (event: Record<string, unknown>) => void;
}): Promise<void> {
  const { cfg, ot, mint, curMetric, livePhase4, liveOscarCfg, journalAppend, journalLiveStrategy } =
    args;

  const pending = parsePending(ot.livePendingScaleIn as unknown);
  if (!pending) return;
  ot.livePendingScaleIn = pending;

  if (!liveOscarCfg.liveEntryScaleInEnabled || liveOscarCfg.executionMode !== 'live') return;

  const now = Date.now();
  if (now < pending.executeAfterTs) return;
  if (pending.nextAttemptAfterTs > now) return;

  const dec = ot.tokenDecimals ?? 6;
  const solUsd = getSolUsd() ?? 0;

  const quote = await jupiterQuoteBuyPriceUsd({
    mint,
    outMintDecimals: dec,
    sizeUsd: pending.secondLegUsd,
    solUsd,
    snapshotPriceUsd: pending.anchorMarketUsd,
    slippageBps: cfg.priceVerifyMaxSlipBps,
    timeoutMs: cfg.priceVerifyTimeoutMs,
    resilience: quoteResilienceFromPaperCfg(cfg),
  });

  const finishCancel = (reason: string, detail: Record<string, unknown>) => {
    ot.livePendingScaleIn = null;
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason,
      detail: { mint, ...detail },
    });
  };

  if (quote.kind !== 'ok' || !(quote.jupiterPriceUsd > 0)) {
    pending.swapAttempts += 1;
    if (pending.swapAttempts >= pending.maxSwapAttempts) {
      finishCancel('live_scale_in_quote_giveup', {
        attempts: pending.swapAttempts,
        quoteKind: quote.kind,
      });
    } else {
      pending.nextAttemptAfterTs = now + liveOscarCfg.liveEntryScaleInRetryBackoffMs;
      ot.livePendingScaleIn = pending;
    }
    return;
  }

  const implied = quote.jupiterPriceUsd;
  const diffPct = Math.abs(implied / pending.anchorMarketUsd - 1) * 100;
  if (diffPct > pending.corridorPct + 1e-6) {
    finishCancel('live_scale_in_corridor_exit', {
      anchorMarketUsd: pending.anchorMarketUsd,
      jupiterPriceUsd: implied,
      diffPct: +diffPct.toFixed(4),
      corridorPct: pending.corridorPct,
    });
    return;
  }

  const buyRes = await livePhase4.trySolToTokenBuy({
    mint,
    symbol: ot.symbol,
    usdNotional: pending.secondLegUsd,
    intentKind: 'buy_scale_in',
  });

  if (!buyRes.ok) {
    pending.swapAttempts += 1;
    if (pending.swapAttempts >= pending.maxSwapAttempts) {
      finishCancel('live_scale_in_swap_giveup', {
        attempts: pending.swapAttempts,
        inCorridor: true,
        diffPct: +diffPct.toFixed(4),
      });
    } else {
      pending.nextAttemptAfterTs = now + liveOscarCfg.liveEntryScaleInRetryBackoffMs;
      ot.livePendingScaleIn = pending;
    }
    return;
  }

  const marketBuy = curMetric > 0 ? curMetric : implied;
  const addUsd = pending.secondLegUsd;
  const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);

  ot.legs.push({
    ts: Date.now(),
    price: effectiveBuy,
    marketPrice: marketBuy,
    sizeUsd: addUsd,
    reason: 'scale_in',
  });
  ot.totalInvestedUsd += addUsd;
  const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  ot.avgEntry = num / ot.totalInvestedUsd;
  const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  ot.remainingFraction = 1;
  appendLiveBuyAnchorsAfterDca(ot, buyRes);

  ot.livePendingScaleIn = null;

  const mcUsdLive = await getLiveMcUsd(
    mint,
    ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
  );
  const pf = getPriorityFeeUsd(cfg, solUsd);

  journalAppend({
    kind: 'scale_in_add',
    mint,
    ts: Date.now(),
    price: effectiveBuy,
    marketPrice: marketBuy,
    sizeUsd: addUsd,
    secondLegFractionOfFull: +(addUsd / cfg.positionUsd).toFixed(6),
    fullPositionUsd: cfg.positionUsd,
    avgEntry: ot.avgEntry,
    avgEntryMarket: ot.avgEntryMarket,
    totalInvestedUsd: ot.totalInvestedUsd,
    legCount: ot.legs.length,
    mcUsdLive,
    priorityFee: pf,
    jupiterCorridorDiffPct: +diffPct.toFixed(4),
    timelineLabelRu: `Докупка ${Math.round((addUsd / cfg.positionUsd) * 100)}% позиции`,
  });

  journalLiveStrategy?.({
    kind: 'live_position_scale_in',
    mint,
    openTrade: serializeOpenTrade(ot),
  });
}
