import { randomUUID } from 'node:crypto';

import type { HyperliquidMarketCache } from '../twap/hyperliquid-meta.js';
import { fetchHlAccountEquityUsd, fetchHlClearinghouseMargin } from '../twap/hyperliquid-meta.js';
import type { HlTwapExchangeClient } from '../twap/live/exchange-client.js';
import type { HlOscarMajorsConfig } from './config.js';
import { fetchOscarCandles, type OscarCandle } from './candles.js';
import { cooldownBlocksEntry, evaluateOscarEntry } from './entry-signal.js';
import { computeMajorsExitActions } from './exit-engine.js';
import { evaluateScalpEntry } from './scalp-entry.js';
import { computeScalpExitActions } from './scalp-exit-engine.js';
import { shouldRemainderFlush } from '../oscar-remainder-flush.js';
import { tryOscarBuyLeg } from '../oscar-open-margin.js';
import { flattenCoinOnExchange } from '../twap/live/flatten-position.js';
import {
  appendOscarJournal,
  lastEntryBarTsByCoin,
  loadOscarOpenModesFromJournal,
  loadOscarOpensFromJournal,
  type OscarJournalRow,
} from './journal.js';
import { newOscarPosition, recomputeAvgEntry, type OscarOpenPosition, type OscarTradeMode } from './position-types.js';
import type { OscarUniverseCoin } from './universe.js';
import { isMajorsTradingHalted } from './drawdown.js';
import {
  notifyMajorsAddLeg,
  notifyMajorsClose,
  notifyMajorsOpen,
  notifyMajorsPartialExit,
} from './telegram-notify.js';

export type MajorsTraderState = {
  opens: Map<string, OscarOpenPosition>;
  openByCoin: Map<string, string>;
  openModes: Map<string, 'dry_run' | 'live'>;
  candleCache: Map<string, { candles: OscarCandle[]; loadedAtMs: number }>;
  lastKnifeEntryBarTs: Map<string, number>;
  lastScalpEntryBarTs: Map<string, number>;
  scanOffset: number;
};

export function createMajorsTraderState(journalPath: string): MajorsTraderState {
  const opens = loadOscarOpensFromJournal(journalPath);
  const openModes = loadOscarOpenModesFromJournal(journalPath);
  const openByCoin = new Map<string, string>();
  for (const [id, pos] of opens) openByCoin.set(pos.coin, id);
  return {
    opens,
    openByCoin,
    openModes,
    candleCache: new Map(),
    lastKnifeEntryBarTs: lastEntryBarTsByCoin(journalPath, 'knife'),
    lastScalpEntryBarTs: lastEntryBarTsByCoin(journalPath, 'scalp'),
    scanOffset: 0,
  };
}

function countOpensByTradeMode(state: MajorsTraderState, tradeMode: OscarTradeMode): number {
  let n = 0;
  for (const pos of state.opens.values()) {
    if (pos.tradeMode === tradeMode) n++;
  }
  return n;
}

function strategyModeActive(cfg: HlOscarMajorsConfig, lane: OscarTradeMode): boolean {
  if (lane === 'knife') {
    return cfg.strategyMode === 'knife' || cfg.strategyMode === 'both';
  }
  return (
    (cfg.strategyMode === 'scalp' || cfg.strategyMode === 'both') && cfg.scalp.enabled
  );
}

