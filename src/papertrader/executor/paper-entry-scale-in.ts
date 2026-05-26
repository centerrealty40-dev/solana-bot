/**
 * Вторая нога scale-in для paper-only Oscar V2.1 (без on-chain swap).
 * Семантика коридора и опроса — как у `tryLiveEntryScaleInTrackerStep`.
 */
import { getSolUsd, getLiveMcUsd } from '../pricing.js';
import { quoteResilienceFromPaperCfg, type PaperTraderConfig } from '../config.js';
import { jupiterQuoteBuyPriceUsd } from '../pricing/price-verify.js';
import { applyEntryCosts } from '../costs.js';
import type { OpenTrade } from '../types.js';
import { getPriorityFeeUsd } from '../pricing/priority-fee.js';
import { readPaperOscarScaleInEnv } from './paper-scale-in-env.js';
import { usesPaperOscarSecondLegScaleIn } from '../paper-oscar-v21.js';

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

export async function tryPaperOnlyScaleInTrackerStep(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  mint: string;
  curMetric: number;
  journalAppend: (event: Record<string, unknown>) => void;
  verifyStillOpen?: () => boolean;
}): Promise<void> {
  const { cfg, ot, mint, curMetric, journalAppend, verifyStillOpen } = args;
  if (!usesPaperOscarSecondLegScaleIn(cfg.strategyId)) return;

  const si = readPaperOscarScaleInEnv();
  if (!si.enabled) return;

  const pending = parsePending(ot.livePendingScaleIn as unknown);
  if (!pending) return;
  ot.livePendingScaleIn = pending;

  if (ot.partialSells.length > 0) {
    ot.livePendingScaleIn = null;
    journalAppend({
      kind: 'risk_note',
      reason: 'paper_scale_in_skip_partial_tp_fired',
      mint,
      detail: {
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
    journalAppend({
      kind: 'risk_note',
      reason: 'paper_scale_in_skip_after_dca',
      mint,
      detail: {
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

  const scheduleBackoffRetry = () => {
    pending.nextAttemptAfterTs = Date.now() + si.retryBackoffMs;
    ot.livePendingScaleIn = pending;
  };

  const scheduleCorridorPoll = () => {
    pending.nextAttemptAfterTs = Date.now() + si.outOfCorridorPollMs;
    ot.livePendingScaleIn = pending;
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
    ot.livePendingScaleIn = null;
    journalAppend({
      kind: 'risk_note',
      reason: 'paper_scale_in_quote_giveup',
      mint,
      detail: {
        attempts: pending.swapAttempts,
        quoteKind: quote.kind,
        timelineKind: 'scale_in_skip',
        timelineLabelRu: `План второй ноги снят: нет котировки Jupiter после ${pending.swapAttempts} попыток.`,
      },
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
  if (cfg.strategyId === 'live-oscar') ot.liveKillstopBelowStreak = 0;
  ot.totalInvestedUsd += addUsd;
  const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  ot.avgEntry = num / ot.totalInvestedUsd;
  const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  ot.remainingFraction = 1;
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
    timelineLabelRu: `Докупка ${Math.round((addUsd / cfg.positionUsd) * 100)}% позиции (paper V2.1 — нейтральная фаза до триггера ±)`,
  });
}
