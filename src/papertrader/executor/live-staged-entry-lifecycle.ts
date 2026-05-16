/**
 * Live Oscar staged entry: entry split (2× cash, anti-impact) vs staged averaging (−7% / −14%).
 * Staged averaging is NOT `PAPER_DCA_LEVELS` and NOT entry scale-in (`livePendingScaleIn`).
 */
import { getLiveMcUsd, getSolUsd } from '../pricing.js';
import type { PaperTraderConfig } from '../config.js';
import { applyEntryCosts } from '../costs.js';
import type { OpenTrade } from '../types.js';
import type { LiveOscarPhase4Tracker } from '../../live/phase4-types.js';
import type { LiveBuyPipelineResult } from '../../live/phase4-types.js';
import { appendLiveBuyAnchorsAfterDca } from '../../live/live-buy-anchor.js';
import { getPriorityFeeUsd } from '../pricing/priority-fee.js';
import { serializeOpenTrade } from '../../live/strategy-snapshot.js';
import {
  entrySplitBandOk,
  pctFromAnchor,
  signalDropPctFromState,
  stagedAvgFirstEligible,
  stagedAvgSecondEligible,
  usesLegacyStagedAdds,
} from './live-staged-entry-gates.js';
import {
  entrySplitLeg2TimelineLabel,
  stagedAvgTimelineLabel,
} from './live-staged-entry-labels.js';

type JournalFn = (event: Record<string, unknown>) => void;

async function pushBuyLeg(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  mint: string;
  addUsd: number;
  marketBuy: number;
  reason: 'entry_split' | 'staged_avg';
  triggerPct: number;
  livePhase4?: LiveOscarPhase4Tracker;
  journalAppend: JournalFn;
  journalLiveStrategy?: JournalFn;
  timelineLabelRu: string;
  logTag: string;
}): Promise<boolean> {
  const {
    cfg,
    ot,
    mint,
    addUsd,
    marketBuy,
    reason,
    triggerPct,
    livePhase4,
    journalAppend,
    journalLiveStrategy,
    timelineLabelRu,
    logTag,
  } = args;
  let buyRes: LiveBuyPipelineResult | undefined;
  if (livePhase4) {
    buyRes = await livePhase4.trySolToTokenBuy({
      mint,
      symbol: ot.symbol,
      usdNotional: addUsd,
      intentKind: reason === 'entry_split' ? 'buy_scale_in' : 'dca_add',
    });
    if (!buyRes.ok) return false;
  }
  const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);
  ot.legs.push({
    ts: Date.now(),
    price: effectiveBuy,
    marketPrice: marketBuy,
    sizeUsd: addUsd,
    reason,
    triggerPct,
  });
  ot.livePendingScaleIn = null;
  ot.liveKillstopBelowStreak = 0;
  ot.totalInvestedUsd += addUsd;
  const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  ot.avgEntry = num / ot.totalInvestedUsd;
  const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  ot.remainingFraction = 1;
  if (marketBuy > ot.peakMcUsd) ot.peakMcUsd = marketBuy;
  ot.peakPnlPct = (marketBuy / ot.avgEntry - 1) * 100;
  if (cfg.liveExitModeAbEnabled) ot.liveExitProfileMode = 'B';
  if (livePhase4 && buyRes) appendLiveBuyAnchorsAfterDca(ot, buyRes);
  const mcUsdLive = await getLiveMcUsd(
    mint,
    ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
  );
  const pf = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
  journalAppend({
    kind: reason === 'entry_split' ? 'entry_split_add' : 'staged_avg_add',
    mint,
    ts: Date.now(),
    price: effectiveBuy,
    marketPrice: marketBuy,
    sizeUsd: addUsd,
    avgEntry: ot.avgEntry,
    avgEntryMarket: ot.avgEntryMarket,
    totalInvestedUsd: ot.totalInvestedUsd,
    legCount: ot.legs.length,
    mcUsdLive,
    priorityFee: pf,
    timelineLabelRu,
    liveExitProfileMode: 'B' as const,
  });
  journalLiveStrategy?.({
    kind: 'live_position_dca',
    mint,
    openTrade: serializeOpenTrade(ot),
    timelineLabelRu,
  });
  console.log(`[${logTag}] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} ${timelineLabelRu}`);
  return true;
}