function executionModeForTrade(
  cfg: HlOscarMajorsConfig,
  tradeMode: OscarTradeMode,
  clientMode: 'dry_run' | 'live',
): 'dry_run' | 'live' {
  if (tradeMode === 'scalp') {
    return cfg.scalp.mode === 'live' && clientMode === 'live' ? 'live' : 'dry_run';
  }
  return clientMode;
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
    console.error(`[hl-oscar-majors] reduce failed ${pos.coin}`, String(e));
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
  cfg: HlOscarMajorsConfig,
  state: MajorsTraderState,
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

export async function runMajorsTraderPass(args: {
  cfg: HlOscarMajorsConfig;
  client: HlTwapExchangeClient;
  cache: HyperliquidMarketCache;
  universe: OscarUniverseCoin[];
  state: MajorsTraderState;
}): Promise<void> {
  const { cfg, client, universe, state } = args;
  const mode = client.mode;
  const lookbackHours = Math.max(
    Math.max(...cfg.dipLookbackWindowsMin) / 60 + 2,
    cfg.scalp.enabled ? cfg.scalp.windowMin / 60 + 26 : 0,
  );

  if (isMajorsTradingHalted(cfg)) {
    console.warn('[hl-oscar-majors] trading halted (drawdown)');
    return;
  }

  for (const pos of state.opens.values()) {
    await processOpenPosition(cfg, client, state, pos, lookbackHours, mode);
  }

  const knifeActive = strategyModeActive(cfg, 'knife');
  const scalpActive = strategyModeActive(cfg, 'scalp');
  if (!knifeActive && !scalpActive) return;

  let accountMargin: Awaited<ReturnType<typeof fetchHlClearinghouseMargin>> | null = null;
  if (client.mode === 'live') {
    try {
      accountMargin = await fetchHlClearinghouseMargin(client.accountAddress());
    } catch (e) {
      console.warn('[hl-oscar-majors] margin fetch failed', String(e));
    }
  }

  const entryCandidates = universe.filter((c) => !state.openByCoin.has(c.coin));
  const batch = rotatingBatch(entryCandidates, state.scanOffset, cfg.scanBatchSize);
  state.scanOffset = (state.scanOffset + batch.length) % Math.max(entryCandidates.length, 1);

  if (scalpActive) {
    await scanScalpEntries({
      cfg,
      client,
      state,
      batch,
      lookbackHours,
      accountMargin,
      clientMode: mode,
    });
  }

  if (knifeActive) {
    await scanKnifeEntries({
      cfg,
      client,
      state,
      batch,
      lookbackHours,
      accountMargin,
      clientMode: mode,
    });
  }
}

async function scanScalpEntries(args: {
  cfg: HlOscarMajorsConfig;
  client: HlTwapExchangeClient;
  state: MajorsTraderState;
  batch: OscarUniverseCoin[];
  lookbackHours: number;
  accountMargin: Awaited<ReturnType<typeof fetchHlClearinghouseMargin>> | null;
  clientMode: 'dry_run' | 'live';
}): Promise<void> {
  const { cfg, client, state, batch, lookbackHours, accountMargin, clientMode } = args;
  const scalp = cfg.scalp;
  const execMode = executionModeForTrade(cfg, 'scalp', clientMode);

  for (const coin of batch) {
    if (state.openByCoin.has(coin.coin)) continue;
    if (state.opens.size >= cfg.maxOpenPositions) break;
    if (countOpensByTradeMode(state, 'scalp') >= scalp.maxOpenPositions) break;

    const candles = await ensureCandles(cfg, state, coin.coin, lookbackHours);
    const signal = evaluateScalpEntry(scalp, coin.coin, candles);
    if (!signal) continue;

    const lastTs = state.lastScalpEntryBarTs.get(coin.coin);
    if (cooldownBlocksEntry(lastTs, signal.barTs, scalp.cooldownMin)) {
      appendOscarJournal(cfg.journalPath, {
        kind: 'signal_skip',
        ts: Date.now(),
        coin: coin.coin,
        reason: 'scalp_cooldown',
      });
      continue;
    }

    const markPx = coin.midPx;
    const legResult = await tryOscarBuyLeg({
      client,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      grossUsd: scalp.grossUsd,
      leverage: scalp.leverage,
      markPx,
      marginReserveUsd: cfg.marginReserveUsd,
      accountMargin: execMode === 'live' ? accountMargin : null,
      logPrefix: '[hl-oscar-majors:scalp]',
      intent: 'open',
    });
    if (!legResult.ok) {
      if (legResult.reason === 'unwind_failed') {
        appendOscarJournal(cfg.journalPath, {
          kind: 'unwind_failed',
          ts: Date.now(),
          coin: coin.coin,
          displaySymbol: coin.displaySymbol,
          filledGrossUsd: legResult.meta.filledGrossUsd,
          remainingAbsSize: legResult.unwindRemainingAbsSize ?? 0,
          mode: execMode,
        });
      } else if (legResult.reason !== 'order_failed') {
        appendOscarJournal(
          cfg.journalPath,
          journalSkipFromBuyReject(coin.coin, `scalp_${legResult.reason}`, legResult.meta),
        );
      }
      continue;
    }

    const id = randomUUID();
    const pos = newOscarPosition({
      id,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      tradeMode: 'scalp',
      signal: {
        signalPrice: signal.signalPrice,
        barTs: signal.barTs,
        dipPct: signal.dipPct,
        impulsePct: 0,
        windowMin: signal.windowMin,
      },
      leg1: {
        ts: Date.now(),
        grossUsd: legResult.grossUsd,
        marginUsd: legResult.marginUsd,
        fillPx: legResult.fillPx,
        legIndex: 1,
      },
    });
    state.opens.set(id, pos);
    state.openByCoin.set(coin.coin, id);
    state.openModes.set(id, execMode);
    state.lastScalpEntryBarTs.set(coin.coin, signal.barTs);

    appendOscarJournal(cfg.journalPath, {
      kind: 'open',
      ts: Date.now(),
      id,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      legIndex: 1,
      signalPrice: signal.signalPrice,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      marginUsd: legResult.marginUsd,
      dipPct: signal.dipPct,
      impulsePct: 0,
      windowMin: signal.windowMin,
      tradeMode: 'scalp',
      mode: execMode,
      requestedGrossUsd: legResult.meta.requestedGrossUsd,
      filledGrossUsd: legResult.meta.filledGrossUsd,
      partialFill: legResult.meta.partialFill,
      freeMarginAtOpen: legResult.meta.freeMarginAtOpen,
      signalBarTs: signal.barTs,
    } as OscarJournalRow);
    console.log(
      `[hl-oscar-majors:scalp] OPEN ${coin.coin} dip=${signal.dipPct.toFixed(2)}% range=${signal.posIn24hRange?.toFixed(2) ?? 'n/a'} $${legResult.grossUsd.toFixed(0)} @ ${legResult.fillPx} mode=${execMode}`,
    );
    await notifyMajorsOpen({
      cfg,
      sym: coin.displaySymbol,
      legIndex: 1,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      dipPct: signal.dipPct,
      impulsePct: 0,
      windowMin: signal.windowMin,
    });
  }
}

async function scanKnifeEntries(args: {
  cfg: HlOscarMajorsConfig;
  client: HlTwapExchangeClient;
  state: MajorsTraderState;
  batch: OscarUniverseCoin[];
  lookbackHours: number;
  accountMargin: Awaited<ReturnType<typeof fetchHlClearinghouseMargin>> | null;
  clientMode: 'dry_run' | 'live';
}): Promise<void> {
  const { cfg, client, state, batch, lookbackHours, accountMargin, clientMode } = args;

  if (state.opens.size >= cfg.maxOpenPositions) return;
  if (state.opens.size >= cfg.maxConcurrentPositions) return;

  for (const coin of batch) {
    if (state.openByCoin.has(coin.coin)) continue;
    if (state.opens.size >= cfg.maxOpenPositions) break;
    if (state.opens.size >= cfg.maxConcurrentPositions) break;

    const candles = await ensureCandles(cfg, state, coin.coin, lookbackHours);
    const signal = evaluateOscarEntry(cfg, coin.coin, candles);
    if (!signal) continue;

    const lastTs = state.lastKnifeEntryBarTs.get(coin.coin);
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
      logPrefix: '[hl-oscar-majors]',
      intent: 'open',
    });
    if (!legResult.ok) {
      if (legResult.reason === 'unwind_failed') {
        appendOscarJournal(cfg.journalPath, {
          kind: 'unwind_failed',
          ts: Date.now(),
          coin: coin.coin,
          displaySymbol: coin.displaySymbol,
          filledGrossUsd: legResult.meta.filledGrossUsd,
          remainingAbsSize: legResult.unwindRemainingAbsSize ?? 0,
          mode: clientMode,
        });
      } else if (legResult.reason !== 'order_failed') {
        appendOscarJournal(
          cfg.journalPath,
          journalSkipFromBuyReject(coin.coin, legResult.reason, legResult.meta),
        );
      }
      continue;
    }

    const id = randomUUID();
    const pos = newOscarPosition({
      id,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      tradeMode: 'knife',
      signal,
      leg1: {
        ts: Date.now(),
        grossUsd: legResult.grossUsd,
        marginUsd: legResult.marginUsd,
        fillPx: legResult.fillPx,
        legIndex: 1,
      },
    });
    state.opens.set(id, pos);
    state.openByCoin.set(coin.coin, id);
    state.openModes.set(id, clientMode);
    state.lastKnifeEntryBarTs.set(coin.coin, signal.barTs);

    const row: OscarJournalRow = {
      kind: 'open',
      ts: Date.now(),
      id,
      coin: coin.coin,
      displaySymbol: coin.displaySymbol,
      legIndex: 1,
      signalPrice: signal.signalPrice,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      marginUsd: legResult.marginUsd,
      dipPct: signal.dipPct,
      impulsePct: signal.impulsePct,
      windowMin: signal.windowMin,
      tradeMode: 'knife',
      mode: clientMode,
      requestedGrossUsd: legResult.meta.requestedGrossUsd,
      filledGrossUsd: legResult.meta.filledGrossUsd,
      partialFill: legResult.meta.partialFill,
      freeMarginAtOpen: legResult.meta.freeMarginAtOpen,
      signalBarTs: signal.barTs,
    } as OscarJournalRow;
    appendOscarJournal(cfg.journalPath, row);
    console.log(
      `[hl-oscar-majors] OPEN ${coin.coin} dip=${signal.dipPct.toFixed(1)}% imp=${signal.impulsePct.toFixed(1)}% $${legResult.grossUsd.toFixed(0)} @ ${legResult.fillPx}`,
    );
    await notifyMajorsOpen({
      cfg,
      sym: coin.displaySymbol,
      legIndex: 1,
      fillPx: legResult.fillPx,
      grossUsd: legResult.grossUsd,
      dipPct: signal.dipPct,
      impulsePct: signal.impulsePct,
      windowMin: signal.windowMin,
    });
  }
}

