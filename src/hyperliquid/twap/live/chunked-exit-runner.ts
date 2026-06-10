import {
  buildExitScheduleAnchor,
  chunkedExitEnabled,
  exitSliceDueAtMs,
  loadChunkedExitConfig,
  nextDueSliceIndex,
  sliceTargetBase,
  vwapExitPx,
} from './chunked-exit.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapExchangeClient } from './exchange-client.js';
import { flattenCoinOnExchange } from './flatten-position.js';
import {
  appendLiveJournal,
  journalExitSliceRow,
  journalExitStartRow,
  loadLiveOpensFromJournal,
  loadPendingLiveExits,
  type PendingLiveExit,
} from './journal.js';
import { notifyLiveTradeClose } from './telegram-notify.js';
import type { HlTwapLiveClose, HlTwapLiveOpen } from './types.js';
import type { TwapWatchState } from '../detect.js';
import { clearWhaleExitPending } from '../twap-whale-exit.js';
import { HL_TWAP_SLICE_INTERVAL_SEC } from '../twap-schedule.js';
import { microTwapExitSliceCount, shouldUseMicroExecution } from '../twap-duration.js';

function exitAnchor(exit: PendingLiveExit) {
  return buildExitScheduleAnchor(
    exit.twapStartMs ?? exit.startedAtMs,
    exit.startedAtMs,
    exit.startedAtMs,
    exit.sliceIntervalMs,
  );
}

function exitAnchorFromPending(exit: PendingLiveExit) {
  if (exit.twapStartMs != null && exit.firstWhaleSliceIndex != null) {
    return {
      twapStartMs: exit.twapStartMs,
      firstWhaleSliceIndex: exit.firstWhaleSliceIndex,
      startedAtMs: exit.startedAtMs,
      sliceIntervalMs: exit.sliceIntervalMs,
    };
  }
  return exitAnchor(exit);
}

/** Instant full flatten (legacy). */
export async function instantCloseLiveTrade(
  hash: string,
  exitPx: number,
  exitReason: string,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
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

  return await finalizeLiveClose(pos, exitPx, exitReason, cfg, watchState, {
    sziBefore,
    exitSlices: 1,
    exitSliceIntervalMs: 0,
  });
}

