import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import {
  fetchHlClearinghousePositions,
  fetchHlCoinRealizedPnlSince,
  type HlExchangePosition,
} from './twap/hyperliquid-meta.js';
import { flattenCoinOnExchange } from './twap/live/flatten-position.js';
import type { HlTwapExchangeClient } from './twap/live/exchange-client.js';
import { newOscarPosition, recomputeAvgEntry, type OscarOpenPosition } from './oscar-perp/position-types.js';

/** HL clearinghouse positions — ground truth for live Oscar bots. */
export async function fetchHlOpenPositions(masterAddress: string): Promise<HlExchangePosition[]> {
  return fetchHlClearinghousePositions(masterAddress);
}

export type OscarReconcileJournalRow =
  | {
      kind: 'reconcile_adopt';
      ts: number;
      id: string;
      coin: string;
      displaySymbol: string;
      hlNotionalUsd: number;
      hlEntryPx: number;
      reason: 'ORPHAN_ADOPT';
      mode: 'live';
    }
  | {
      kind: 'reconcile_force_close';
      ts: number;
      coin: string;
      displaySymbol: string;
      hlNotionalUsd: number;
      flat: boolean;
      remainingAbsSize: number;
      reason: 'UNKNOWN_ORPHAN' | 'SHORT_ORPHAN';
      mode: 'live';
    }
  | {
      kind: 'reconcile_sync_size';
      ts: number;
      id: string;
      coin: string;
      journalNotionalUsd: number;
      hlNotionalUsd: number;
      mode: 'live';
    }
  | {
      kind: 'unwind_failed';
      ts: number;
      coin: string;
      displaySymbol: string;
      filledGrossUsd: number;
      remainingAbsSize: number;
      mode: 'live';
    };

export type OscarTrackerState = {
  opens: Map<string, OscarOpenPosition>;
  openByCoin: Map<string, string>;
  openModes: Map<string, 'dry_run' | 'live'>;
};

export type OscarReconcileResult = {
  paperClosed: number;
  exchangeOrphans: number;
  adopted: number;
  forceClosed: number;
  synced: number;
};

const NOTIONAL_DRIFT_RATIO = 0.15;

/** Coins that ever had an `open` row in the journal (including closed). */
export function loadCoinsFromJournalHistory(journalPath: string): Set<string> {
  const coins = new Set<string>();
  if (!fs.existsSync(journalPath)) return coins;
  for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.kind === 'open' && typeof row.coin === 'string') coins.add(row.coin);
    } catch {
      /* skip */
    }
  }
  return coins;
}

function entryTsMs(entryTs: number): number {
  if (entryTs > 1e15) return entryTs / 1000;
  if (entryTs > 1e12) return entryTs;
  return entryTs * 1000;
}

async function closePhantomJournalOpen(args: {
  appendJournal: (row: Record<string, unknown>) => void;
  state: OscarTrackerState;
  pos: OscarOpenPosition;
  reason: 'PAPER_STALE' | 'EXCHANGE_ORPHAN';
  masterAddress?: string;
}): Promise<void> {
  const { appendJournal, state, pos, reason, masterAddress } = args;
  const holdHours = (Date.now() - entryTsMs(pos.entryTs)) / 3_600_000;
  let pnlUsd = 0;
  let exitPx = pos.avgEntryPx;

  if (reason === 'EXCHANGE_ORPHAN' && masterAddress) {
    try {
      const sinceMs = entryTsMs(pos.entryTs) - 60_000;
      const hl = await fetchHlCoinRealizedPnlSince(masterAddress, pos.coin, sinceMs);
      if (hl.exitPx != null) exitPx = hl.exitPx;
      pnlUsd = hl.pnlUsd !== 0 ? hl.pnlUsd : pos.realizedPnlUsd;
    } catch {
      pnlUsd = pos.realizedPnlUsd;
    }
  }

  const pnlPct = pos.totalGrossUsd > 0 ? (pnlUsd / pos.totalGrossUsd) * 100 : 0;
  appendJournal({
    kind: 'close',
    ts: Date.now(),
    id: pos.id,
    coin: pos.coin,
    reason,
    exitPx,
    pnlUsd,
    pnlPct,
    holdHours,
    mode: 'live',
  });
  state.opens.delete(pos.id);
  state.openByCoin.delete(pos.coin);
  state.openModes.delete(pos.id);
}

