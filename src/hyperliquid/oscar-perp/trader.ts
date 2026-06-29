import { randomUUID } from 'node:crypto';

import type { HyperliquidMarketCache } from '../twap/hyperliquid-meta.js';
import { fetchHlAccountEquityUsd, fetchHlClearinghouseMargin } from '../twap/hyperliquid-meta.js';
import type { HlTwapExchangeClient } from '../twap/live/exchange-client.js';
import type { HlOscarPerpConfig } from './config.js';
import { fetchOscarCandles, type OscarCandle } from './candles.js';
import { cooldownBlocksEntry, evaluateOscarEntry } from './entry-signal.js';
import { computeOscarExitActions } from './exit-engine.js';
import { shouldRemainderFlush } from '../oscar-remainder-flush.js';
import { tryOscarBuyLeg } from '../oscar-open-margin.js';
import {
  appendOscarJournal,
  lastEntryBarTsByCoin,
  loadOscarOpenModesFromJournal,
  loadOscarOpensFromJournal,
  type OscarJournalRow,
} from './journal.js';
import { newOscarPosition, recomputeAvgEntry, type OscarOpenPosition } from './position-types.js';
import type { OscarUniverseCoin } from './universe.js';
import { isOscarTradingHalted } from './drawdown.js';
import {
  notifyOscarAddLeg,
  notifyOscarClose,
  notifyOscarOpen,
  notifyOscarPartialExit,
} from './telegram-notify.js';

export type OscarTraderState = {
  opens: Map<string, OscarOpenPosition>;
  openByCoin: Map<string, string>;
  /** Journal mode at open time — used to reconcile paper vs live exposure. */
  openModes: Map<string, 'dry_run' | 'live'>;
  candleCache: Map<string, { candles: OscarCandle[]; loadedAtMs: number }>;
  lastEntryBarTs: Map<string, number>;
  scanOffset: number;
};

export function createOscarTraderState(journalPath: string): OscarTraderState {
  const opens = loadOscarOpensFromJournal(journalPath);
  const openModes = loadOscarOpenModesFromJournal(journalPath);
  const openByCoin = new Map<string, string>();
  for (const [id, pos] of opens) openByCoin.set(pos.coin, id);
  return {
    opens,
    openByCoin,
    openModes,
    candleCache: new Map(),
    lastEntryBarTs: lastEntryBarTsByCoin(journalPath),
    scanOffset: 0,
  };
}

function journalSkipFromBuyReject(
  coin: string,
  reason: string,
  meta: {
    requestedGrossUsd: number;
    filledGrossUsd: number;
    partialFill: boolean;
    freeMarginAtOpen?: number;
  },
): OscarJournalRow {
  return {
    kind: 'signal_skip',
    ts: Date.now(),
    coin,
    reason,
    requestedGrossUsd: meta.requestedGrossUsd,
    filledGrossUsd: meta.filledGrossUsd,
    partialFill: meta.partialFill,
    freeMarginAtOpen: meta.freeMarginAtOpen,
  };
}

async function reducePosition(
  client: HlTwapExchangeClient,
  pos: OscarOpenPosition,
  fraction: number,
  markPx: number,
): Promise<{ fillPx: number; notionalUsd: number; pnlUsd: number } | null> {
  const sellFrac = Math.min(pos.remainingFraction, pos.remainingFraction * Math.max(0, fraction));
  if (sellFrac <= 1e-9) return null;
  const notionalUsd = pos.totalGrossUsd * sellFrac;
  try {
    const fill = await client.marketOrder({
      coin: pos.coin,
      displaySymbol: pos.displaySymbol,
      side: 'sell',
      notionalUsd,
      markPx,
      reduceOnly: true,
      intent: 'close',
    });
    const basis = notionalUsd;
    const proceeds = basis * (fill.fillPx / pos.avgEntryPx);
    const pnlUsd = proceeds - basis;
    return { fillPx: fill.fillPx, notionalUsd: fill.notionalUsd, pnlUsd };
  } catch (e) {
    console.error(`[hl-oscar-perp] reduce failed ${pos.coin}`, String(e));
    return null;
  }
}

export async function refreshCoinCandles(
  coin: string,
  lookbackHours: number,
): Promise<OscarCandle[]> {
  const endMs = Date.now();
  const startMs = endMs - lookbackHours * 3600_000;
  return fetchOscarCandles(coin, startMs, endMs);
}