/** Start chunked exit or instant when disabled. Returns close row only when instant flat. */
export async function closeLiveTrade(
  hash: string,
  exitPx: number,
  exitReason: string,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<HlTwapLiveClose | null> {
  const filePath = cfg.journalPath;
  const pending = loadPendingLiveExits(filePath);
  if (pending.has(hash)) return null;

  const opens = loadLiveOpensFromJournal(filePath);
  const pos = opens.get(hash);
  if (!pos || exitPx <= 0) return null;

  if (shouldUseMicroExecution(pos.minutes)) {
    const microSlices = microTwapExitSliceCount(pos.minutes);
    if (microSlices <= 1) {
      return instantCloseLiveTrade(hash, exitPx, exitReason, cfg, client, watchState);
    }
    const exitCfg = {
      sliceCount: microSlices,
      sliceIntervalMs: HL_TWAP_SLICE_INTERVAL_SEC * 1000,
    };
    return startChunkedExit(pos, exitPx, exitReason, exitCfg, cfg, client, watchState);
  }

  const exitCfg = loadChunkedExitConfig(cfg, pos.side);
  if (!chunkedExitEnabled(exitCfg)) {
    return instantCloseLiveTrade(hash, exitPx, exitReason, cfg, client, watchState);
  }

  return startChunkedExit(pos, exitPx, exitReason, exitCfg, cfg, client, watchState);
}

async function startChunkedExit(
  pos: HlTwapLiveOpen,
  exitPx: number,
  exitReason: string,
  exitCfg: { sliceCount: number; sliceIntervalMs: number },
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<HlTwapLiveClose | null> {
  const hash = pos.hash;
  const filePath = cfg.journalPath;
  const startedAtMs = Date.now();
  const triggerMs = Math.max(startedAtMs, pos.liveCloseAtMs);
  const anchor = buildExitScheduleAnchor(
    pos.twapStartMs,
    triggerMs,
    startedAtMs,
    exitCfg.sliceIntervalMs,
  );

  appendLiveJournal(
    filePath,
    journalExitStartRow({
      hash,
      exitReason,
      sliceCount: exitCfg.sliceCount,
      sliceIntervalMs: exitCfg.sliceIntervalMs,
      startedAtMs,
      exitStartNotionalUsd: pos.currentNotionalUsd,
      twapStartMs: anchor.twapStartMs,
      firstWhaleSliceIndex: anchor.firstWhaleSliceIndex,
    }),
  );

  const firstDue = exitSliceDueAtMs(anchor, 0);
  console.log(
    `[hl-twap-live] exit TWAP start ${pos.displaySymbol} ${exitCfg.sliceCount}× whale-aligned/${exitCfg.sliceIntervalMs / 1000}s ` +
      `first@${new Date(firstDue).toISOString()} whale_k=${anchor.firstWhaleSliceIndex} (${exitReason})`,
  );

  const pendingExit: PendingLiveExit = {
    kind: 'exit_start',
    ts: startedAtMs,
    hash,
    exitReason,
    sliceCount: exitCfg.sliceCount,
    sliceIntervalMs: exitCfg.sliceIntervalMs,
    startedAtMs,
    exitStartNotionalUsd: pos.currentNotionalUsd,
    twapStartMs: anchor.twapStartMs,
    firstWhaleSliceIndex: anchor.firstWhaleSliceIndex,
    slicesSent: 0,
    fills: [],
  };

  const dueIdx = nextDueSliceIndex(
    exitAnchorFromPending(pendingExit),
    0,
    exitCfg.sliceCount,
    startedAtMs,
  );
  if (dueIdx === null) return null;

  return processOneExitSlice(pos, pendingExit, exitPx, cfg, client, watchState);
}

async function processOneExitSlice(
  pos: HlTwapLiveOpen,
  pending: PendingLiveExit,
  markPx: number,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<HlTwapLiveClose | null> {
  const closeSide = pos.side === 'buy' ? 'sell' : 'buy';
  const szi = await client.getPositionSzi(pos.coin);
  const absSize = Math.abs(szi);
  if (absSize <= 0) {
    return await finalizeLiveClose(pos, markPx, pending.exitReason, cfg, watchState, {
      fills: pending.fills,
      exitSlices: pending.sliceCount,
      exitSliceIntervalMs: pending.sliceIntervalMs,
    });
  }

  const sliceIndex = pending.slicesSent;
  let targetBase = sliceTargetBase(absSize, sliceIndex, pending.sliceCount);
  const isLastScheduled = sliceIndex >= pending.sliceCount - 1;
  if (isLastScheduled) targetBase = absSize;

  if (targetBase <= 0) return null;

  try {
    const fill = await client.marketOrder({
      coin: pos.coin,
      displaySymbol: pos.displaySymbol,
      side: closeSide,
      notionalUsd: targetBase * markPx,
      markPx,
      reduceOnly: true,
      intent: 'close',
      sizeBase: targetBase,
    });

    const remaining = Math.abs(await client.getPositionSzi(pos.coin));
    appendLiveJournal(
      cfg.journalPath,
      journalExitSliceRow({
        hash: pos.hash,
        sliceIndex,
        fillPx: fill.fillPx,
        notionalUsd: fill.notionalUsd,
        sizeBase: fill.sizeBase,
        remainingBase: remaining,
      }),
    );

    console.log(
      `[hl-twap-live] exit slice ${sliceIndex + 1}/${pending.sliceCount} ${pos.displaySymbol} -${fill.sizeBase.toFixed(4)} @ ${fill.fillPx.toFixed(4)} rem=${remaining.toFixed(4)}`,
    );

    const allFills = [...pending.fills, { fillPx: fill.fillPx, sizeBase: fill.sizeBase }];
    const slicesSent = sliceIndex + 1;

    if (remaining <= 0 || (isLastScheduled && remaining > 0)) {
      if (remaining > 0) {
        await flattenCoinOnExchange(client, pos.coin, pos.displaySymbol, markPx, 'close');
      }
      const vwap = vwapExitPx(allFills) || markPx;
      return await finalizeLiveClose(pos, vwap, pending.exitReason, cfg, watchState, {
        fills: allFills,
        exitSlices: pending.sliceCount,
        exitSliceIntervalMs: pending.sliceIntervalMs,
      });
    }

    if (slicesSent >= pending.sliceCount) {
      const { flat, remainingAbsSize } = await flattenCoinOnExchange(
        client,
        pos.coin,
        pos.displaySymbol,
        markPx,
        'close',
      );
      if (!flat) {
        console.error(
          `[hl-twap-live] exit ${pos.displaySymbol} incomplete after ${slicesSent} slices: ${remainingAbsSize.toFixed(6)} base left`,
        );
        return null;
      }
      const vwap = vwapExitPx(allFills) || markPx;
      return await finalizeLiveClose(pos, vwap, pending.exitReason, cfg, watchState, {
        fills: allFills,
        exitSlices: pending.sliceCount,
        exitSliceIntervalMs: pending.sliceIntervalMs,
      });
    }
  } catch (e) {
    console.warn(`[hl-twap-live] exit slice failed ${pos.displaySymbol}`, String(e));
  }
  return null;
}

async function finalizeLiveClose(
  pos: HlTwapLiveOpen,
  exitPx: number,
  exitReason: string,
  cfg: HlTwapLiveConfig,
  watchState: TwapWatchState | undefined,
  opts: {
    sziBefore?: number;
    fills?: Array<{ fillPx: number; sizeBase: number }>;
    exitSlices: number;
    exitSliceIntervalMs: number;
  },
): Promise<HlTwapLiveClose> {
  const filePath = cfg.journalPath;
  const dir = pos.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((exitPx - pos.avgEntryPx) / pos.avgEntryPx) * 100;
  const pnlUsd = (pnlPct / 100) * pos.currentNotionalUsd;
  const reconciled = opts.sziBefore != null ? Math.abs(opts.sziBefore) <= 0 : false;
  const finalReason = reconciled ? `${exitReason}_reconciled` : exitReason;

  appendLiveJournal(filePath, {
    kind: 'close',
    ts: Date.now(),
    hash: pos.hash,
    exitPx,
    pnlUsd,
    pnlPct,
    exitReason: finalReason,
    exitSlices: opts.exitSlices,
    exitSliceIntervalMs: opts.exitSliceIntervalMs,
  });

  if (watchState) clearWhaleExitPending(watchState, pos.hash);

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

/** Run due exit slices for all in-progress exits (call each poll). */
export async function processPendingLiveExits(
  markPxFor: (pos: HlTwapLiveOpen) => number,
  cfg: HlTwapLiveConfig,
  client: HlTwapExchangeClient,
  watchState?: TwapWatchState,
): Promise<void> {
  const exitCfg = loadChunkedExitConfig(cfg);
  if (!chunkedExitEnabled(exitCfg)) return;

  const filePath = cfg.journalPath;
  const pending = loadPendingLiveExits(filePath);
  if (pending.size === 0) return;

  const opens = loadLiveOpensFromJournal(filePath);
  const now = Date.now();

  for (const [hash, exit] of pending) {
    const pos = opens.get(hash);
    if (!pos) continue;

    const dueIdx = nextDueSliceIndex(
      exitAnchorFromPending(exit),
      exit.slicesSent,
      exit.sliceCount,
      now,
    );
    if (dueIdx === null) continue;

    const markPx = markPxFor(pos);
    if (markPx <= 0) continue;

    const closed = await processOneExitSlice(pos, exit, markPx, cfg, client, watchState);
    if (closed) {
      console.log(
        `[hl-twap-live] closed ${pos.displaySymbol} (${closed.exitReason}) vwap=${closed.exitPx.toFixed(4)} pnl=$${closed.pnlUsd.toFixed(2)}`,
      );
    }
  }
}

export function isLiveExitPending(cfg: HlTwapLiveConfig, hash: string): boolean {
  return loadPendingLiveExits(cfg.journalPath).has(hash);
}