function adoptHlPosition(args: {
  ex: HlExchangePosition;
  leverage: number;
  state: OscarTrackerState;
  appendJournal: (row: Record<string, unknown>) => void;
}): string {
  const { ex, leverage, state, appendJournal } = args;
  const id = randomUUID();
  const marginUsd = ex.notionalUsd / Math.max(1, leverage);
  const pos = newOscarPosition({
    id,
    coin: ex.coin,
    displaySymbol: ex.displaySymbol,
    signal: {
      signalPrice: ex.entryPx,
      barTs: Date.now(),
      dipPct: 0,
      impulsePct: 0,
      windowMin: 0,
    },
    leg1: {
      ts: Date.now(),
      grossUsd: ex.notionalUsd,
      marginUsd,
      fillPx: ex.entryPx,
      legIndex: 1,
    },
  });
  state.opens.set(id, pos);
  state.openByCoin.set(ex.coin, id);
  state.openModes.set(id, 'live');
  appendJournal({
    kind: 'reconcile_adopt',
    ts: Date.now(),
    id,
    coin: ex.coin,
    displaySymbol: ex.displaySymbol,
    hlNotionalUsd: ex.notionalUsd,
    hlEntryPx: ex.entryPx,
    reason: 'ORPHAN_ADOPT',
    mode: 'live',
  });
  return id;
}

function syncPositionNotional(
  pos: OscarOpenPosition,
  hlNotionalUsd: number,
  appendJournal: (row: Record<string, unknown>) => void,
): void {
  const journalNtl = pos.totalGrossUsd * pos.remainingFraction;
  if (journalNtl <= 0) {
    pos.totalGrossUsd = hlNotionalUsd;
    if (pos.legs.length > 0) pos.legs[0]!.grossUsd = hlNotionalUsd;
    recomputeAvgEntry(pos);
    return;
  }
  const drift = Math.abs(hlNotionalUsd - journalNtl) / journalNtl;
  if (drift <= NOTIONAL_DRIFT_RATIO) return;
  const scale = hlNotionalUsd / journalNtl;
  pos.totalGrossUsd *= scale;
  for (const leg of pos.legs) leg.grossUsd *= scale;
  recomputeAvgEntry(pos);
  appendJournal({
    kind: 'reconcile_sync_size',
    ts: Date.now(),
    id: pos.id,
    coin: pos.coin,
    journalNotionalUsd: journalNtl,
    hlNotionalUsd,
    mode: 'live',
  });
}

async function forceCloseUnknownHlPosition(args: {
  client: HlTwapExchangeClient;
  ex: HlExchangePosition;
  markPx: number;
  appendJournal: (row: Record<string, unknown>) => void;
  reason: 'UNKNOWN_ORPHAN' | 'SHORT_ORPHAN';
}): Promise<boolean> {
  const { client, ex, markPx, appendJournal, reason } = args;
  const { flat, remainingAbsSize } = await flattenCoinOnExchange(
    client,
    ex.coin,
    ex.displaySymbol,
    markPx,
    'close',
  );
  appendJournal({
    kind: 'reconcile_force_close',
    ts: Date.now(),
    coin: ex.coin,
    displaySymbol: ex.displaySymbol,
    hlNotionalUsd: ex.notionalUsd,
    flat,
    remainingAbsSize,
    reason,
    mode: 'live',
  });
  return flat;
}

/**
 * Reconcile internal tracker with HL clearinghouse (ground truth).
 * Runs every tick in live mode and at startup.
 */