async function ensureCandles(
  cfg: HlOscarPerpConfig,
  state: OscarTraderState,
  coin: string,
  lookbackHours: number,
): Promise<OscarCandle[]> {
  let cached = state.candleCache.get(coin);
  if (!cached || Date.now() - cached.loadedAtMs > cfg.candleRefreshMs) {
    const candles = await refreshCoinCandles(coin, lookbackHours);
    cached = { candles, loadedAtMs: Date.now() };
    state.candleCache.set(coin, cached);
  }
  return cached.candles;
}

function rotatingBatch<T>(items: T[], offset: number, size: number): T[] {
  if (items.length <= size) return items;
  const out: T[] = [];
  for (let i = 0; i < size; i++) out.push(items[(offset + i) % items.length]!);
  return out;
}

export async function runOscarTraderPass(args: {
  cfg: HlOscarPerpConfig;
  client: HlTwapExchangeClient;
  cache: HyperliquidMarketCache;
  universe: OscarUniverseCoin[];
  state: OscarTraderState;
}): Promise<void> {
  const { cfg, client, universe, state } = args;
  const mode = client.mode;
  const lookbackHours = Math.max(...cfg.dipLookbackWindowsMin) / 60 + 2;

  if (isOscarTradingHalted(cfg)) {
    console.warn('[hl-oscar-perp] trading halted (drawdown)');
    return;
  }

  for (const pos of state.opens.values()) {
    await processOpenPosition(cfg, client, state, pos, lookbackHours, mode);
  }

  if (state.opens.size >= cfg.maxOpenPositions) return;

  let accountMargin: Awaited<ReturnType<typeof fetchHlClearinghouseMargin>> | null = null;
  if (client.mode === 'live') {
    try {
      accountMargin = await fetchHlClearinghouseMargin(client.accountAddress());
    } catch (e) {
      console.warn('[hl-oscar-perp] margin fetch failed', String(e));
    }
  }

  const entryCandidates = universe.filter((c) => !state.openByCoin.has(c.coin));
  const batch = rotatingBatch(entryCandidates, state.scanOffset, cfg.scanBatchSize);
  state.scanOffset = (state.scanOffset + batch.length) % Math.max(entryCandidates.length, 1);

  for (const coin of batch) {
    if (state.openByCoin.has(coin.coin)) continue;
    if (state.opens.size >= cfg.maxOpenPositions) break;

    const candles = await ensureCandles(cfg, state, coin.coin, lookbackHours);
    const signal = evaluateOscarEntry(cfg, coin.coin, candles);
    if (!signal) continue;

    const lastTs = state.lastEntryBarTs.get(coin.coin);
    if (cooldownBlocksEntry(lastTs, signal.barTs, cfg.dipCooldownMin)) {
      appendOscarJournal(cfg.journalPath, {
        kind: 'signal_skip',
        ts: Date.now(),
        coin: coin.coin,
        reason: 'cooldown',
      });
      continue;
    }

    const markPx = coin.midPx;
    const legResult = await tryOscarBuyLeg({
      client,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      grossUsd: cfg.leg1GrossUsd,
      leverage: cfg.leverage,
      markPx,
      marginReserveUsd: cfg.marginReserveUsd,
      accountMargin,
      logPrefix: '[hl-oscar-perp]',
      intent: 'open',
    });
    if (!legResult.ok) {
      if (legResult.reason !== 'order_failed') {
        appendOscarJournal(
          cfg.journalPath,
          journalSkipFromBuyReject(coin.coin, legResult.reason, legResult.meta),
        );
      }
      continue;
    }
    const legFill = legResult;

    const id = randomUUID();
    const pos = newOscarPosition({
      id,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      signal,
      leg1: {
        ts: Date.now(),
        grossUsd: legFill.grossUsd,
        marginUsd: legFill.marginUsd,
        fillPx: legFill.fillPx,
        legIndex: 1,
      },
    });
    state.opens.set(id, pos);
    state.openByCoin.set(coin.coin, id);
    state.openModes.set(id, mode);
    state.lastEntryBarTs.set(coin.coin, signal.barTs);

    const row: OscarJournalRow = {
      kind: 'open',
      ts: Date.now(),
      id,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      legIndex: 1,
      signalPrice: signal.signalPrice,
      fillPx: legFill.fillPx,
      grossUsd: legFill.grossUsd,
      marginUsd: legFill.marginUsd,
      dipPct: signal.dipPct,
      impulsePct: signal.impulsePct,
      windowMin: signal.windowMin,
      mode,
      requestedGrossUsd: legFill.meta.requestedGrossUsd,
      filledGrossUsd: legFill.meta.filledGrossUsd,
      partialFill: legFill.meta.partialFill,
      freeMarginAtOpen: legFill.meta.freeMarginAtOpen,
    };
    appendOscarJournal(cfg.journalPath, row);
    console.log(
      `[hl-oscar-perp] OPEN ${coin.coin} dip=${signal.dipPct.toFixed(1)}% imp=${signal.impulsePct.toFixed(1)}% $${legFill.grossUsd.toFixed(0)} @ ${legFill.fillPx}`,
    );
    await notifyOscarOpen({
      cfg,
      sym: coin.displaySymbol,
      legIndex: 1,
      fillPx: legFill.fillPx,
      grossUsd: legFill.grossUsd,
      dipPct: signal.dipPct,
      impulsePct: signal.impulsePct,
      windowMin: signal.windowMin,
    });
  }
}

