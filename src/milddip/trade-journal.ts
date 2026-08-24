/**
 * Cash-accurate trade journal for mild-dip + leaders.
 *
 * Separate from the noisy ops journal (`journal.jsonl`). This file is the
 * source of truth for CF / PnL tests:
 *   data/milddip/trades.jsonl
 *
 * Prefer wallet USDC delta (usdcAfter − usdcBefore). Fall back to Jupiter quote
 * spent/received when the balance peek fails. Never treat mark% as cash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { noteMildDipJournalWriteFailure } from './state.js';
import { rotateMildDipJournal } from './journal-rotation.js';

export const TRADE_JOURNAL_VERSION = 1 as const;

export type TradeActor = 'us' | 'leader';
export type TradeSide = 'buy' | 'sell';

export type TradeFillEvent = {
  v: typeof TRADE_JOURNAL_VERSION;
  kind: 'trade_fill';
  actor: TradeActor;
  wallet: string;
  mint: string;
  symbol?: string | null;
  side: TradeSide;
  ok: boolean;
  signature?: string | null;
  sizeUsdIntent?: number | null;
  quoteSpentUsd?: number | null;
  quoteReceivedUsd?: number | null;
  cashDeltaUsd?: number | null;
  usdcBefore?: number | null;
  usdcAfter?: number | null;
  feeSolBefore?: number | null;
  feeSolAfter?: number | null;
  fillPriceUsd?: number | null;
  /** Mark/quote price-ratio % — NOT cash. Forensics only. */
  markPnlPct?: number | null;
  cashPnlUsd?: number | null;
  costBasisUsd?: number | null;
  fraction?: number | null;
  reason?: string | null;
  lossExitBounceCap?: 'drawdown' | 'trough_age' | null;
  lossReclaimWaitMs?: number | null;
  lossReclaimTargetPct?: number | null;
  dipSource?: string | null;
  source: 'mild_dip' | 'leader_observer';
  leader?: string | null;
  cashSource?: 'wallet_delta' | 'wallet_delta_stale' | 'quote' | 'observed_delta' | 'none' | null;
};

export type TradeRoundtripEvent = {
  v: typeof TRADE_JOURNAL_VERSION;
  kind: 'trade_roundtrip';
  actor: TradeActor;
  wallet: string;
  mint: string;
  symbol?: string | null;
  buyCostUsd: number;
  sellProceedsUsd: number;
  cashPnlUsd: number;
  holdSec?: number | null;
  exitReason?: string | null;
  lossExitBounceCap?: 'drawdown' | 'trough_age' | null;
  openedAtMs?: number | null;
  closedAtMs?: number | null;
  source: 'mild_dip' | 'leader_observer';
  leader?: string | null;
};

type TradeLot = {
  mint: string;
  costUsd: number;
  totalCostUsd: number;
  proceedsUsd: number;
  openedAtMs: number;
};

const lots = new Map<string, TradeLot>();

export function resetTradeLotsForTests(): void {
  lots.clear();
}

/**
 * Seed in-memory lots from open state after process restart so sell cashPnl
 * still has a cost basis (sizeUsd) until the next live buy fill arrives.
 */
export function hydrateTradeLotsFromOpen(
  open: Record<string, { sizeUsd?: number; openedAtMs?: number }>,
  nowMs = Date.now(),
): number {
  let n = 0;
  for (const [mint, pos] of Object.entries(open)) {
    if (lots.has(mint)) continue;
    const cost = Number(pos.sizeUsd) || 0;
    if (!(cost > 0)) continue;
    lots.set(mint, {
      mint,
      costUsd: cost,
      totalCostUsd: cost,
      proceedsUsd: 0,
      openedAtMs: Number(pos.openedAtMs) || nowMs,
    });
    n += 1;
  }
  return n;
}

