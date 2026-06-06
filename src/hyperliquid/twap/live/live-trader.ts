import type { TwapWatchState } from '../detect.js';
import type { HyperliquidMarketCache } from '../hyperliquid-meta.js';
import { fetchHlClearinghousePositions } from '../hyperliquid-meta.js';
import { computeCoinEntryPlan } from '../coin-twap-analysis.js';
import { markPxForCoin } from '../paper-trader.js';
import { computeTwapSchedule } from '../twap-schedule.js';
import type { NormalizedTwapSignal } from '../types.js';
import { canScheduleLiveEntry } from './coin-exposure.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapExchangeClient } from './exchange-client.js';
import { flattenCoinOnExchange } from './flatten-position.js';
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

  const decision = canScheduleLiveEntry(sig, watchState, opens, cfg.minImpactPct);
  if (!decision.allow) {
    console.log(`[hl-twap-live] skip schedule ${sig.displaySymbol} ${sig.side}: ${decision.reason}`);
    return { scheduled: false, reason: decision.reason };
  }

  const plan = computeCoinEntryPlan(sig, watchState, cfg.minImpactPct);
  const sched = computeTwapSchedule(sig);
  appendLiveJournal(
    filePath,
    journalScheduleRow({
      hash: sig.hash,
      openAtMs: decision.openAtMs ?? plan.openAtMs,
      closeAtMs: sched.paperCloseAtMs,
      twapStartMs: sched.twapStartMs,
      coin: sig.coin,
      displaySymbol: sig.displaySymbol,
      side: sig.side,
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
): Promise<HlTwapLiveOpen | null> {
  if (entryPx <= 0) return null;
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
  await notifyLiveTradeOpen(pos, cfg, watchState);
  return pos;
}

export async function closeLiveTrade(
  hash: string,
  exitPx: number,
  exitReason: string,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
): Promise<HlTwapLiveClose | null> {
  const filePath = cfg.journalPath;
  const opens = loadLiveOpensFromJournal(filePath);
  const pos = opens.get(hash);
  if (!pos || exitPx <= 0) return null;

  const sziBefore = await client.getPositionSzi(pos.coin);
  const { flat, remainingAbsSize } = await flattenCoinOnExchange(
    client,
    pos.coin,
    pos.displaySymbol,
    exitPx,
    'close',
  );

  if (!flat) {
    console.error(
      `[hl-twap-live] close ${pos.displaySymbol} ABORTED: ${remainingAbsSize.toFixed(6)} base still on exchange — journal not updated (${exitReason})`,
    );
    return null;
  }

  const reconciled = Math.abs(sziBefore) <= 0;

  const dir = pos.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((exitPx - pos.avgEntryPx) / pos.avgEntryPx) * 100;
  const pnlUsd = (pnlPct / 100) * pos.currentNotionalUsd;
  const finalReason = reconciled ? `${exitReason}_reconciled` : exitReason;

  appendLiveJournal(filePath, {
    kind: 'close',
    ts: Date.now(),
    hash: pos.hash,
    exitPx,
    pnlUsd,
    pnlPct,
    exitReason: finalReason,
  });

  const closed: HlTwapLiveClose = {
    ...pos,
    exitTs: Date.now(),
    exitPx,
    pnlUsd,
    pnlPct,
    exitReason: finalReason,
  };
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
  watchState?: TwapWatchState,
): Promise<void> {
  const filePath = cfg.journalPath;
  const now = Date.now();
  const pending = loadPendingLiveSchedules(filePath);

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
      const px =
        markPxForCoin(sched.coin, cache) || (cache.mids.get(sched.displaySymbol) ?? 0);
      await executeLiveOpen(sched, px, cfg, client, watchState);
    } catch (e) {
      console.warn(`[hl-twap-live] open failed ${sched.displaySymbol}`, String(e));
    }
  }

  const opens = loadLiveOpensFromJournal(filePath);
  for (const pos of opens.values()) {
    const whaleEnded = watchState ? !watchState.activeByHash.has(pos.hash) : false;
    const timerDue = now >= pos.liveCloseAtMs;
    if (!timerDue && !whaleEnded) continue;
    try {
      const px = exitPxForOpen(pos, cache);
      const reason = whaleEnded && !timerDue ? 'twap_ended_feed' : 'before_last_cycle';
      await closeLiveTrade(pos.hash, px, reason, cfg, client);
      console.log(`[hl-twap-live] closed ${pos.displaySymbol} (${reason})`);
    } catch (e) {
      console.warn(`[hl-twap-live] close failed ${pos.displaySymbol}`, String(e));
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

    try {
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
          const filledUsd = reduceBase * (fill.fillPx || markPx);
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
          console.log(
            `[hl-twap-live] TP L${action.level} ${pos.displaySymbol} -$${filledUsd.toFixed(0)} uPnL=${unrealizedUsd(pos.side, pos.avgEntryPx, pos.currentNotionalUsd, markPx).toFixed(2)}`,
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
          pos.entryLeverage,
        );
      }
    } catch (e) {
      console.warn(`[hl-twap-live] ladder failed ${pos.displaySymbol}`, String(e));
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