async function processOpenPosition(
  cfg: HlOscarPerpConfig,
  client: HlTwapExchangeClient,
  state: OscarTraderState,
  pos: OscarOpenPosition,
  lookbackHours: number,
  mode: 'dry_run' | 'live',
): Promise<void> {
  const candles = await ensureCandles(cfg, state, pos.coin, lookbackHours);
  const last = candles[candles.length - 1];
  if (!last) return;
  const markPx = last.close;
  const lowPx = last.low;
  const highPx = last.high;

  await maybeFillStagedLegs(cfg, client, pos, lowPx, markPx, mode);

  const actions = computeOscarExitActions(pos, cfg, markPx, lowPx, highPx, Date.now());
  for (const action of actions) {
    if (action.kind === 'none') continue;
    if (action.kind === 'partial') {
      const res = await reducePosition(client, pos, action.fraction, markPx);
      if (!res) continue;
      pos.remainingFraction *= 1 - action.fraction;
      pos.realizedPnlUsd += res.pnlUsd;
      appendOscarJournal(cfg.journalPath, {
        kind: 'partial_exit',
        ts: Date.now(),
        id: pos.id,
        coin: pos.coin,
        reason: action.reason,
        fraction: action.fraction,
        fillPx: res.fillPx,
        notionalUsd: res.notionalUsd,
        pnlUsd: res.pnlUsd,
        remainingFraction: pos.remainingFraction,
        mode,
      });
      await notifyOscarPartialExit({
        cfg,
        sym: pos.displaySymbol,
        reason: action.reason,
        fillPx: res.fillPx,
        pnlUsd: res.pnlUsd,
        fraction: action.fraction,
        remainingFraction: pos.remainingFraction,
        level: action.level,
      });
      if (shouldRemainderFlush(pos.remainingFraction, cfg.remainderClosePct)) {
        const flushRes = await reducePosition(client, pos, 1, markPx);
        const exitPx = flushRes?.fillPx ?? markPx;
        if (flushRes) pos.realizedPnlUsd += flushRes.pnlUsd;
        await finalizeClose(cfg, state, pos, 'REMAINDER_FLUSH', exitPx, mode);
        break;
      }
      if (pos.remainingFraction <= 1e-6) {
        await finalizeClose(cfg, state, pos, action.reason, res.fillPx, mode);
      }
    } else if (action.kind === 'full') {
      const res = await reducePosition(client, pos, pos.remainingFraction, markPx);
      const exitPx = res?.fillPx ?? markPx;
      if (res) pos.realizedPnlUsd += res.pnlUsd;
      await finalizeClose(cfg, state, pos, action.reason, exitPx, mode);
      break;
    }
  }
}

