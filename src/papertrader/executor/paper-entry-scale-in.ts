/**
 * Вторая нога scale-in для paper-only Oscar V2.1 (без on-chain swap).
 * Коридор и Jupiter — как у `tryLiveEntryScaleInTrackerStep`.
 */
import { getSolUsd, getLiveMcUsd } from '../pricing.js';
import { quoteResilienceFromPaperCfg, type PaperTraderConfig } from '../config.js';
import { jupiterQuoteBuyPriceUsd } from '../pricing/price-verify.js';
import { applyEntryCosts } from '../costs.js';
import type { OpenTrade } from '../types.js';
import { getPriorityFeeUsd } from '../pricing/priority-fee.js';
import { readPaperOscarScaleInEnv } from './paper-scale-in-env.js';
import { PAPER_OSCAR_V21_STRATEGY_ID } from '../paper-oscar-v21.js';

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
  if (cfg.strategyId !== PAPER_OSCAR_V21_STRATEGY_ID) return;

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
          'Докупка второй ноги отменена: уже сработала частичная фиксация по сетке TP — не увеличиваем нотацию перед следующими выходами.',
      },
    });
    return;
  }

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
    const tlRaw = detail.timelineLabelRu;
    const tl = typeof tlRaw === 'string' && tlRaw.trim().length ? String(tlRaw).trim() : undefined;
    journalAppend({
      kind: 'risk_note',
      reason,
      mint,
      detail: {
        ...detail,
        ...(tl ? { timelineKind: 'scale_in_skip', timelineLabelRu: tl } : {}),
      },
    });
  };

  if (quote.kind !== 'ok' || !(quote.jupiterPriceUsd > 0)) {
    pending.swapAttempts += 1;
    if (pending.swapAttempts >= pending.maxSwapAttempts) {
      finishCancel('paper_scale_in_quote_giveup', {
        attempts: pending.swapAttempts,
        quoteKind: quote.kind,
        timelineLabelRu: `Докупка отменена: котировка Jupiter для второй ноги не пришла после ${pending.swapAttempts} попыток (${quote.kind}).`,
      });
    } else {
      pending.nextAttemptAfterTs = now + si.retryBackoffMs;
      ot.livePendingScaleIn = pending;
    }
    return;
  }

  const implied = quote.jupiterPriceUsd;
  const signedDevPct = (implied / pending.anchorMarketUsd - 1) * 100;
  const diffPctAbs = Math.abs(signedDevPct);
  const eps = 1e-6;
  const outCorridor =
    signedDevPct > pending.corridorUpPct + eps || signedDevPct < -pending.corridorDownPct - eps;
  if (outCorridor) {
    const sign = signedDevPct >= 0 ? '+' : '';
    finishCancel('paper_scale_in_corridor_exit', {
      anchorMarketUsd: pending.anchorMarketUsd,
      jupiterPriceUsd: implied,
      signedDevPct: +signedDevPct.toFixed(4),
      diffPct: +diffPctAbs.toFixed(4),
      corridorUpPct: pending.corridorUpPct,
      corridorDownPct: pending.corridorDownPct,
      timelineLabelRu: `Докупка отменена: цена Jupiter вне коридора +${pending.corridorUpPct}% / −${pending.corridorDownPct}% к первой ноге (отклонение ${sign}${signedDevPct.toFixed(2)}%).`,
    });
    return;
  }

  if (verifyStillOpen && !verifyStillOpen()) return;

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
    jupiterCorridorSignedDevPct: +signedDevPct.toFixed(4),
    jupiterCorridorDiffPct: +diffPctAbs.toFixed(4),
    corridorUpPct: pending.corridorUpPct,
    corridorDownPct: pending.corridorDownPct,
    timelineLabelRu: `Докупка ${Math.round((addUsd / cfg.positionUsd) * 100)}% позиции (paper V2.1 — нейтральная фаза до триггера ±)`,
  });
}
