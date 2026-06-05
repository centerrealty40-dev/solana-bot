import type { TwapWatchState } from '../detect.js';
import type { HyperliquidMarketCache } from '../hyperliquid-meta.js';
import { markPxForCoin } from '../paper-trader.js';
import { computeTwapSchedule } from '../twap-schedule.js';
import type { NormalizedTwapSignal } from '../types.js';
import {
  canScheduleLiveEntry,
  indexOpensByCoin,
  oppositeActiveTwapForCoin,
} from './coin-exposure.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapExchangeClient } from './exchange-client.js';
import {
  appendLiveJournal,
  journalDcaRow,
  journalOpenRow,
  journalScheduleRow,
  journalTpRow,
  loadLiveOpensFromJournal,
  loadPendingLiveSchedules,
  type JournalSchedule,
} from './journal.js';
import { notifyLiveTradeClose, notifyLiveTradeOpen } from './telegram-notify.js';
import {
  avgEntryAfterAdd,
  nextLadderAction,
  unrealizedUsd,
  type LadderConfig,
} from './position-ladder.js';
import type { HlTwapLiveClose, HlTwapLiveOpen } from './types.js';

function exitPxForOpen(open: HlTwapLiveOpen, cache: HyperliquidMarketCache): number {
  const fromMids = markPxForCoin(open.coin, cache);
  if (fromMids > 0) return fromMids;
  const fromSym = cache.mids.get(open.displaySymbol) ?? 0;
  if (fromSym > 0) return fromSym;
  return open.avgEntryPx;
}

function ladderCfg(cfg: HlTwapLiveConfig): LadderConfig {
  return { stepPct: cfg.ladderStepPct, slicePctOfInitial: cfg.ladderSlicePct };
}

/** Schedule live entry after Telegram OPEN (same timing as paper). */
export function scheduleLiveTrade(
  sig: NormalizedTwapSignal,
  watchState: TwapWatchState,
  cfg: HlTwapLiveConfig,
): { scheduled: boolean; reason: string } {
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  const pending = loadPendingLiveSchedules(filePath);
  if (opens.has(sig.hash) || pending.has(sig.hash)) {
    return { scheduled: false, reason: 'already_tracked' };
  }

  const openByCoin = indexOpensByCoin(opens);
  const opposite = oppositeActiveTwapForCoin(watchState, sig);
  const decision = canScheduleLiveEntry(
    sig.coin,
    sig.side,
    sig.volumeSharePct,
    openByCoin,
    opposite,
    cfg.minImpactPct,
  );
  if (!decision.allow) {
    console.log(`[hl-twap-live] skip schedule ${sig.displaySymbol} ${sig.side}: ${decision.reason}`);
    return { scheduled: false, reason: decision.reason };
  }

  const sched = computeTwapSchedule(sig);
  appendLiveJournal(
    filePath,
    journalScheduleRow({
      hash: sig.hash,
      openAtMs: sched.paperOpenAtMs,
      closeAtMs: sched.paperCloseAtMs,
      twapStartMs: sched.twapStartMs,
      coin: sig.coin,
      displaySymbol: sig.displaySymbol,
      side: sig.side,
      whaleUser: sig.user,
      minutes: sig.minutes,
      impactPct: sig.volumeSharePct,
    }),
  );
  return { scheduled: true, reason: 'ok' };
}

async function executeLiveOpen(
  sched: JournalSchedule,
  entryPx: number,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
): Promise<HlTwapLiveOpen | null> {
  if (entryPx <= 0) return null;
  const notionalUsd = cfg.notionalUsd;
  const fill = await client.marketOrder({
    coin: sched.coin,
    displaySymbol: sched.displaySymbol,
    side: sched.side,
    notionalUsd,
    markPx: entryPx,
    reduceOnly: false,
    intent: 'open',
  });

  const pos: HlTwapLiveOpen = {
    hash: sched.hash,
    coin: sched.coin,
    displaySymbol: sched.displaySymbol,
    side: sched.side,
    entryTs: Date.now(),
    entryAnchorPx: fill.fillPx,
    avgEntryPx: fill.fillPx,
    initialNotionalUsd: notionalUsd,
    currentNotionalUsd: notionalUsd,
    impactPct: sched.impactPct,
    whaleUser: sched.whaleUser,
    minutes: sched.minutes,
    liveOpenAtMs: sched.openAtMs,
    liveCloseAtMs: sched.closeAtMs,
    twapStartMs: sched.twapStartMs,
    tpLevelsTaken: 0,
    dcaLevelsTaken: 0,
  };
  appendLiveJournal(cfg.journalPath, journalOpenRow(pos));
  await notifyLiveTradeOpen(pos, cfg);
  return pos;
}

export async function closeLiveTrade(
  hash: string,
  exitPx: number,
  exitReason: string,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  cache?: HyperliquidMarketCache,
): Promise<HlTwapLiveClose | null> {
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  const pos = opens.get(hash);
  if (!pos || exitPx <= 0) return null;

  const closeSide = pos.side === 'buy' ? 'sell' : 'buy';
  await client.marketOrder({
    coin: pos.coin,
    displaySymbol: pos.displaySymbol,
    side: closeSide,
    notionalUsd: pos.currentNotionalUsd,
    markPx: exitPx,
    reduceOnly: true,
    intent: 'close',
  });

  const dir = pos.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((exitPx - pos.avgEntryPx) / pos.avgEntryPx) * 100;
  const pnlUsd = (pnlPct / 100) * pos.currentNotionalUsd;

  appendLiveJournal(filePath, {
    kind: 'close',
    ts: Date.now(),
    hash: pos.hash,
    exitPx,
    pnlUsd,
    pnlPct,
    exitReason,
  });

  if (cache) {
    /* cache unused but keeps API symmetric with paper */
  }

  const closed: HlTwapLiveClose = { ...pos, exitTs: Date.now(), exitPx, pnlUsd, pnlPct, exitReason };
  await notifyLiveTradeClose(closed, cfg);
  return closed;
}