export function resolveBuyCash(args: {
  usdcBefore?: number | null;
  usdcAfter?: number | null;
  quoteSpentUsd?: number | null;
  sizeUsdIntent?: number | null;
}): { spentUsd: number; cashDeltaUsd: number | null; cashSource: NonNullable<TradeFillEvent['cashSource']> } {
  const before = args.usdcBefore;
  const after = args.usdcAfter;
  if (before != null && after != null && Number.isFinite(before) && Number.isFinite(after)) {
    const delta = after - before;
    if (delta < -1e-6) {
      return { spentUsd: -delta, cashDeltaUsd: delta, cashSource: 'wallet_delta' };
    }
    // Concurrent txs can make buy peeks non-decreasing; never substitute Jupiter quote
    // for wallet cash when before/after were actually sampled.
    const intent =
      args.sizeUsdIntent && args.sizeUsdIntent > 0
        ? args.sizeUsdIntent
        : args.quoteSpentUsd && args.quoteSpentUsd > 0
          ? args.quoteSpentUsd
          : 0;
    return { spentUsd: intent, cashDeltaUsd: delta, cashSource: 'wallet_delta_stale' };
  }
  if (args.quoteSpentUsd != null && args.quoteSpentUsd > 0) {
    return {
      spentUsd: args.quoteSpentUsd,
      cashDeltaUsd: -args.quoteSpentUsd,
      cashSource: 'quote',
    };
  }
  if (args.sizeUsdIntent != null && args.sizeUsdIntent > 0) {
    return {
      spentUsd: args.sizeUsdIntent,
      cashDeltaUsd: -args.sizeUsdIntent,
      cashSource: 'quote',
    };
  }
  return { spentUsd: 0, cashDeltaUsd: null, cashSource: 'none' };
}

export function resolveSellCash(args: {
  usdcBefore?: number | null;
  usdcAfter?: number | null;
  quoteReceivedUsd?: number | null;
}): {
  receivedUsd: number;
  cashDeltaUsd: number | null;
  cashSource: NonNullable<TradeFillEvent['cashSource']>;
} {
  const before = args.usdcBefore;
  const after = args.usdcAfter;
  if (before != null && after != null && Number.isFinite(before) && Number.isFinite(after)) {
    const delta = after - before;
    if (delta > 1e-6) {
      return { receivedUsd: delta, cashDeltaUsd: delta, cashSource: 'wallet_delta' };
    }
    // Stale peek on sell (delta ≤ 0): do not credit Jupiter quote as wallet proceeds.
    return { receivedUsd: 0, cashDeltaUsd: delta, cashSource: 'wallet_delta_stale' };
  }
  if (args.quoteReceivedUsd != null && args.quoteReceivedUsd > 0) {
    return {
      receivedUsd: args.quoteReceivedUsd,
      cashDeltaUsd: args.quoteReceivedUsd,
      cashSource: 'quote',
    };
  }
  return { receivedUsd: 0, cashDeltaUsd: null, cashSource: 'none' };
}

export function allocateSellCost(args: {
  lotCostUsd: number;
  fraction: number;
}): { costBasisUsd: number; remainingCostUsd: number } {
  const frac = args.fraction > 0 && args.fraction < 1 ? args.fraction : 1;
  const costBasisUsd = Math.max(0, args.lotCostUsd * frac);
  return { costBasisUsd, remainingCostUsd: Math.max(0, args.lotCostUsd - costBasisUsd) };
}