async function maybeFillStagedLegs(
  cfg: HlOscarPerpConfig,
  client: HlTwapExchangeClient,
  pos: OscarOpenPosition,
  lowPx: number,
  markPx: number,
  mode: 'dry_run' | 'live',
): Promise<void> {
  if (!cfg.stagedEntryEnabled || cfg.leg2GrossUsd <= 0) return;

  let accountMargin: Awaited<ReturnType<typeof fetchHlClearinghouseMargin>> | null = null;
  if (client.mode === 'live') {
    try {
      accountMargin = await fetchHlClearinghouseMargin(client.accountAddress());
    } catch (e) {
      console.warn('[hl-oscar-perp] margin fetch failed (staged leg)', String(e));
    }
  }

  const leg2Px = pos.signalPrice * (1 - cfg.leg2DropPct / 100);
  if (!pos.leg2Filled && lowPx <= leg2Px) {
    const legResult = await tryOscarBuyLeg({
      client,
      coin: pos.coin,
      displaySymbol: pos.displaySymbol,
      grossUsd: cfg.leg2GrossUsd,
      leverage: cfg.leverage,
      markPx,
      marginReserveUsd: cfg.marginReserveUsd,
      accountMargin,
      logPrefix: '[hl-oscar-perp]',
      intent: 'dca',
    });
    if (!legResult.ok) {
      if (legResult.reason !== 'order_failed') {
        appendOscarJournal(
          cfg.journalPath,
          journalSkipFromBuyReject(pos.coin, `leg2_${legResult.reason}`, legResult.meta),
        );
      }
      return;
    }
    pos.legs.push({
      ts: Date.now(),
      grossUsd: legResult.grossUsd,
      marginUsd: legResult.marginUsd,
      fillPx: legResult.fillPx,
      legIndex: 2,
    });
    pos.leg2Filled = true;
    recomputeAvgEntry(pos);
    appendOscarJournal(cfg.journalPath, {
      kind: 'add_leg',
      ts: Date.now(),
      id: pos.id,
      coin: pos.coin,
      legIndex: 2,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      marginUsd: legResult.marginUsd,
      avgEntryPx: pos.avgEntryPx,
      mode,
    });
    console.log(`[hl-oscar-perp] LEG2 ${pos.coin} @ ${legResult.fillPx.toFixed(4)}`);
    await notifyOscarAddLeg({
      cfg,
      sym: pos.displaySymbol,
      legIndex: 2,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      avgEntryPx: pos.avgEntryPx,
    });
  }

  if (cfg.leg3GrossUsd <= 0) return;

  const leg3Px = pos.signalPrice * (1 - cfg.leg3DropPct / 100);
  if (!pos.leg3Filled && lowPx <= leg3Px) {
    const legResult = await tryOscarBuyLeg({
      client,
      coin: pos.coin,
      displaySymbol: pos.displaySymbol,
      grossUsd: cfg.leg3GrossUsd,
      leverage: cfg.leverage,
      markPx,
      marginReserveUsd: cfg.marginReserveUsd,
      accountMargin,
      logPrefix: '[hl-oscar-perp]',
      intent: 'dca',
    });
    if (!legResult.ok) {
      if (legResult.reason !== 'order_failed') {
        appendOscarJournal(
          cfg.journalPath,
          journalSkipFromBuyReject(pos.coin, `leg3_${legResult.reason}`, legResult.meta),
        );
      }
      return;
    }
    pos.legs.push({
      ts: Date.now(),
      grossUsd: legResult.grossUsd,
      marginUsd: legResult.marginUsd,
      fillPx: legResult.fillPx,
      legIndex: 3,
    });
    pos.leg3Filled = true;
    recomputeAvgEntry(pos);
    appendOscarJournal(cfg.journalPath, {
      kind: 'add_leg',
      ts: Date.now(),
      id: pos.id,
      coin: pos.coin,
      legIndex: 3,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      marginUsd: legResult.marginUsd,
      avgEntryPx: pos.avgEntryPx,
      mode,
    });
    console.log(`[hl-oscar-perp] LEG3 ${pos.coin} @ ${legResult.fillPx.toFixed(4)}`);
    await notifyOscarAddLeg({
      cfg,
      sym: pos.displaySymbol,
      legIndex: 3,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      avgEntryPx: pos.avgEntryPx,
    });
  }
}

async function finalizeClose(
  cfg: HlOscarPerpConfig,
  state: OscarTraderState,
  pos: OscarOpenPosition,
  reason: string,
  exitPx: number,
  mode: 'dry_run' | 'live',
): Promise<void> {
  const pnlPct = pos.totalGrossUsd > 0 ? (pos.realizedPnlUsd / pos.totalGrossUsd) * 100 : 0;
  const holdHours = (Date.now() - pos.entryTs) / 3_600_000;
  appendOscarJournal(cfg.journalPath, {
    kind: 'close',
    ts: Date.now(),
    id: pos.id,
    coin: pos.coin,
    reason,
    exitPx,
    pnlUsd: pos.realizedPnlUsd,
    pnlPct,
    holdHours,
    mode,
  });
  state.opens.delete(pos.id);
  state.openByCoin.delete(pos.coin);
  state.openModes.delete(pos.id);
  console.log(
    `[hl-oscar-perp] CLOSE ${pos.coin} ${reason} pnl=$${pos.realizedPnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
  );
  await notifyOscarClose({
    cfg,
    sym: pos.displaySymbol,
    reason,
    exitPx,
    pnlUsd: pos.realizedPnlUsd,
    pnlPct,
    holdHours,
  });
}

export async function fetchOscarAccountEquity(masterAddress: string): Promise<number> {
  return fetchHlAccountEquityUsd(masterAddress);
}
