/**
 * Live Oscar — вторая нога входа: после задержки докупка остатка notional, если Jupiter-цена в коридоре к якорю первой ноги.
 */
import { getLiveMcUsd, getSolUsd } from '../papertrader/pricing.js';
import { quoteResilienceFromPaperCfg, type PaperTraderConfig } from '../papertrader/config.js';
import { jupiterQuoteBuyPriceUsd } from '../papertrader/pricing/price-verify.js';
import { applyEntryCosts } from '../papertrader/costs.js';
import type { OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';
import type { LiveBuyIncreaseDeny, LiveOscarPhase4Tracker } from './phase4-types.js';
import { appendLiveBuyAnchorsAfterDca } from './live-buy-anchor.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { getPriorityFeeUsd } from '../papertrader/pricing/priority-fee.js';
import { serializeOpenTrade } from './strategy-snapshot.js';

function timelineRuPhase5Gate(deny: LiveBuyIncreaseDeny): string {
  if (deny.phase !== 'phase5') return '';
  const cr = deny.capitalSkipReason;
  if (deny.code === 'capital_no_profitable_rotation' || cr === 'no_profitable_position_to_close') {
    return 'Докупка отменена: не хватает свободного SOL под буфер Phase 5; не нашлось прибыльной позиции для ротации капитала.';
  }
  if (deny.code === 'capital_insufficient_after_rotation' || cr === 'insufficient_free_after_rotation') {
    return 'Докупка отменена: после ротации капитала всё ещё недостаточно свободного SOL для буфера.';
  }
  if (deny.code === 'capital_insufficient_no_positions' || cr === 'insufficient_free_balance_no_positions') {
    return 'Докупка отменена: открытых позиций нет, свободного SOL меньше требуемого буфера.';
  }
  if (deny.code === 'capital_rotation_failed' || cr === 'rotation_sim_failed') {
    return 'Докупка отменена: не удалось исполнить продажу при ротации капитала.';
  }
  if (deny.code.startsWith('capital_')) {
    return `Докупка отменена: капитальный гейт Phase 5 (${deny.code}).`;
  }
  return `Докупка отменена: Phase 5 заблокировала увеличение экспозиции (${deny.code}).`;
}

function timelineRuPhase4Deny(code: string): string {
  switch (code) {
    case 'ambiguous_buy_cooldown':
      return 'Докупка заблокирована: кулдаун после неоднозначной покупки по этому mint.';
    case 'strategy_disabled':
      return 'Докупка отменена: стратегия выключена (LIVE_STRATEGY_ENABLED).';
    case 'dry_run':
      return 'Докупка отменена: режим dry_run.';
    case 'execution_mode_invalid':
      return 'Докупка отменена: недопустимый LIVE_EXECUTION_MODE.';
    case 'swap_quote_or_build_failed':
      return 'Докупка не выполнена: Jupiter не дал маршрут/сборку свопа для второй ноги.';
    case 'quote_stale':
      return 'Докупка не выполнена: котировка устарела по liveQuoteMaxAgeMs.';
    case 'simulate_preflight_failed':
      return 'Докупка не выполнена: симуляция транзакции не прошла.';
    case 'swap_send_failed':
      return 'Докупка не выполнена: отправка свопа не подтвердилась.';
    default:
      return `Докупка не выполнена: исполнение (${code}).`;
  }
}

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

  if (quote.kind !== 'ok' || !(quote.jupiterPriceUsd > 0)) {
    pending.swapAttempts += 1;
    if (pending.swapAttempts >= pending.maxSwapAttempts) {
      finishCancel('live_scale_in_quote_giveup', {
        attempts: pending.swapAttempts,
        quoteKind: quote.kind,
        timelineLabelRu: `Докупка отменена: котировка Jupiter для второй ноги не пришла после ${pending.swapAttempts} попыток (${quote.kind}).`,
      });
    } else {
      pending.nextAttemptAfterTs = now + liveOscarCfg.liveEntryScaleInRetryBackoffMs;
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
    finishCancel('live_scale_in_corridor_exit', {
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

  const buyRes = await livePhase4.trySolToTokenBuy({
    mint,
    symbol: ot.symbol,
    usdNotional: pending.secondLegUsd,
    intentKind: 'buy_scale_in',
  });

  if (!buyRes.ok) {
    const deny = buyRes.increaseDeny;
    if (deny?.phase === 'phase5') {
      finishCancel('live_scale_in_skipped_phase5', {
        phase5BlockCode: deny.code,
        capitalSkipReason: deny.capitalSkipReason,
        inCorridor: true,
        signedDevPct: +signedDevPct.toFixed(4),
        diffPct: +diffPctAbs.toFixed(4),
        corridorUpPct: pending.corridorUpPct,
        corridorDownPct: pending.corridorDownPct,
        timelineLabelRu: timelineRuPhase5Gate(deny),
      });
      return;
    }
    const immediatePhase4 =
      deny?.phase === 'phase4' &&
      ['strategy_disabled', 'dry_run', 'execution_mode_invalid'].includes(deny.code);
    if (immediatePhase4 && deny) {
      finishCancel('live_scale_in_skipped_phase4', {
        phase4Code: deny.code,
        inCorridor: true,
        signedDevPct: +signedDevPct.toFixed(4),
        diffPct: +diffPctAbs.toFixed(4),
        corridorUpPct: pending.corridorUpPct,
        corridorDownPct: pending.corridorDownPct,
        timelineLabelRu: timelineRuPhase4Deny(deny.code),
      });
      return;
    }

    pending.swapAttempts += 1;
    if (pending.swapAttempts >= pending.maxSwapAttempts) {
      const tlSwap = deny
        ? `${timelineRuPhase4Deny(deny.code)} Исчерпано ${pending.swapAttempts} попыток.`
        : `Докупка отменена: своп второй ноги не прошёл после ${pending.swapAttempts} попыток (цена при этом была в коридоре).`;
      finishCancel('live_scale_in_swap_giveup', {
        attempts: pending.swapAttempts,
        inCorridor: true,
        signedDevPct: +signedDevPct.toFixed(4),
        diffPct: +diffPctAbs.toFixed(4),
        corridorUpPct: pending.corridorUpPct,
        corridorDownPct: pending.corridorDownPct,
        lastIncreaseDeny: deny,
        timelineLabelRu: tlSwap,
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
    jupiterCorridorSignedDevPct: +signedDevPct.toFixed(4),
    jupiterCorridorDiffPct: +diffPctAbs.toFixed(4),
    corridorUpPct: pending.corridorUpPct,
    corridorDownPct: pending.corridorDownPct,
    timelineLabelRu: `Докупка ${Math.round((addUsd / cfg.positionUsd) * 100)}% позиции`,
  });

  journalLiveStrategy?.({
    kind: 'live_position_scale_in',
    mint,
    openTrade: serializeOpenTrade(ot),
  });
}
