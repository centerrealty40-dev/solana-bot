/**
 * Live Oscar — вторая нога сплита: после задержки докупка остатка notional, если Jupiter implied
 * в коридоре к якорю первой ноги. Вне коридора — пауза `liveEntryScaleInOutOfCorridorPollMs` и повторная проверка.
 * Частичный TP или DCA снимают план второй ноги (`tracker.ts` / `partialSells` / очистка pending при DCA).
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
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';
import { isRunnerLiteTrade } from '../papertrader/live-oscar-runner-lite.js';

function parsePending(raw: unknown): NonNullable<OpenTrade['livePendingScaleIn']> | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const anchorMarketUsd = Number(o.anchorMarketUsd);
  const secondLegUsd = Number(o.secondLegUsd);
  const executeAfterTs = Number(o.executeAfterTs);
  const legacySym = Number(o.corridorPct);
  const upRaw = Number(o.corridorUpPct);
  const downRaw = Number(o.corridorDownPct);
  let corridorUpPct: number;
  let corridorDownPct: number;
  if (Number.isFinite(upRaw) && upRaw > 0 && Number.isFinite(downRaw) && downRaw > 0) {
    corridorUpPct = upRaw;
    corridorDownPct = downRaw;
  } else if (Number.isFinite(legacySym) && legacySym > 0) {
    corridorUpPct = legacySym;
    corridorDownPct = legacySym;
  } else {
    return null;
  }
  const maxSwapAttempts = Number(o.maxSwapAttempts);
  const swapAttempts = Number(o.swapAttempts ?? 0);
  const nextAttemptAfterTs = Number(o.nextAttemptAfterTs ?? 0);
  if (
    !(anchorMarketUsd > 0) ||
    !(secondLegUsd > 0) ||
    !Number.isFinite(executeAfterTs) ||
    !Number.isFinite(maxSwapAttempts) ||
    maxSwapAttempts < 1
  ) {
    return null;
  }
  return {
    anchorMarketUsd,
    secondLegUsd,
    executeAfterTs,
    corridorUpPct,
    corridorDownPct,
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
  /** Live: discovery Phase 5 may rotate capital and drop the open leg — abort stale scale-in. */
  verifyStillOpen?: () => boolean;
}): Promise<void> {
  const {
    cfg,
    ot,
    mint,
    curMetric,
    livePhase4,
    liveOscarCfg,
    journalAppend,
    journalLiveStrategy,
    verifyStillOpen,
  } = args;

  const pending = parsePending(ot.livePendingScaleIn as unknown);
  if (!pending) return;
  ot.livePendingScaleIn = pending;

  const runnerLiteScaleIn = isRunnerLiteTrade(ot);
  if (liveOscarCfg.executionMode !== 'live') {
    ot.livePendingScaleIn = null;
    return;
  }
  if (!liveOscarCfg.liveEntryScaleInEnabled && !runnerLiteScaleIn) {
    ot.livePendingScaleIn = null;
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason: 'live_scale_in_disabled_clear_pending',
      detail: {
        mint,
        timelineKind: 'scale_in_skip',
        timelineLabelRu:
          'Плановый scale-in выключен в конфиге: ожидание второй ноги по коридору снято (вторая нога — через DCA по стратегии).',
      },
    });
    return;
  }

  if (ot.partialSells.length > 0) {
    ot.livePendingScaleIn = null;
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason: 'live_scale_in_skip_partial_tp_fired',
      detail: {
        mint,
        partialSellCount: ot.partialSells.length,
        timelineKind: 'scale_in_skip',
        timelineLabelRu:
          'Докупка второй ноги отменена: уже сработала частичная фиксация по сетке TP — план второй ноги снят.',
      },
    });
    return;
  }

  if (ot.legs.some((l) => l.reason === 'dca')) {
    ot.livePendingScaleIn = null;
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason: 'live_scale_in_skip_after_dca',
      detail: {
        mint,
        timelineKind: 'scale_in_skip',
        timelineLabelRu:
          'Докупка второй ноги отменена: уже было усреднение (DCA) — вторая нога сплита не нужна.',
      },
    });
    return;
  }

  const now = Date.now();
  if (now < pending.executeAfterTs) return;
  if (pending.nextAttemptAfterTs > now) return;

  const dec = ot.tokenDecimals ?? 6;
  const solUsd = getSolUsd() ?? 0;

  const backoffMs = liveOscarCfg.liveEntryScaleInRetryBackoffMs;
  const pollMs = liveOscarCfg.liveEntryScaleInOutOfCorridorPollMs;

  const scheduleBackoffRetry = () => {
    pending.nextAttemptAfterTs = Date.now() + backoffMs;
    ot.livePendingScaleIn = pending;
  };

  const scheduleCorridorPoll = () => {
    pending.nextAttemptAfterTs = Date.now() + pollMs;
    ot.livePendingScaleIn = pending;
  };

  const finishCancel = (reason: string, detail: Record<string, unknown>) => {
    ot.livePendingScaleIn = null;
    const tlRaw = detail.timelineLabelRu;
    const tl =
      typeof tlRaw === 'string' && tlRaw.trim().length ? String(tlRaw).trim() : undefined;
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason,
      detail: {
        mint,
        ...detail,
        ...(tl ? { timelineKind: 'scale_in_skip', timelineLabelRu: tl } : {}),
      },
    });
  };

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

  let implied = 0;
  let haveImpliedQuote = false;
  let signedDevPct = 0;
  let diffPctAbs = 0;

  if (quote.kind !== 'ok' || !(quote.jupiterPriceUsd > 0)) {
    pending.swapAttempts += 1;
    if (pending.swapAttempts < pending.maxSwapAttempts) {
      scheduleBackoffRetry();
      return;
    }
    finishCancel('live_scale_in_quote_giveup', {
      attempts: pending.swapAttempts,
      quoteKind: quote.kind,
      timelineLabelRu: `План второй ноги снят: нет пригодной котировки Jupiter после ${pending.swapAttempts} попыток.`,
    });
    return;
  }

  implied = quote.jupiterPriceUsd;
  haveImpliedQuote = true;
  signedDevPct = (implied / pending.anchorMarketUsd - 1) * 100;
  diffPctAbs = Math.abs(signedDevPct);
  const eps = 1e-6;
  const outCorridor =
    signedDevPct > pending.corridorUpPct + eps || signedDevPct < -pending.corridorDownPct - eps;
  if (outCorridor) {
    scheduleCorridorPoll();
    return;
  }

  pending.swapAttempts = 0;

  if (verifyStillOpen && !verifyStillOpen()) return;

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
        signedDevPct: +signedDevPct.toFixed(4),
        diffPct: +diffPctAbs.toFixed(4),
        corridorUpPct: pending.corridorUpPct,
        corridorDownPct: pending.corridorDownPct,
        timelineLabelRu: `План второй ноги снят: своп не прошёл после ${pending.swapAttempts} попыток (цена была в коридоре).`,
      });
    } else {
      scheduleBackoffRetry();
    }
    return;
  }

  const marketBuy = curMetric > 0 ? curMetric : haveImpliedQuote ? implied : pending.anchorMarketUsd;
  const addUsd = pending.secondLegUsd;
  const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);

  ot.legs.push({
    ts: Date.now(),
    price: effectiveBuy,
    marketPrice: marketBuy,
    sizeUsd: addUsd,
    reason: 'scale_in',
  });
  if (isLiveOscarTradingStrategyId(cfg.strategyId)) ot.liveKillstopBelowStreak = 0;
  ot.totalInvestedUsd += addUsd;
  const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  ot.avgEntry = num / ot.totalInvestedUsd;
  const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  ot.remainingFraction = 1;
  /** Сплит входа (не DCA): режим A при первом TP +5%; B при DCA — назначает трекер. */
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
    ...(haveImpliedQuote
      ? {
          jupiterCorridorSignedDevPct: +signedDevPct.toFixed(4),
          jupiterCorridorDiffPct: +diffPctAbs.toFixed(4),
        }
      : {}),
    corridorUpPct: pending.corridorUpPct,
    corridorDownPct: pending.corridorDownPct,
    timelineLabelRu: `${`Докупка ${Math.round((addUsd / cfg.positionUsd) * 100)}% позиции`}${cfg.liveExitModeAbEnabled ? ' · сплит входа (не DCA); режим A/B — по первому TP +5% или DCA' : ''}`,
  });

  journalLiveStrategy?.({
    kind: 'live_position_scale_in',
    mint,
    openTrade: serializeOpenTrade(ot),
  });
}