async function processOpenPosition(
  cfg: HlOscarMajorsConfig,
  client: HlTwapExchangeClient,
  state: MajorsTraderState,
  pos: OscarOpenPosition,
  lookbackHours: number,
  clientMode: 'dry_run' | 'live',
): Promise<void> {
  const candles = await ensureCandles(cfg, state, pos.coin, lookbackHours);
  const last = candles[candles.length - 1];
  if (!last) return;
  const markPx = last.close;
  const lowPx = last.low;
  const highPx = last.high;
  const mode = state.openModes.get(pos.id) ?? executionModeForTrade(cfg, pos.tradeMode, clientMode);

  if (pos.tradeMode === 'knife') {
    await maybeFillStagedLegs(cfg, client, pos, lowPx, markPx, mode);
  }

  const actions =
    pos.tradeMode === 'scalp'
      ? computeScalpExitActions(
          pos,
          cfg.scalp,
          markPx,
          lowPx,
          highPx,
          Date.now(),
          cfg.remainderClosePct,
        )
      : computeMajorsExitActions(pos, cfg, markPx, lowPx, highPx, Date.now());

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
        tradeMode: pos.tradeMode,
        mode,
      });
      await notifyMajorsPartialExit({
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
        await finalizeClose(cfg, state, pos, 'REMAINDER_FLUSH', exitPx, mode, client);
        break;
      }
      if (pos.remainingFraction <= 1e-6) {
        await finalizeClose(cfg, state, pos, action.reason, res.fillPx, mode, client);
      }
    } else if (action.kind === 'full') {
      const res = await reducePosition(client, pos, pos.remainingFraction, markPx);
      const exitPx = res?.fillPx ?? markPx;
      if (res) pos.realizedPnlUsd += res.pnlUsd;
      await finalizeClose(cfg, state, pos, action.reason, exitPx, mode, client);
      break;
    }
  }
}

