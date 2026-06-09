import type { TwapWatchState } from '../detect.js';
import { HL_TWAP_EXIT_REASON_EARLY, HL_TWAP_EXIT_REASON_SHORT, twapCancelExitDelayMinutes, twapExitEarlyMinutesForDuration, isShortTwapMinutes } from '../twap-duration.js';
import {
  scheduleWhaleExitDelay,
  takeDueWhaleExit,
} from '../twap-whale-exit.js';
import { shouldCloseOnWhaleTwapCancel } from '../user-rating.js';
import type { HyperliquidMarketCache } from '../hyperliquid-meta.js';
import { fetchHlClearinghouseMargin, fetchHlClearinghousePositions } from '../hyperliquid-meta.js';
import { computeCoinEntryPlan } from '../coin-twap-analysis.js';
import { hlTwapEntrySide } from '../fade-whales.js';
import { markPxForCoin } from '../paper-trader.js';
import { computeTwapSchedule } from '../twap-schedule.js';
import type { NormalizedTwapSignal } from '../types.js';
import { freeMarginUsd, hasMarginForNewOpen } from './account-margin.js';
import { canScheduleLiveEntry } from './coin-exposure.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapExchangeClient } from './exchange-client.js';
import { flattenCoinOnExchange } from './flatten-position.js';
import {
  closeLiveTrade,
  instantCloseLiveTrade,
  isLiveExitPending,
  processPendingLiveExits,
} from './chunked-exit-runner.js';
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
import { notifyLiveTradeOpen } from './telegram-notify.js';
import { isOpenFillAcceptable } from './parse-order-fill.js';
import {
  avgEntryAfterAdd,
  nextLadderAction,
  unrealizedUsd,
  type LadderConfig,
} from './position-ladder.js';
import type { HlTwapLiveOpen } from './types.js';

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

/** Sync journal gross notional from exchange positionValue when drift is large. */
async function reconcileJournalNotionalFromExchange(
  pos: HlTwapLiveOpen,
  client: HlTwapExchangeClient,
): Promise<void> {
  if (client.mode !== 'live') return;

  const onExchange = await fetchHlClearinghousePositions(client.accountAddress());
  const ex = onExchange.find((p) => p.coin === pos.coin && p.side === pos.side);
  if (!ex || ex.notionalUsd <= 0) return;

  const journalNtl = pos.currentNotionalUsd;
  if (journalNtl <= 0) {
    pos.currentNotionalUsd = ex.notionalUsd;
    return;
  }

  const drift = Math.abs(ex.notionalUsd - journalNtl) / journalNtl;
  if (drift > 0.15) {
    console.log(
      `[hl-twap-live] reconcile ${pos.displaySymbol} notional journal $${journalNtl.toFixed(0)} → exchange $${ex.notionalUsd.toFixed(0)}`,
    );
    pos.currentNotionalUsd = ex.notionalUsd;
  }
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

  const decision = canScheduleLiveEntry(sig, watchState, opens, cfg.minImpactPct, filePath);
  if (!decision.allow) {
    console.log(`[hl-twap-live] skip schedule ${sig.displaySymbol} ${sig.side}: ${decision.reason}`);
    return { scheduled: false, reason: decision.reason };
  }

  const plan = computeCoinEntryPlan(sig, watchState, cfg.minImpactPct);
  const sched = computeTwapSchedule(sig);
  const entrySide = hlTwapEntrySide(sig.user, sig.side);
  appendLiveJournal(
    filePath,
    journalScheduleRow({
      hash: sig.hash,
      openAtMs: decision.openAtMs ?? plan.openAtMs,
      closeAtMs: sched.paperCloseAtMs,
      twapStartMs: sched.twapStartMs,
      coin: sig.coin,
      displaySymbol: sig.displaySymbol,
      side: entrySide,
      whaleUser: sig.user,
      minutes: sig.minutes,
      impactPct: sig.volumeSharePct,
      whaleNotionalUsd: sig.notionalUsd,
      whaleSize: sig.size,
    }),
  );
  return { scheduled: true, reason: 'ok' };
}

