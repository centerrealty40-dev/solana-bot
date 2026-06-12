import type { TwapWatchState } from '../detect.js';
import { twapCancelExitDelayMinutes, twapExitEarlyMinutesForDuration, twapTimerExitReason } from '../twap-duration.js';
import {
  scheduleWhaleExitDelay,
  takeDueWhaleExit,
} from '../twap-whale-exit.js';
import { shouldCloseOnWhaleTwapCancel } from '../user-rating.js';
import type { HyperliquidMarketCache } from '../hyperliquid-meta.js';
import { fetchHlClearinghouseMargin, fetchHlClearinghousePositions } from '../hyperliquid-meta.js';
import { computeCoinEntryPlan, shouldCloseForImpactLoss } from '../coin-twap-analysis.js';
import { hlTwapEntrySide } from '../fade-whales.js';
import { markPxForCoin } from '../paper-trader.js';
import { computeTwapSchedule } from '../twap-schedule.js';
import type { NormalizedTwapSignal, TwapSide } from '../types.js';
import { freeMarginUsd, hasMarginForNewOpen } from './account-margin.js';
import { computeOpenMarginUsd } from './dynamic-margin.js';
import { openMarginUsdForCoin } from './margin-by-leverage.js';
import { canScheduleLiveEntry } from './coin-exposure.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapExchangeClient } from './exchange-client.js';
import { flattenCoinOnExchange } from './flatten-position.js';
import {
  blocksLiveLadderDuringExit,
  closeLiveTrade,
  instantCloseLiveTrade,
  isLiveExitPending,
  processPendingLiveExits,
} from './chunked-exit-runner.js';
import { isTradingHaltedByDrawdown } from './drawdown-stop.js';
import {
  appendLiveJournal,
  journalDcaRow,
  journalOpenRow,
  journalReanchorRow,
  journalScheduleRow,
  journalTpRow,
  loadLiveOpensFromJournal,
  loadPendingLiveSchedules,
  type JournalSchedule,
} from './journal.js';
import {
  clearCoinSideOpenInFlight,
  markCoinSideOpenInFlight,
} from './live-exec-worker.js';
import { notifyLiveTradeOpen } from './telegram-notify.js';
import { isOpenFillAcceptable } from './parse-order-fill.js';
import {
  avgEntryAfterAdd,
  nextLadderAction,
  unrealizedUsd,
  type LadderConfig,
} from './position-ladder.js';
import {
  applyDcaLevelToGroup,
  applyTpLevelToGroup,
  coinSideKey,
  distributeExchangeNotional,
  groupAvgEntryPx,
  groupMaxDcaLevels,
  groupMaxTpLevels,
  groupOpensByCoinSide,
  primaryOpenInGroup,
  sumInitialMarginUsd,
  sumInitialNotionalUsd,
} from './coin-side-ladder.js';
import {
  bookDriverCloseAtMs,
  bookGrossUsd,
  dcaWouldExceedBookGrossCap,
  newLegGrossUsd,
  stackCfgFromLiveConfig,
  type CoinStackReanchorTarget,
} from './coin-stack-policy.js';
import type { HlTwapLiveOpen } from './types.js';

function exitPxForOpen(open: HlTwapLiveOpen, cache: HyperliquidMarketCache): number {
  const fromMids = markPxForCoin(open.coin, cache);
  if (fromMids > 0) return fromMids;
  const fromSym = cache.mids.get(open.displaySymbol) ?? 0;
  if (fromSym > 0) return fromSym;
  return open.avgEntryPx;
}

function ladderCfg(cfg: HlTwapLiveConfig): LadderConfig {
  return {
    mode: cfg.ladderMode,
    stepPct: cfg.ladderStepPct,
    slicePctOfInitial: cfg.ladderSlicePct,
    dcaPctOfInitial: cfg.ladderDcaPctOfInitial,
  };
}

