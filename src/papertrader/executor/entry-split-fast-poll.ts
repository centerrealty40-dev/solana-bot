/**
 * Fast poll for pending entry-split legs 2–8 — independent of 30s tracker tick.
 * Corridor gates (+3% / −5%) and delay from `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS`.
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { fetchLatestSnapshotQuote, getSolUsd } from '../pricing.js';
import { child } from '../../core/logger.js';
import type { LiveOscarConfig } from '../../live/config.js';
import type { LiveOscarPhase4Tracker } from '../../live/phase4-types.js';
import { liveFetchBuyQuote } from '../../live/jupiter.js';
import { tokenUsdFromBuyQuoteFitDecimals } from '../../live/phase5-gates.js';
import {
  openTradeNeedsEntrySplitFastPoll,
  resolveEntrySplitFastPollIntervalMsFromOpen,
} from './live-staged-entry-gates.js';
import { maybeRefreshPendingLegPgForOpenTrade } from '../pricing/pending-leg-pg-refresh.js';
import { tryLiveStagedEntryV2TrackerStep } from './live-staged-entry-lifecycle.js';

const log = child('entry-split-fast-poll');

const IDLE_RESCHEDULE_MS = 5000;

export interface EntrySplitFastPollContext {
  paperCfg: PaperTraderConfig;
  getOpen: () => ReadonlyMap<string, OpenTrade>;
  isTrackerBusy: () => boolean;
  journalAppend: (event: Record<string, unknown>) => void;
  journalLiveStrategy?: (event: Record<string, unknown>) => void;
  resolveLivePhase4?: () => LiveOscarPhase4Tracker | undefined;
  resolveLiveOscarCfg?: () => LiveOscarConfig | undefined;
}

async function resolveEntrySplitMetricUsd(args: {
  ot: OpenTrade;
  mint: string;
  liveOscarCfg?: LiveOscarConfig;
}): Promise<{ curMetric: number; entrySplitJupiterPx?: number }> {
  const { ot, mint, liveOscarCfg } = args;
  let snapPx = 0;
  try {
    const quote = await fetchLatestSnapshotQuote(
      mint,
      ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
    );
    snapPx = Number(quote.priceUsd ?? 0);
  } catch (err) {
    log.warn({ mint: mint.slice(0, 8), err: String(err) }, 'snapshot fetch failed');
  }

  let entrySplitJupiterPx: number | undefined;
  if (liveOscarCfg?.liveEntrySplitJupiterProbeEnabled) {
    const solUsd = getSolUsd() ?? 0;
    const hintDec = ot.tokenDecimals ?? 6;
    const anchorPx =
      ot.avgEntryMarket > 0
        ? ot.avgEntryMarket
        : ot.avgEntry > 0
          ? ot.avgEntry
          : snapPx > 0
            ? snapPx
            : 0;
    const remUsd = ot.totalInvestedUsd * Math.max(0.05, ot.remainingFraction);
    const probeUsd = Math.max(
      liveOscarCfg.liveTrackerMtmProbeMinUsd,
      Math.min(liveOscarCfg.liveTrackerMtmProbeMaxUsd, remUsd * liveOscarCfg.liveTrackerMtmProbeFraction),
    );
    if (solUsd > 0 && probeUsd > 0) {
      try {
        const fq = await liveFetchBuyQuote({
          cfg: liveOscarCfg,
          outputMint: mint,
          sizeUsd: probeUsd,
          solUsd,
        });
        const fit = fq
          ? tokenUsdFromBuyQuoteFitDecimals(fq.quoteResponse, solUsd, hintDec, anchorPx)
          : null;
        const jpx = fit?.px;
        if (jpx != null && jpx > 0) {
          entrySplitJupiterPx = jpx;
          const fittedDec = fit!.decimalsUsed;
          if (fittedDec !== hintDec && ot.tokenDecimals !== fittedDec) {
            ot.tokenDecimals = fittedDec;
          }
        }
      } catch (err) {
        log.warn({ mint: mint.slice(0, 8), err: String(err) }, 'Jupiter corridor probe failed');
      }
    }
  }

  const curMetric =
    entrySplitJupiterPx != null && entrySplitJupiterPx > 0
      ? entrySplitJupiterPx
      : snapPx > 0
        ? snapPx
        : ot.avgEntryMarket > 0
          ? ot.avgEntryMarket
          : ot.avgEntry;
  return { curMetric, entrySplitJupiterPx };
}

export async function runEntrySplitFastPollStep(ctx: EntrySplitFastPollContext): Promise<void> {
  const open = ctx.getOpen();
  const livePhase4 = ctx.resolveLivePhase4?.();
  const liveOscarCfg = ctx.resolveLiveOscarCfg?.();

  for (const [mint, ot] of open) {
    if (!openTradeNeedsEntrySplitFastPoll(ot)) continue;
    try {
      await maybeRefreshPendingLegPgForOpenTrade({
        cfg: ctx.paperCfg,
        ot,
        mint,
        journalAppend: ctx.journalAppend,
      });
      const { curMetric, entrySplitJupiterPx } = await resolveEntrySplitMetricUsd({
        ot,
        mint,
        liveOscarCfg,
      });
      if (!(curMetric > 0)) continue;
      await tryLiveStagedEntryV2TrackerStep({
        cfg: ctx.paperCfg,
        ot,
        mint,
        curMetric,
        entrySplitMetricUsd: entrySplitJupiterPx,
        livePhase4,
        journalAppend: ctx.journalAppend,
        journalLiveStrategy: ctx.journalLiveStrategy,
      });
    } catch (err) {
      log.warn({ mint: mint.slice(0, 8), err: String(err) }, 'entry split fast poll failed');
    }
  }
}

export function startEntrySplitFastPoll(ctx: EntrySplitFastPollContext): NodeJS.Timeout {
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  function scheduleNext(delayMs: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  }

  async function tick(): Promise<void> {
    if (running || ctx.isTrackerBusy()) {
      scheduleNext(IDLE_RESCHEDULE_MS);
      return;
    }
    running = true;
    try {
      const pollMs = resolveEntrySplitFastPollIntervalMsFromOpen(ctx.getOpen());
      if (pollMs == null) {
        scheduleNext(IDLE_RESCHEDULE_MS);
        return;
      }
      await runEntrySplitFastPollStep(ctx);
      scheduleNext(pollMs);
    } finally {
      running = false;
    }
  }

  void tick();
  const handle = setInterval(() => {
    if (!running && !ctx.isTrackerBusy()) void tick();
  }, IDLE_RESCHEDULE_MS);
  (handle as NodeJS.Timeout & { _entrySplitFastPollStop?: () => void })._entrySplitFastPollStop = () => {
    if (timer) clearTimeout(timer);
    clearInterval(handle);
  };
  return handle;
}

export function stopEntrySplitFastPoll(handle: NodeJS.Timeout | null | undefined): void {
  if (!handle) return;
  const stop = (handle as NodeJS.Timeout & { _entrySplitFastPollStop?: () => void })._entrySplitFastPollStop;
  if (stop) stop();
  else clearInterval(handle);
}