export function appendTradeJournal(
  tradesPath: string,
  event: TradeFillEvent | TradeRoundtripEvent | Record<string, unknown>,
): void {
  try {
    const dir = path.dirname(tradesPath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
    rotateMildDipJournal(
      tradesPath,
      Number(process.env.MILD_DIP_TRADES_MAX_BYTES ?? 256 * 1024 * 1024),
      Buffer.byteLength(line),
    );
    fs.appendFileSync(
      tradesPath,
      line,
      'utf8',
    );
  } catch (err) {
    noteMildDipJournalWriteFailure(err);
  }
}

export function noteBuyLot(mint: string, spentUsd: number, nowMs: number): void {
  const prev = lots.get(mint);
  const add = Math.max(0, spentUsd);
  if (!prev) {
    lots.set(mint, {
      mint,
      costUsd: add,
      totalCostUsd: add,
      proceedsUsd: 0,
      openedAtMs: nowMs,
    });
    return;
  }
  prev.costUsd += add;
  prev.totalCostUsd += add;
  lots.set(mint, prev);
}

export function noteSellLot(args: {
  mint: string;
  receivedUsd: number;
  fraction: number;
  nowMs: number;
}): {
  costBasisUsd: number;
  cashPnlUsd: number;
  flat: boolean;
  roundtrip: Omit<
    TradeRoundtripEvent,
    'v' | 'kind' | 'actor' | 'wallet' | 'mint' | 'symbol' | 'source' | 'leader' | 'exitReason'
  > | null;
} {
  const lot = lots.get(args.mint);
  const received = Math.max(0, args.receivedUsd);
  if (!lot) {
    return {
      costBasisUsd: 0,
      cashPnlUsd: received,
      flat: true,
      roundtrip: {
        buyCostUsd: 0,
        sellProceedsUsd: received,
        cashPnlUsd: received,
        holdSec: 0,
        openedAtMs: args.nowMs,
        closedAtMs: args.nowMs,
      },
    };
  }
  const { costBasisUsd, remainingCostUsd } = allocateSellCost({
    lotCostUsd: lot.costUsd,
    fraction: args.fraction,
  });
  lot.costUsd = remainingCostUsd;
  lot.proceedsUsd += received;
  const cashPnlUsd = received - costBasisUsd;
  const flat = remainingCostUsd <= 1e-6 || !(args.fraction > 0 && args.fraction < 1);
  if (flat) {
    const roundtrip = {
      buyCostUsd: +lot.totalCostUsd.toFixed(6),
      sellProceedsUsd: +lot.proceedsUsd.toFixed(6),
      cashPnlUsd: +(lot.proceedsUsd - lot.totalCostUsd).toFixed(6),
      holdSec: Math.max(0, Math.floor((args.nowMs - lot.openedAtMs) / 1000)),
      openedAtMs: lot.openedAtMs,
      closedAtMs: args.nowMs,
    };
    lots.delete(args.mint);
    return { costBasisUsd, cashPnlUsd, flat: true, roundtrip };
  }
  lots.set(args.mint, lot);
  return { costBasisUsd, cashPnlUsd, flat: false, roundtrip: null };
}

export function writeUsBuyFill(args: {
  tradesPath: string;
  wallet: string;
  mint: string;
  symbol?: string | null;
  ok: boolean;
  signature?: string | null;
  sizeUsdIntent: number;
  usdcBefore?: number | null;
  usdcAfter?: number | null;
  feeSolBefore?: number | null;
  feeSolAfter?: number | null;
  quoteSpentUsd?: number | null;
  fillPriceUsd?: number | null;
  reason?: string | null;
  dipSource?: string | null;
  nowMs?: number;
}): TradeFillEvent {
  const cash = resolveBuyCash({
    usdcBefore: args.usdcBefore,
    usdcAfter: args.usdcAfter,
    quoteSpentUsd: args.quoteSpentUsd,
    sizeUsdIntent: args.sizeUsdIntent,
  });
  const ev: TradeFillEvent = {
    v: TRADE_JOURNAL_VERSION,
    kind: 'trade_fill',
    actor: 'us',
    wallet: args.wallet,
    mint: args.mint,
    symbol: args.symbol ?? null,
    side: 'buy',
    ok: args.ok,
    signature: args.signature ?? null,
    sizeUsdIntent: args.sizeUsdIntent,
    quoteSpentUsd: cash.spentUsd > 0 ? +cash.spentUsd.toFixed(6) : null,
    quoteReceivedUsd: null,
    cashDeltaUsd: cash.cashDeltaUsd != null ? +cash.cashDeltaUsd.toFixed(6) : null,
    usdcBefore: args.usdcBefore ?? null,
    usdcAfter: args.usdcAfter ?? null,
    feeSolBefore: args.feeSolBefore ?? null,
    feeSolAfter: args.feeSolAfter ?? null,
    fillPriceUsd: args.fillPriceUsd ?? null,
    markPnlPct: null,
    cashPnlUsd: null,
    costBasisUsd: null,
    fraction: 1,
    reason: args.reason ?? null,
    dipSource: args.dipSource ?? null,
    source: 'mild_dip',
    leader: null,
    cashSource: cash.cashSource,
  };
  appendTradeJournal(args.tradesPath, ev);
  if (args.ok && cash.spentUsd > 0) {
    noteBuyLot(args.mint, cash.spentUsd, args.nowMs ?? Date.now());
  }
  return ev;
}

export function writeUsSellFill(args: {
  tradesPath: string;
  wallet: string;
  mint: string;
  symbol?: string | null;
  ok: boolean;
  signature?: string | null;
  sizeUsdIntent: number;
  fraction: number;
  usdcBefore?: number | null;
  usdcAfter?: number | null;
  feeSolBefore?: number | null;
  feeSolAfter?: number | null;
  quoteReceivedUsd?: number | null;
  fillPriceUsd?: number | null;
  markPnlPct?: number | null;
  reason?: string | null;
  lossExitBounceCap?: 'drawdown' | 'trough_age' | null;
  lossReclaimWaitMs?: number | null;
  lossReclaimTargetPct?: number | null;
  nowMs?: number;
}): { fill: TradeFillEvent; roundtrip: TradeRoundtripEvent | null } {
  const cash = resolveSellCash({
    usdcBefore: args.usdcBefore,
    usdcAfter: args.usdcAfter,
    quoteReceivedUsd: args.quoteReceivedUsd,
  });
  const nowMs = args.nowMs ?? Date.now();
  let costBasisUsd: number | null = null;
  let cashPnlUsd: number | null = null;
  let roundtrip: TradeRoundtripEvent | null = null;

  if (args.ok) {
    const sold = noteSellLot({
      mint: args.mint,
      receivedUsd: cash.receivedUsd,
      fraction: args.fraction,
      nowMs,
    });
    costBasisUsd = +sold.costBasisUsd.toFixed(6);
    cashPnlUsd = +sold.cashPnlUsd.toFixed(6);
    if (sold.roundtrip) {
      roundtrip = {
        v: TRADE_JOURNAL_VERSION,
        kind: 'trade_roundtrip',
        actor: 'us',
        wallet: args.wallet,
        mint: args.mint,
        symbol: args.symbol ?? null,
        ...sold.roundtrip,
        exitReason: args.reason ?? null,
        lossExitBounceCap: args.lossExitBounceCap ?? null,
        source: 'mild_dip',
        leader: null,
      };
    }
  }

  const fill: TradeFillEvent = {
    v: TRADE_JOURNAL_VERSION,
    kind: 'trade_fill',
    actor: 'us',
    wallet: args.wallet,
    mint: args.mint,
    symbol: args.symbol ?? null,
    side: 'sell',
    ok: args.ok,
    signature: args.signature ?? null,
    sizeUsdIntent: args.sizeUsdIntent,
    quoteSpentUsd: null,
    quoteReceivedUsd: cash.receivedUsd > 0 ? +cash.receivedUsd.toFixed(6) : null,
    cashDeltaUsd: cash.cashDeltaUsd != null ? +cash.cashDeltaUsd.toFixed(6) : null,
    usdcBefore: args.usdcBefore ?? null,
    usdcAfter: args.usdcAfter ?? null,
    feeSolBefore: args.feeSolBefore ?? null,
    feeSolAfter: args.feeSolAfter ?? null,
    fillPriceUsd: args.fillPriceUsd ?? null,
    markPnlPct: args.markPnlPct ?? null,
    cashPnlUsd,
    costBasisUsd,
    fraction: args.fraction,
    reason: args.reason ?? null,
    lossExitBounceCap: args.lossExitBounceCap ?? null,
    lossReclaimWaitMs: args.lossReclaimWaitMs ?? null,
    lossReclaimTargetPct: args.lossReclaimTargetPct ?? null,
    dipSource: null,
    source: 'mild_dip',
    leader: null,
    cashSource: cash.cashSource,
  };
  appendTradeJournal(args.tradesPath, fill);
  if (roundtrip) appendTradeJournal(args.tradesPath, roundtrip);
  return { fill, roundtrip };
}

/** Leader fill helper (observer / tests) — uses observed quote deltas as cash. */
export function writeLeaderFill(args: {
  tradesPath: string;
  wallet: string;
  mint: string;
  side: TradeSide;
  signature?: string | null;
  sizeUsd?: number | null;
  fillPriceUsd?: number | null;
  quoteUsdDelta?: number | null;
  markPnlPct?: number | null;
  cashPnlUsd?: number | null;
  costBasisUsd?: number | null;
  reason?: string | null;
  isFlat?: boolean;
  buyCostUsd?: number | null;
  sellProceedsUsd?: number | null;
  holdSec?: number | null;
  openedAtMs?: number | null;
  closedAtMs?: number | null;
}): void {
  const qDelta = args.quoteUsdDelta;
  const spent =
    args.side === 'buy'
      ? qDelta != null && qDelta < 0
        ? -qDelta
        : args.sizeUsd && args.sizeUsd > 0
          ? args.sizeUsd
          : null
      : null;
  const received =
    args.side === 'sell'
      ? qDelta != null && qDelta > 0
        ? qDelta
        : args.sizeUsd && args.sizeUsd > 0
          ? args.sizeUsd
          : null
      : null;
  const fill: TradeFillEvent = {
    v: TRADE_JOURNAL_VERSION,
    kind: 'trade_fill',
    actor: 'leader',
    wallet: args.wallet,
    mint: args.mint,
    side: args.side,
    ok: true,
    signature: args.signature ?? null,
    sizeUsdIntent: args.sizeUsd ?? null,
    quoteSpentUsd: spent != null ? +spent.toFixed(6) : null,
    quoteReceivedUsd: received != null ? +received.toFixed(6) : null,
    cashDeltaUsd: qDelta != null ? +qDelta.toFixed(6) : null,
    fillPriceUsd: args.fillPriceUsd ?? null,
    markPnlPct: args.markPnlPct ?? null,
    cashPnlUsd: args.cashPnlUsd ?? null,
    costBasisUsd: args.costBasisUsd ?? null,
    fraction: 1,
    reason: args.reason ?? null,
    source: 'leader_observer',
    leader: args.wallet,
    cashSource: qDelta != null ? 'observed_delta' : 'quote',
  };
  appendTradeJournal(args.tradesPath, fill);
  if (args.isFlat && args.side === 'sell') {
    const buyCost = args.buyCostUsd ?? args.costBasisUsd ?? 0;
    const proceeds = args.sellProceedsUsd ?? received ?? 0;
    const rt: TradeRoundtripEvent = {
      v: TRADE_JOURNAL_VERSION,
      kind: 'trade_roundtrip',
      actor: 'leader',
      wallet: args.wallet,
      mint: args.mint,
      buyCostUsd: +buyCost.toFixed(6),
      sellProceedsUsd: +proceeds.toFixed(6),
      cashPnlUsd: +(proceeds - buyCost).toFixed(6),
      holdSec: args.holdSec ?? null,
      exitReason: args.reason ?? null,
      openedAtMs: args.openedAtMs ?? null,
      closedAtMs: args.closedAtMs ?? null,
      source: 'leader_observer',
      leader: args.wallet,
    };
    appendTradeJournal(args.tradesPath, rt);
  }
}