async function executeLiveOpen(
  sched: JournalSchedule,
  entryPx: number,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<{ pos: HlTwapLiveOpen | null; rejectReason?: 'no_price' | 'fill_too_small' }> {
  if (entryPx <= 0) return { pos: null, rejectReason: 'no_price' };
  const marginUsd = cfg.notionalUsd;
  const fill = await client.marketOrder({
    coin: sched.coin,
    displaySymbol: sched.displaySymbol,
    side: sched.side,
    notionalUsd: marginUsd,
    markPx: entryPx,
    reduceOnly: false,
    intent: 'open',
  });

  const requestedGross =
    fill.requestedNotionalUsd ?? marginUsd * (fill.leverage ?? cfg.leverage);
  if (!isOpenFillAcceptable(fill.notionalUsd, requestedGross)) {
    console.warn(
      `[hl-twap-live] open ${sched.displaySymbol} rejected: fill $${fill.notionalUsd.toFixed(0)} too small (requested ~$${requestedGross.toFixed(0)})`,
    );
    if (fill.sizeBase > 0) {
      const closeSide = sched.side === 'buy' ? 'sell' : 'buy';
      try {
        await client.marketOrder({
          coin: sched.coin,
          displaySymbol: sched.displaySymbol,
          side: closeSide,
          notionalUsd: fill.notionalUsd,
          markPx: entryPx,
          reduceOnly: true,
          intent: 'close',
          sizeBase: fill.sizeBase,
        });
      } catch (e) {
        console.warn(`[hl-twap-live] unwind tiny ${sched.displaySymbol} fill failed`, String(e));
      }
    }
    return { pos: null, rejectReason: 'fill_too_small' };
  }

  const pos: HlTwapLiveOpen = {
    hash: sched.hash,
    coin: sched.coin,
    displaySymbol: sched.displaySymbol,
    side: sched.side,
    entryTs: Date.now(),
    entryAnchorPx: fill.fillPx,
    avgEntryPx: fill.fillPx,
    initialNotionalUsd: fill.notionalUsd,
    currentNotionalUsd: fill.notionalUsd,
    marginUsd: fill.marginUsd ?? marginUsd,
    entryLeverage: fill.leverage ?? cfg.leverage,
    impactPct: sched.impactPct,
    whaleUser: sched.whaleUser,
    minutes: sched.minutes,
    liveOpenAtMs: sched.openAtMs,
    liveCloseAtMs: sched.closeAtMs,
    twapStartMs: sched.twapStartMs,
    tpLevelsTaken: 0,
    dcaLevelsTaken: 0,
    whaleNotionalUsd: sched.whaleNotionalUsd,
    whaleSize: sched.whaleSize,
  };
  appendLiveJournal(cfg.journalPath, journalOpenRow(pos));
  await reconcileJournalNotionalFromExchange(pos, client);
  await notifyLiveTradeOpen(pos, cfg, watchState);
  return { pos };
}

export { closeLiveTrade };

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
  watchState?: TwapWatchState,
): Promise<void> {
  const filePath = cfg.journalPath;
  const now = Date.now();
  const pending = loadPendingLiveSchedules(filePath);
  const opensBefore = loadLiveOpensFromJournal(filePath);

  let accountMargin: Awaited<ReturnType<typeof fetchHlClearinghouseMargin>> | null = null;
  if (client.mode === 'live' && pending.size > 0) {
    try {
      accountMargin = await fetchHlClearinghouseMargin(client.accountAddress());
    } catch (e) {
      console.warn('[hl-twap-live] margin fetch failed', String(e));
    }
  }

  for (const sched of pending.values()) {
    if (now < sched.openAtMs) continue;
    try {
      if (watchState) {
        const sig = watchState.activeByHash.get(sched.hash);
        if (!sig) {
          cancelSchedule(filePath, sched.hash, 'twap_gone_before_open');
          console.log(`[hl-twap-live] cancel open ${sched.displaySymbol}: twap gone`);
          continue;
        }
        const plan = computeCoinEntryPlan(sig, watchState, cfg.minImpactPct);
        if (!plan.allow) {
          cancelSchedule(filePath, sched.hash, `open_blocked_${plan.reason}`);
          console.log(`[hl-twap-live] cancel open ${sched.displaySymbol}: ${plan.reason}`);
          continue;
        }
      }

      if (accountMargin && !hasMarginForNewOpen(accountMargin, opensBefore, cfg.notionalUsd)) {
        const free = freeMarginUsd(accountMargin, opensBefore);
        const spotNote =
          accountMargin.spotUsdcTotalUsd != null && accountMargin.spotUsdcTotalUsd > 0
            ? ` spotUsdc=$${accountMargin.spotUsdcTotalUsd.toFixed(0)}`
            : '';
        console.log(
          `[hl-twap-live] defer open ${sched.displaySymbol}: insufficient_account_margin (free ~$${free.toFixed(0)}, need $${cfg.notionalUsd}${spotNote})`,
        );
        continue;
      }

      const px =
        markPxForCoin(sched.coin, cache) || (cache.mids.get(sched.displaySymbol) ?? 0);
      const opened = await executeLiveOpen(sched, px, cfg, client, watchState);
      if (opened.pos) {
        opensBefore.set(opened.pos.hash, opened.pos);
      } else if (opened.rejectReason === 'fill_too_small') {
        cancelSchedule(filePath, sched.hash, 'open_fill_too_small');
      }
    } catch (e) {
      console.warn(`[hl-twap-live] open failed ${sched.displaySymbol}`, String(e));
    }
  }

  const opens = loadLiveOpensFromJournal(filePath);
  await processPendingLiveExits((pos) => exitPxForOpen(pos, cache), cfg, client, watchState);

  for (const pos of opens.values()) {
    if (isLiveExitPending(cfg, pos.hash)) continue;

    const dueReason = watchState ? takeDueWhaleExit(watchState, pos.hash, now) : null;
    if (dueReason) {
      try {
        const px = exitPxForOpen(pos, cache);
        const closed = await closeLiveTrade(pos.hash, px, dueReason, cfg, client, watchState);
        if (closed) {
          console.log(`[hl-twap-live] closed ${pos.displaySymbol} (${dueReason}, delayed +${twapCancelExitDelayMinutes()}m)`);
        }
      } catch (e) {
        console.warn(`[hl-twap-live] delayed close failed ${pos.displaySymbol}`, String(e));
      }
      continue;
    }

    const whaleEnded = watchState ? !watchState.activeByHash.has(pos.hash) : false;
    const timerDue = now >= pos.liveCloseAtMs;

    if (timerDue) {
      try {
        const px = exitPxForOpen(pos, cache);
        const exitReason = isShortTwapMinutes(pos.minutes)
          ? HL_TWAP_EXIT_REASON_SHORT
          : HL_TWAP_EXIT_REASON_EARLY;
        const closed = await closeLiveTrade(pos.hash, px, exitReason, cfg, client, watchState);
        if (closed) {
          console.log(`[hl-twap-live] closed ${pos.displaySymbol} (${exitReason})`);
        } else if (!isLiveExitPending(cfg, pos.hash)) {
          console.log(`[hl-twap-live] exit started ${pos.displaySymbol} (${exitReason})`);
        }
      } catch (e) {
        console.warn(`[hl-twap-live] close failed ${pos.displaySymbol}`, String(e));
      }
      continue;
    }

    if (whaleEnded) {
      const endedStatus = watchState?.lastEndedStatusByHash.get(pos.hash);
      if (endedStatus && !shouldCloseOnWhaleTwapCancel(endedStatus)) {
        continue;
      }
      const reason = endedStatus ? `twap_${endedStatus}` : 'twap_ended_feed';
      if (watchState && scheduleWhaleExitDelay(watchState, pos.hash, reason, now)) {
        console.log(
          `[hl-twap-live] delayed exit ${pos.displaySymbol} in ${twapCancelExitDelayMinutes()}m (${reason})`,
        );
        continue;
      }
      try {
        const px = exitPxForOpen(pos, cache);
        const closed = await closeLiveTrade(pos.hash, px, reason, cfg, client, watchState);
        if (closed) {
          console.log(`[hl-twap-live] closed ${pos.displaySymbol} (${reason})`);
        }
      } catch (e) {
        console.warn(`[hl-twap-live] close failed ${pos.displaySymbol}`, String(e));
      }
    }
  }
}