async function exchangeGrossNotionalUsd(
  client: HlTwapExchangeClient,
  coin: string,
  side: TwapSide,
): Promise<number | null> {
  if (client.mode !== 'live') return null;
  const onExchange = await fetchHlClearinghousePositions(client.accountAddress());
  const ex = onExchange.find((p) => p.coin === coin && p.side === side);
  if (!ex || ex.notionalUsd <= 0) return null;
  return ex.notionalUsd;
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

/** Virtual transfer: re-anchor worst journal leg to a better TWAP (no exchange order). */
export function performCoinStackReanchor(
  sig: NormalizedTwapSignal,
  target: CoinStackReanchorTarget,
  cfg: HlTwapLiveConfig,
  openAtMs: number,
): void {
  const sched = computeTwapSchedule(sig);
  const entrySide = hlTwapEntrySide(sig.user, sig.side);
  appendLiveJournal(
    cfg.journalPath,
    journalReanchorRow({
      oldHash: target.targetHash,
      newHash: sig.hash,
      coin: sig.coin,
      displaySymbol: sig.displaySymbol,
      side: entrySide,
      slot: target.slot,
      openAtMs,
      closeAtMs: sched.paperCloseAtMs,
      twapStartMs: sched.twapStartMs,
      whaleUser: sig.user,
      minutes: sig.minutes,
      impactPct: sig.volumeSharePct,
      whaleNotionalUsd: sig.notionalUsd,
      whaleSize: sig.size,
    }),
  );
  console.log(
    `[hl-twap-live] re-anchor ${sig.displaySymbol} ${entrySide}: ${target.targetHash.slice(0, 12)}… → ${sig.hash.slice(0, 12)}… (${target.slot})`,
  );
}

/** Schedule live entry after Telegram OPEN (same timing as paper). */
export function scheduleLiveTrade(
  sig: NormalizedTwapSignal,
  watchState: TwapWatchState,
  cfg: HlTwapLiveConfig,
  leverageForCoin?: (coin: string) => number,
): { scheduled: boolean; reason: string } {
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  const pending = loadPendingLiveSchedules(filePath);
  if (opens.has(sig.hash) || pending.has(sig.hash)) {
    return { scheduled: false, reason: 'already_tracked' };
  }

  const decision = canScheduleLiveEntry(
    sig,
    watchState,
    opens,
    cfg.minImpactPct,
    filePath,
    cfg,
    leverageForCoin,
  );
  if (!decision.allow) {
    if (decision.reason === 'coin_stack_reanchor' && decision.reanchor) {
      const openAtMs =
        decision.openAtMs ??
        computeCoinEntryPlan(sig, watchState, cfg.minImpactPct).openAtMs;
      performCoinStackReanchor(sig, decision.reanchor, cfg, openAtMs);
      return { scheduled: true, reason: 'reanchored' };
    }
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

async function wouldExceedCoinGrossCap(
  sched: JournalSchedule,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  opens: Map<string, HlTwapLiveOpen>,
  pending: Map<string, JournalSchedule>,
  marginUsd: number,
): Promise<boolean> {
  const lev = client.leverageForCoin(sched.coin);
  const newGross = marginUsd * (lev > 0 ? lev : cfg.leverage);
  const stackCfg = stackCfgFromLiveConfig(cfg, (c) => client.leverageForCoin(c));
  const journalGross = bookGrossUsd(sched.coin, sched.side, opens);
  let scheduledGross = 0;
  for (const [hash, s] of pending) {
    if (hash === sched.hash) continue;
    if (s.coin === sched.coin && s.side === sched.side) {
      scheduledGross += newLegGrossUsd(stackCfg, s.coin);
    }
  }
  const exchangeGross = await exchangeGrossNotionalUsd(client, sched.coin, sched.side);
  const baseline = Math.max(journalGross + scheduledGross, exchangeGross ?? 0);
  return baseline + newGross > cfg.coinMaxGrossUsd;
}

async function executeLiveOpen(
  sched: JournalSchedule,
  entryPx: number,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
  marginUsd = cfg.notionalUsd,
  opens?: Map<string, HlTwapLiveOpen>,
  pending?: Map<string, JournalSchedule>,
): Promise<{
  pos: HlTwapLiveOpen | null;
  rejectReason?: 'no_price' | 'fill_too_small' | 'gross_cap';
}> {
  if (entryPx <= 0) return { pos: null, rejectReason: 'no_price' };

  if (opens && pending) {
    const overCap = await wouldExceedCoinGrossCap(sched, cfg, client, opens, pending, marginUsd);
    if (overCap) {
      console.warn(
        `[hl-twap-live] open ${sched.displaySymbol} blocked: coin gross cap $${cfg.coinMaxGrossUsd}`,
      );
      return { pos: null, rejectReason: 'gross_cap' };
    }
  }

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
    marginUsd,
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
  if (isTradingHaltedByDrawdown()) {
    return;
  }
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

      const effectiveLev = client.leverageForCoin(sched.coin);
      const openMarginUsd = accountMargin
        ? computeOpenMarginUsd(accountMargin, opensBefore, cfg, effectiveLev)
        : openMarginUsdForCoin(sched.coin, cfg, (c) => client.leverageForCoin(c));

      if (
        accountMargin &&
        !hasMarginForNewOpen(accountMargin, opensBefore, openMarginUsd, cfg.marginReserveUsd)
      ) {
        const free = freeMarginUsd(accountMargin, opensBefore);
        console.log(
          `[hl-twap-live] defer open ${sched.displaySymbol}: insufficient_account_margin (free ~$${free.toFixed(0)}, need $${openMarginUsd}, account ~$${accountMargin.accountValueUsd.toFixed(0)})`,
        );
        continue;
      }

      const baseMargin = openMarginUsdForCoin(sched.coin, cfg, (c) => client.leverageForCoin(c));
      if (cfg.dynamicMargin && openMarginUsd !== baseMargin) {
        console.log(
          `[hl-twap-live] dynamic margin ${sched.displaySymbol}: $${openMarginUsd} (opens=${opensBefore.size}, base=$${baseMargin})`,
        );
      } else if (!cfg.dynamicMargin && openMarginUsd !== cfg.notionalUsd) {
        console.log(
          `[hl-twap-live] lev margin ${sched.displaySymbol}: $${openMarginUsd} (${effectiveLev}x)`,
        );
      }

      const px =
        markPxForCoin(sched.coin, cache) || (cache.mids.get(sched.displaySymbol) ?? 0);
      markCoinSideOpenInFlight(sched.coin, sched.side);
      let opened: Awaited<ReturnType<typeof executeLiveOpen>>;
      try {
        opened = await executeLiveOpen(
          sched,
          px,
          cfg,
          client,
          watchState,
          openMarginUsd,
          opensBefore,
          pending,
        );
      } finally {
        clearCoinSideOpenInFlight(sched.coin, sched.side);
      }
      if (opened.pos) {
        opensBefore.set(opened.pos.hash, opened.pos);
      } else if (opened.rejectReason === 'fill_too_small') {
        cancelSchedule(filePath, sched.hash, 'open_fill_too_small');
      } else if (opened.rejectReason === 'gross_cap') {
        cancelSchedule(filePath, sched.hash, 'coin_stack_gross_cap');
      }
    } catch (e) {
      console.warn(`[hl-twap-live] open failed ${sched.displaySymbol}`, String(e));
    }
  }

  const opens = loadLiveOpensFromJournal(filePath);
  await processPendingLiveExits((pos) => exitPxForOpen(pos, cache), cfg, client, watchState);

  const bookGroups = groupOpensByCoinSide(opens);
  const bookCloseAtMs = new Map<string, number>();
  if (watchState) {
    for (const [key, group] of bookGroups) {
      if (group.length === 0) continue;
      const { coin, side } = group[0]!;
      bookCloseAtMs.set(key, bookDriverCloseAtMs(coin, side, group, watchState));
    }
  }

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
    const bookKey = coinSideKey(pos.coin, pos.side);
    const driverCloseAtMs = bookCloseAtMs.get(bookKey) ?? pos.liveCloseAtMs;
    const timerDue = now >= driverCloseAtMs;

    if (timerDue) {
      try {
        const px = exitPxForOpen(pos, cache);
        const exitReason = twapTimerExitReason(pos.minutes);
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

/** Price/ROE ladder: partial TP and DCA — one book per coin+side (exchange gross). */
export async function processLiveLadders(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<void> {
  if (isTradingHaltedByDrawdown()) return;
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  const lcfg = ladderCfg(cfg);
  const groups = groupOpensByCoinSide(opens);

  for (const group of groups.values()) {
    if (group.length === 0) continue;

    const primary = primaryOpenInGroup(group);
    if (group.some((p) => watchState?.ladderBlockedHashes.has(p.hash))) continue;
    if (group.some((p) => blocksLiveLadderDuringExit(cfg, p.hash))) continue;

    const markPx = exitPxForOpen(primary, cache);
    if (markPx <= 0) continue;

    try {
      let bookGross =
        (await exchangeGrossNotionalUsd(client, primary.coin, primary.side)) ??
        group.reduce((s, p) => s + p.currentNotionalUsd, 0);
      if (bookGross <= 0) continue;

      distributeExchangeNotional(group, bookGross);

      const avgPx = groupAvgEntryPx(group);
      const tpLevels = groupMaxTpLevels(group);
      const dcaLevels = groupMaxDcaLevels(group);

      let action = nextLadderAction(
        primary.side,
        markPx,
        avgPx,
        sumInitialMarginUsd(group),
        sumInitialNotionalUsd(group),
        bookGross,
        tpLevels,
        dcaLevels,
        lcfg,
      );

      while (action) {
        if (action.kind === 'take_profit') {
          const closeSide = primary.side === 'buy' ? 'sell' : 'buy';
          const szi = await client.getPositionSzi(primary.coin);
          const absPos = Math.abs(szi);
          const targetBase = action.notionalUsd / markPx;
          const reduceBase = Math.min(targetBase, absPos);
          if (reduceBase <= 0) break;

          const fill = await client.marketOrder({
            coin: primary.coin,
            displaySymbol: primary.displaySymbol,
            side: closeSide,
            notionalUsd: reduceBase * markPx,
            markPx,
            reduceOnly: true,
            intent: 'tp',
            sizeBase: reduceBase,
          });
          const filledUsd = fill.notionalUsd;
          if (filledUsd <= 0) break;

          applyTpLevelToGroup(group, action.level);
          bookGross =
            (await exchangeGrossNotionalUsd(client, primary.coin, primary.side)) ??
            Math.max(0, bookGross - filledUsd);
          distributeExchangeNotional(group, bookGross);

          appendLiveJournal(
            filePath,
            journalTpRow(
              primary.hash,
              action.level,
              filledUsd,
              fill.fillPx,
              bookGross,
              action.level,
            ),
          );
          console.log(
            `[hl-twap-live] TP L${action.level} ${primary.displaySymbol} book=$${bookGross.toFixed(0)} -$${filledUsd.toFixed(0)} (legs=${group.length}) uPnL=${unrealizedUsd(primary.side, avgPx, bookGross, markPx).toFixed(2)}`,
          );
        } else {
          if (
            dcaWouldExceedBookGrossCap(bookGross, action.notionalUsd, cfg.coinMaxGrossUsd)
          ) {
            console.log(
              `[hl-twap-live] DCA blocked ${primary.displaySymbol}: book gross cap $${cfg.coinMaxGrossUsd}`,
            );
            break;
          }
          const szi = await client.getPositionSzi(primary.coin);
          if (Math.abs(szi) <= 0) {
            console.log(
              `[hl-twap-live] ${primary.displaySymbol} flat on exchange — reconcile close (journal still open)`,
            );
            await instantCloseLiveTrade(primary.hash, markPx, 'exchange_flat_reconcile', cfg, client, watchState);
            break;
          }

          const fill = await client.marketOrder({
            coin: primary.coin,
            displaySymbol: primary.displaySymbol,
            side: primary.side,
            notionalUsd: action.notionalUsd,
            markPx,
            reduceOnly: false,
            intent: 'dca',
          });
          if (fill.notionalUsd <= 0) break;

          const newAvg = avgEntryAfterAdd(avgPx, bookGross, fill.notionalUsd, fill.fillPx);
          for (const p of group) p.avgEntryPx = newAvg;

          applyDcaLevelToGroup(group, action.level);
          bookGross =
            (await exchangeGrossNotionalUsd(client, primary.coin, primary.side)) ??
            bookGross + fill.notionalUsd;
          distributeExchangeNotional(group, bookGross);

          appendLiveJournal(
            filePath,
            journalDcaRow(
              primary.hash,
              action.level,
              fill.notionalUsd,
              fill.fillPx,
              newAvg,
              bookGross,
              action.level,
            ),
          );
          console.log(
            `[hl-twap-live] DCA L${action.level} ${primary.displaySymbol} book=$${bookGross.toFixed(0)} +$${fill.notionalUsd.toFixed(0)} avg=${newAvg.toFixed(4)} (legs=${group.length})`,
          );
        }

        action = nextLadderAction(
          primary.side,
          markPx,
          groupAvgEntryPx(group),
          sumInitialMarginUsd(group),
          sumInitialNotionalUsd(group),
          bookGross,
          groupMaxTpLevels(group),
          groupMaxDcaLevels(group),
          lcfg,
        );
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes('Insufficient margin')) {
        for (const p of group) watchState?.ladderBlockedHashes.add(p.hash);
        console.log(
          `[hl-twap-live] ladder paused ${primary.displaySymbol}: insufficient margin (no further DCA this session)`,
        );
        continue;
      }
      console.warn(`[hl-twap-live] ladder failed ${primary.displaySymbol}`, msg);
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

export type LiveTwapEndedSignal = {
  signal: NormalizedTwapSignal;
  endedStatus: string;
};

/** Close live opens when coin-side impact edge is lost (exchange I/O — run off poll loop). */
export async function closeLivePositionsForImpactLoss(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState: TwapWatchState,
  minImpactPct: number,
): Promise<void> {
  const opens = loadLiveOpensFromJournal(cfg.journalPath);
  for (const pos of opens.values()) {
    if (!shouldCloseForImpactLoss(pos.side, watchState, pos.coin, minImpactPct)) continue;
    const px =
      cache.mids.get(pos.coin) ?? cache.mids.get(pos.displaySymbol) ?? pos.avgEntryPx;
    await closeLiveTrade(pos.hash, px, 'impact_edge_lost', cfg, client, watchState);
    console.log(`[hl-twap-live] closed ${pos.displaySymbol} impact edge lost`);
  }
}

/**
 * Full live exchange pass: impact closes, TWAP ends, ladder, timers, residuals.
 * Intended for background worker — not awaited from HypurrScan poll loop.
 */
export async function runLiveExchangePass(
  cache: HyperliquidMarketCache,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState: TwapWatchState,
  opts?: { endedSignals?: LiveTwapEndedSignal[] },
): Promise<void> {
  await closeLivePositionsForImpactLoss(cache, cfg, client, watchState, cfg.minImpactPct);

  for (const { signal, endedStatus } of opts?.endedSignals ?? []) {
    await handleLiveOnTwapEnd(signal, cache, endedStatus, cfg, client, watchState);
  }

  await processLiveLadders(cache, cfg, client, watchState);
  await processLiveTrades(cache, cfg, client, watchState);
  await processExchangeResiduals(cache, cfg, client);
}

export { unrealizedUsd };