function cancelSchedule(filePath: string, hash: string, reason: string): void {
  const pending = loadPendingLiveSchedules(filePath);
  if (!pending.has(hash)) return;
  appendLiveJournal(filePath, { kind: 'schedule_cancel', ts: Date.now(), hash, reason });
}

/** Open/close on TWAP cycle timers. */
export async function processLiveTrades(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
): Promise<void> {
  const filePath = cfg.journalPath;
  const now = Date.now();
  const pending = loadPendingLiveSchedules(filePath);

  for (const sched of pending.values()) {
    if (now >= sched.openAtMs) {
      const px =
        markPxForCoin(sched.coin, cache) || (cache.mids.get(sched.displaySymbol) ?? 0);
      await executeLiveOpen(sched, px, cfg, client);
    }
  }

  const opens = loadLiveOpensFromJournal(filePath);
  for (const pos of opens.values()) {
    if (now >= pos.liveCloseAtMs) {
      const px = exitPxForOpen(pos, cache);
      await closeLiveTrade(pos.hash, px, 'before_last_cycle', cfg, client);
    }
  }
}

/** ±3% ladder: partial TP and DCA while TWAP cycles run. */
export async function processLiveLadders(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
): Promise<void> {
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  const lcfg = ladderCfg(cfg);

  for (const pos of opens.values()) {
    const markPx = exitPxForOpen(pos, cache);
    if (markPx <= 0) continue;

    let action = nextLadderAction(
      pos.side,
      markPx,
      pos.avgEntryPx,
      pos.initialNotionalUsd,
      pos.currentNotionalUsd,
      pos.tpLevelsTaken,
      pos.dcaLevelsTaken,
      lcfg,
    );

    while (action) {
      if (action.kind === 'take_profit') {
        const closeSide = pos.side === 'buy' ? 'sell' : 'buy';
        const fill = await client.marketOrder({
          coin: pos.coin,
          displaySymbol: pos.displaySymbol,
          side: closeSide,
          notionalUsd: action.notionalUsd,
          markPx,
          reduceOnly: true,
          intent: 'tp',
        });
        const newNotional = Math.max(0, pos.currentNotionalUsd - action.notionalUsd);
        pos.currentNotionalUsd = newNotional;
        pos.tpLevelsTaken = action.level;
        appendLiveJournal(
          filePath,
          journalTpRow(
            pos.hash,
            action.level,
            action.notionalUsd,
            fill.fillPx,
            newNotional,
            pos.tpLevelsTaken,
          ),
        );
        console.log(
          `[hl-twap-live] TP L${action.level} ${pos.displaySymbol} -$${action.notionalUsd.toFixed(0)} uPnL=${unrealizedUsd(pos.side, pos.avgEntryPx, pos.currentNotionalUsd, markPx).toFixed(2)}`,
        );
      } else {
        const fill = await client.marketOrder({
          coin: pos.coin,
          displaySymbol: pos.displaySymbol,
          side: pos.side,
          notionalUsd: action.notionalUsd,
          markPx,
          reduceOnly: false,
          intent: 'dca',
        });
        pos.avgEntryPx = avgEntryAfterAdd(
          pos.avgEntryPx,
          pos.currentNotionalUsd,
          action.notionalUsd,
          fill.fillPx,
        );
        pos.currentNotionalUsd += action.notionalUsd;
        pos.dcaLevelsTaken = action.level;
        appendLiveJournal(
          filePath,
          journalDcaRow(
            pos.hash,
            action.level,
            action.notionalUsd,
            fill.fillPx,
            pos.avgEntryPx,
            pos.currentNotionalUsd,
            pos.dcaLevelsTaken,
          ),
        );
        console.log(
          `[hl-twap-live] DCA L${action.level} ${pos.displaySymbol} +$${action.notionalUsd.toFixed(0)} avg=${pos.avgEntryPx.toFixed(4)}`,
        );
      }

      action = nextLadderAction(
        pos.side,
        markPx,
        pos.avgEntryPx,
        pos.initialNotionalUsd,
        pos.currentNotionalUsd,
        pos.tpLevelsTaken,
        pos.dcaLevelsTaken,
        lcfg,
      );
    }
  }
}

/** TWAP cancelled/ended — close live or cancel pending schedule. */
export async function handleLiveOnTwapEnd(
  sig: NormalizedTwapSignal,
  cache: HyperliquidMarketCache,
  endedStatus: string,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
): Promise<void> {
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  if (opens.has(sig.hash)) {
    const px = exitPxForOpen(opens.get(sig.hash)!, cache);
    await closeLiveTrade(sig.hash, px, `twap_${endedStatus}`, cfg, client);
    return;
  }
  cancelSchedule(filePath, sig.hash, `twap_${endedStatus}_before_open`);
}

export { unrealizedUsd };