/** ±3% ladder: partial TP and DCA while TWAP cycles run. */
export async function processLiveLadders(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<void> {
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  const lcfg = ladderCfg(cfg);

  for (const pos of opens.values()) {
    if (watchState?.ladderBlockedHashes.has(pos.hash)) continue;
    if (isLiveExitPending(cfg, pos.hash)) continue;

    const markPx = exitPxForOpen(pos, cache);
    if (markPx <= 0) continue;

    try {
      await reconcileJournalNotionalFromExchange(pos, client);

      let action = nextLadderAction(
        pos.side,
        markPx,
        pos.avgEntryPx,
        pos.initialNotionalUsd,
        pos.currentNotionalUsd,
        pos.tpLevelsTaken,
        pos.dcaLevelsTaken,
        lcfg,
        pos.entryLeverage,
      );

      while (action) {
        if (action.kind === 'take_profit') {
          const closeSide = pos.side === 'buy' ? 'sell' : 'buy';
          const szi = await client.getPositionSzi(pos.coin);
          const absPos = Math.abs(szi);
          const targetBase = action.notionalUsd / markPx;
          const reduceBase = Math.min(targetBase, absPos);
          if (reduceBase <= 0) break;

          const fill = await client.marketOrder({
            coin: pos.coin,
            displaySymbol: pos.displaySymbol,
            side: closeSide,
            notionalUsd: reduceBase * markPx,
            markPx,
            reduceOnly: true,
            intent: 'tp',
            sizeBase: reduceBase,
          });
          const filledUsd = fill.notionalUsd;
          if (filledUsd <= 0) break;

          const newNotional = Math.max(0, pos.currentNotionalUsd - filledUsd);
          pos.currentNotionalUsd = newNotional;
          pos.tpLevelsTaken = action.level;
          appendLiveJournal(
            filePath,
            journalTpRow(
              pos.hash,
              action.level,
              filledUsd,
              fill.fillPx,
              newNotional,
              pos.tpLevelsTaken,
            ),
          );
          await reconcileJournalNotionalFromExchange(pos, client);
          console.log(
            `[hl-twap-live] TP L${action.level} ${pos.displaySymbol} -$${filledUsd.toFixed(0)} uPnL=${unrealizedUsd(pos.side, pos.avgEntryPx, pos.currentNotionalUsd, markPx).toFixed(2)}`,
          );
        } else {
          const szi = await client.getPositionSzi(pos.coin);
          if (Math.abs(szi) <= 0) {
            console.log(
              `[hl-twap-live] ${pos.displaySymbol} flat on exchange — reconcile close (journal still open)`,
            );
            await instantCloseLiveTrade(pos.hash, markPx, 'exchange_flat_reconcile', cfg, client, watchState);
            break;
          }

          const fill = await client.marketOrder({
            coin: pos.coin,
            displaySymbol: pos.displaySymbol,
            side: pos.side,
            notionalUsd: action.notionalUsd,
            markPx,
            reduceOnly: false,
            intent: 'dca',
          });
          if (fill.notionalUsd <= 0) break;

          pos.avgEntryPx = avgEntryAfterAdd(
            pos.avgEntryPx,
            pos.currentNotionalUsd,
            fill.notionalUsd,
            fill.fillPx,
          );
          pos.currentNotionalUsd += fill.notionalUsd;
          pos.dcaLevelsTaken = action.level;
          appendLiveJournal(
            filePath,
            journalDcaRow(
              pos.hash,
              action.level,
              fill.notionalUsd,
              fill.fillPx,
              pos.avgEntryPx,
              pos.currentNotionalUsd,
              pos.dcaLevelsTaken,
            ),
          );
          await reconcileJournalNotionalFromExchange(pos, client);
          console.log(
            `[hl-twap-live] DCA L${action.level} ${pos.displaySymbol} +$${fill.notionalUsd.toFixed(0)} avg=${pos.avgEntryPx.toFixed(4)}`,
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
          pos.entryLeverage,
        );
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes('Insufficient margin')) {
        watchState?.ladderBlockedHashes.add(pos.hash);
        console.log(
          `[hl-twap-live] ladder paused ${pos.displaySymbol}: insufficient margin (no further DCA this session)`,
        );
        continue;
      }
      console.warn(`[hl-twap-live] ladder failed ${pos.displaySymbol}`, msg);
    }
  }
}

/** TWAP cancelled or finished — cancel pending schedule; close live only on cancel. */
export async function handleLiveOnTwapEnd(
  sig: NormalizedTwapSignal,
  cache: HyperliquidMarketCache,
  endedStatus: string,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<void> {
  const filePath = cfg.journalPath;
  const reason = `twap_${endedStatus}`;
  const opens = loadLiveOpensFromJournal(filePath);
  if (opens.has(sig.hash)) {
    if (!shouldCloseOnWhaleTwapCancel(endedStatus)) {
      console.log(
        `[hl-twap-live] ignore whale TWAP end ${sig.displaySymbol} (${endedStatus}) — timer exit −${twapExitEarlyMinutesForDuration(sig.minutes)}m`,
      );
      return;
    }
    if (watchState && scheduleWhaleExitDelay(watchState, sig.hash, reason)) {
      console.log(
        `[hl-twap-live] delayed exit ${sig.displaySymbol} in ${twapCancelExitDelayMinutes()}m (${reason})`,
      );
      return;
    }
    const px = exitPxForOpen(opens.get(sig.hash)!, cache);
    await closeLiveTrade(sig.hash, px, reason, cfg, client, watchState);
    return;
  }
  cancelSchedule(filePath, sig.hash, `${reason}_before_open`);
}

/** Flatten exchange positions with no active journal cycle (ghost leftovers). */
export async function processExchangeResiduals(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
): Promise<void> {
  if (client.mode !== 'live') return;

  const onExchange = await fetchHlClearinghousePositions(client.accountAddress());
  const journalOpens = loadLiveOpensFromJournal(cfg.journalPath);
  const activeKeys = new Set(
    [...journalOpens.values()].map((o) => `${o.coin}:${o.side}`),
  );

  for (const ex of onExchange) {
    const key = `${ex.coin}:${ex.side}`;
    if (activeKeys.has(key)) continue;

    const markPx = markPxForCoin(ex.coin, cache) || ex.entryPx;
    if (markPx <= 0) continue;

    console.log(
      `[hl-twap-live] flatten residual ${ex.displaySymbol} ${ex.side} size=${ex.size.toFixed(4)} ~$${ex.notionalUsd.toFixed(0)}`,
    );
    const { flat, remainingAbsSize } = await flattenCoinOnExchange(
      client,
      ex.coin,
      ex.displaySymbol,
      markPx,
      'residual',
    );
    appendLiveJournal(cfg.journalPath, {
      kind: 'residual_flatten',
      ts: Date.now(),
      coin: ex.coin,
      displaySymbol: ex.displaySymbol,
      side: ex.side,
      sizeBase: ex.size,
      notionalUsd: ex.notionalUsd,
      flat,
      remainingAbsSize,
    });
    if (!flat) {
      console.error(
        `[hl-twap-live] residual ${ex.displaySymbol} still ${remainingAbsSize.toFixed(6)} base after flatten attempts`,
      );
    }
  }
}

export { unrealizedUsd };