export async function reconcileWithTracker(args: {
  logPrefix: string;
  mode: 'dry_run' | 'live';
  masterAddress: string;
  client: HlTwapExchangeClient;
  state: OscarTrackerState;
  universeCoins: Set<string>;
  journalCoins: Set<string>;
  leverage: number;
  markPxByCoin: Map<string, number>;
  appendJournal: (row: Record<string, unknown>) => void;
  /** When true, also purge dry_run journal opens (startup). */
  purgePaperOpens?: boolean;
}): Promise<OscarReconcileResult> {
  const result: OscarReconcileResult = {
    paperClosed: 0,
    exchangeOrphans: 0,
    adopted: 0,
    forceClosed: 0,
    synced: 0,
  };
  if (args.mode !== 'live') return result;

  if (args.purgePaperOpens) {
    for (const [, pos] of [...args.state.opens.entries()]) {
      if (args.state.openModes.get(pos.id) !== 'dry_run') continue;
      await closePhantomJournalOpen({
        appendJournal: args.appendJournal,
        state: args.state,
        pos,
        reason: 'PAPER_STALE',
        masterAddress: args.masterAddress,
      });
      result.paperClosed += 1;
      console.warn(
        `${args.logPrefix}:reconcile closed paper journal open ${pos.coin} (${pos.id.slice(0, 8)})`,
      );
    }
  }

  const onExchange = await fetchHlOpenPositions(args.masterAddress);
  const hlByCoin = new Map<string, HlExchangePosition>();
  for (const ex of onExchange) {
    if (ex.side === 'buy') hlByCoin.set(ex.coin, ex);
    else {
      const markPx = args.markPxByCoin.get(ex.coin) ?? ex.entryPx;
      console.warn(
        `${args.logPrefix}:reconcile unexpected short ${ex.displaySymbol} ~$${ex.notionalUsd.toFixed(0)} — force close`,
      );
      const flat = await forceCloseUnknownHlPosition({
        client: args.client,
        ex,
        markPx,
        appendJournal: args.appendJournal,
        reason: 'SHORT_ORPHAN',
      });
      if (flat) result.forceClosed += 1;
    }
  }

  for (const [id, pos] of [...args.state.opens.entries()]) {
    if (args.state.openModes.get(id) !== 'live') continue;
    const ex = hlByCoin.get(pos.coin);
    if (ex) continue;
    await closePhantomJournalOpen({
      appendJournal: args.appendJournal,
      state: args.state,
      pos,
      reason: 'EXCHANGE_ORPHAN',
      masterAddress: args.masterAddress,
    });
    result.exchangeOrphans += 1;
    console.warn(
      `${args.logPrefix}:reconcile closed journal orphan ${pos.coin} (${id.slice(0, 8)}) — missing on HL`,
    );
  }

  for (const [coin, ex] of hlByCoin) {
    const trackedId = args.state.openByCoin.get(coin);
    if (trackedId) {
      const pos = args.state.opens.get(trackedId);
      if (pos) {
        const hlNtl = ex.notionalUsd;
        const before = pos.totalGrossUsd * pos.remainingFraction;
        syncPositionNotional(pos, hlNtl, args.appendJournal);
        const after = pos.totalGrossUsd * pos.remainingFraction;
        if (Math.abs(after - before) / Math.max(before, 1) > NOTIONAL_DRIFT_RATIO) {
          result.synced += 1;
          console.log(
            `${args.logPrefix}:reconcile sync ${coin} journal $${before.toFixed(0)} → HL $${hlNtl.toFixed(0)}`,
          );
        }
      }
      continue;
    }

    const manageable = args.universeCoins.has(coin) || args.journalCoins.has(coin);
    if (manageable) {
      adoptHlPosition({
        ex,
        leverage: args.leverage,
        state: args.state,
        appendJournal: args.appendJournal,
      });
      result.adopted += 1;
      console.warn(
        `${args.logPrefix}:reconcile adopted HL orphan ${ex.displaySymbol} ~$${ex.notionalUsd.toFixed(0)} @ ${ex.entryPx}`,
      );
      continue;
    }

    const markPx = args.markPxByCoin.get(coin) ?? ex.entryPx;
    console.warn(
      `${args.logPrefix}:reconcile force-close unknown ${ex.displaySymbol} ~$${ex.notionalUsd.toFixed(0)}`,
    );
    const flat = await forceCloseUnknownHlPosition({
      client: args.client,
      ex,
      markPx,
      appendJournal: args.appendJournal,
      reason: 'UNKNOWN_ORPHAN',
    });
    if (flat) result.forceClosed += 1;
  }

  return result;
}

export function countOpensByMode(state: OscarTrackerState): { live: number; paper: number } {
  let live = 0;
  let paper = 0;
  for (const id of state.opens.keys()) {
    if (state.openModes.get(id) === 'live') live += 1;
    else paper += 1;
  }
  return { live, paper };
}