async function maybeFillStagedLegs(
  cfg: HlOscarMajorsConfig,
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
      console.warn('[hl-oscar-majors] margin fetch failed (staged leg)', String(e));
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
      logPrefix: '[hl-oscar-majors]',
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
    console.log(`[hl-oscar-majors] LEG2 ${pos.coin} @ ${legResult.fillPx.toFixed(4)}`);
    await notifyMajorsAddLeg({
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
      logPrefix: '[hl-oscar-majors]',
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
    console.log(`[hl-oscar-majors] LEG3 ${pos.coin} @ ${legResult.fillPx.toFixed(4)}`);
    await notifyMajorsAddLeg({
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
  cfg: HlOscarMajorsConfig,
  state: MajorsTraderState,
  pos: OscarOpenPosition,
  reason: string,
  exitPx: number,
  mode: 'dry_run' | 'live',
  client: HlTwapExchangeClient,
): Promise<void> {
  if (mode === 'live') {
    const { flat, remainingAbsSize } = await flattenCoinOnExchange(
      client,
      pos.coin,
      pos.displaySymbol,
      exitPx,
      'close',
    );
    if (!flat) {
      console.error(
        `[hl-oscar-majors] close incomplete ${pos.coin} reason=${reason} remaining=${remainingAbsSize.toFixed(6)} base — keeping in tracker`,
      );
      return;
    }
  }
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
    tradeMode: pos.tradeMode,
    mode,
  });
  state.opens.delete(pos.id);
  state.openByCoin.delete(pos.coin);
  state.openModes.delete(pos.id);
  console.log(
    `[hl-oscar-majors] CLOSE ${pos.coin} ${reason} pnl=$${pos.realizedPnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
  );
  await notifyMajorsClose({
    cfg,
    sym: pos.displaySymbol,
    reason,
    exitPx,
    pnlUsd: pos.realizedPnlUsd,
    pnlPct,
    holdHours,
  });
}

export async function fetchMajorsAccountEquity(masterAddress: string): Promise<number> {
  return fetchHlAccountEquityUsd(masterAddress);
}