export async function tryLiveStagedEntryV2TrackerStep(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  mint: string;
  curMetric: number;
  livePhase4?: LiveOscarPhase4Tracker;
  journalAppend: JournalFn;
  journalLiveStrategy?: JournalFn;
}): Promise<void> {
  const st = args.ot.liveStagedEntry;
  if (!st?.entrySplitV2 || args.ot.remainingFraction <= 0) return;

  const { curMetric } = args;
  const now = Date.now();
  const anchor = st.entrySplitAnchorUsd ?? st.signalPriceUsd;

  if (!st.entrySplitLeg2Done) {
    const leg1Ts = st.entrySplitLeg1Ts ?? st.signalTs;
    const delay = st.entrySplitDelayMs ?? 10_000;
    if (now >= leg1Ts + delay) {
      const ch = pctFromAnchor(anchor, curMetric);
      const maxUp = st.entrySplitMaxUpPct ?? 3;
      const maxDown = st.entrySplitMaxDownPct ?? 10;
      if (ch != null && entrySplitBandOk(ch, maxUp, maxDown)) {
        const usd = st.entrySplitLegUsd ?? st.firstLegUsd;
        const ok = await pushBuyLeg({
          cfg: args.cfg,
          ot: args.ot,
          mint: args.mint,
          addUsd: usd,
          marketBuy: curMetric,
          reason: 'entry_split',
          triggerPct: ch / 100,
          livePhase4: args.livePhase4,
          journalAppend: args.journalAppend,
          journalLiveStrategy: args.journalLiveStrategy,
          timelineLabelRu: entrySplitLeg2TimelineLabel(usd, ch),
          logTag: 'ENTRY_SPLIT',
        });
        if (ok) st.entrySplitLeg2Done = true;
      }
    }
  }

  const signalDropPct = signalDropPctFromState(st, curMetric);
  if (signalDropPct == null) return;

  const avg1Usd = st.avgSecondLegUsd ?? st.secondLegUsd;
  const avg2Usd = st.avgThirdLegUsd ?? st.thirdLegUsd ?? 0;
  const drop7 = st.avgSecondDropPct ?? st.secondDropPct;
  const drop14 = st.avgThirdDropPct ?? st.thirdDropPct;

  if (
    stagedAvgFirstEligible({ st, signalDropPct, nowMs: now }) &&
    avg1Usd > 0 &&
    drop7 > 0
  ) {
    const ok = await pushBuyLeg({
      cfg: args.cfg,
      ot: args.ot,
      mint: args.mint,
      addUsd: avg1Usd,
      marketBuy: curMetric,
      reason: 'staged_avg',
      triggerPct: -drop7 / 100,
      livePhase4: args.livePhase4,
      journalAppend: args.journalAppend,
      journalLiveStrategy: args.journalLiveStrategy,
      timelineLabelRu: stagedAvgTimelineLabel({
        which: 1,
        usd: avg1Usd,
        signalDropPct,
        drop7,
        drop14: drop14 ?? 14,
      }),
      logTag: 'STAGED_AVG_1',
    });
    if (ok) {
      st.avgFirstLegDone = true;
      st.avgFirstLegTs = now;
      st.secondLegDone = true;
    }
  }

  if (
    stagedAvgSecondEligible({ st, signalDropPct, nowMs: now }) &&
    avg2Usd > 0 &&
    drop14 != null &&
    drop14 > 0
  ) {
    const ok = await pushBuyLeg({
      cfg: args.cfg,
      ot: args.ot,
      mint: args.mint,
      addUsd: avg2Usd,
      marketBuy: curMetric,
      reason: 'staged_avg',
      triggerPct: -drop14 / 100,
      livePhase4: args.livePhase4,
      journalAppend: args.journalAppend,
      journalLiveStrategy: args.journalLiveStrategy,
      timelineLabelRu: stagedAvgTimelineLabel({
        which: 2,
        usd: avg2Usd,
        signalDropPct,
        drop7: drop7,
        drop14,
      }),
      logTag: 'STAGED_AVG_2',
    });
    if (ok) {
      st.avgSecondLegDone = true;
      st.thirdLegDone = true;
    }
  }
}

export { usesLegacyStagedAdds };
