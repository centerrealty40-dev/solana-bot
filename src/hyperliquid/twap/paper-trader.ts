import fs from 'node:fs';
import path from 'node:path';

import type { HyperliquidMarketCache } from './hyperliquid-meta.js';
import { computeTwapSchedule, formatMoscowDateTime, timelineIso } from './twap-schedule.js';
import type { NormalizedTwapSignal, TwapSide } from './types.js';

export type HlTwapPaperOpen = {
  hash: string;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  entryTs: number;
  entryPx: number;
  notionalUsd: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
  paperOpenAtMs: number;
  paperCloseAtMs: number;
  twapStartMs: number;
};

export type HlTwapPaperClose = HlTwapPaperOpen & {
  exitTs: number;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

type JournalSchedule = {
  kind: 'schedule';
  ts: number;
  hash: string;
  openAtMs: number;
  closeAtMs: number;
  twapStartMs: number;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  whaleUser: string;
  minutes: number;
  impactPct: number | null;
};

type JournalScheduleCancel = { kind: 'schedule_cancel'; ts: number; hash: string; reason: string };

type JournalOpen = {
  kind: 'open';
  ts: number;
  hash: string;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  entryPx: number;
  notionalUsd: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
  paperOpenAtMs: number;
  paperCloseAtMs: number;
  twapStartMs: number;
};

type JournalClose = {
  kind: 'close';
  ts: number;
  hash: string;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

type JournalRow = JournalSchedule | JournalScheduleCancel | JournalOpen | JournalClose;

export function paperJournalPath(): string {
  return (
    process.env.HL_TWAP_PAPER_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'hl-twap', 'paper.jsonl')
  );
}

export function paperNotionalUsd(): number {
  const v = Number(process.env.HL_TWAP_PAPER_NOTIONAL_USD ?? 1000);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}

function readJournal(filePath: string): JournalRow[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: JournalRow[] = [];
  for (const ln of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try {
      rows.push(JSON.parse(ln) as JournalRow);
    } catch {
      /* skip */
    }
  }
  return rows;
}

export function loadPaperOpensFromJournal(filePath: string): Map<string, HlTwapPaperOpen> {
  const opens = new Map<string, HlTwapPaperOpen>();
  for (const ev of readJournal(filePath)) {
    if (ev.kind === 'open') {
      opens.set(ev.hash, {
        hash: ev.hash,
        coin: ev.coin,
        displaySymbol: ev.displaySymbol,
        side: ev.side,
        entryTs: ev.ts,
        entryPx: ev.entryPx,
        notionalUsd: ev.notionalUsd,
        impactPct: ev.impactPct,
        whaleUser: ev.whaleUser,
        minutes: ev.minutes,
        paperOpenAtMs: ev.paperOpenAtMs,
        paperCloseAtMs: ev.paperCloseAtMs,
        twapStartMs: ev.twapStartMs,
      });
    } else if (ev.kind === 'close') {
      opens.delete(ev.hash);
    }
  }
  return opens;
}

export function loadPendingSchedules(filePath: string): Map<string, JournalSchedule> {
  const cancelled = new Set<string>();
  const opened = new Set<string>();
  const pending = new Map<string, JournalSchedule>();

  for (const ev of readJournal(filePath)) {
    if (ev.kind === 'schedule_cancel') cancelled.add(ev.hash);
    if (ev.kind === 'open' || ev.kind === 'close') opened.add(ev.hash);
    if (ev.kind === 'schedule') pending.set(ev.hash, ev);
  }
  for (const h of cancelled) pending.delete(h);
  for (const h of opened) pending.delete(h);
  return pending;
}

export function appendPaperJournal(filePath: string, row: JournalRow): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

/** После успешного Telegram OPEN — планируем бумагу на 2-й слайс / до предпоследнего. */
export function schedulePaperTrade(sig: NormalizedTwapSignal): void {
  const filePath = paperJournalPath();
  const opens = loadPaperOpensFromJournal(filePath);
  const pending = loadPendingSchedules(filePath);
  if (opens.has(sig.hash) || pending.has(sig.hash)) return;

  const sched = computeTwapSchedule(sig);
  const row: JournalSchedule = {
    kind: 'schedule',
    ts: Date.now(),
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
  };
  appendPaperJournal(filePath, row);
}

function cancelSchedule(filePath: string, hash: string, reason: string): void {
  const pending = loadPendingSchedules(filePath);
  if (!pending.has(hash)) return;
  appendPaperJournal(filePath, { kind: 'schedule_cancel', ts: Date.now(), hash, reason });
}

function executePaperOpen(sched: JournalSchedule, entryPx: number): HlTwapPaperOpen | null {
  const filePath = paperJournalPath();
  if (entryPx <= 0) return null;
  const notionalUsd = paperNotionalUsd();
  const open: HlTwapPaperOpen = {
    hash: sched.hash,
    coin: sched.coin,
    displaySymbol: sched.displaySymbol,
    side: sched.side,
    entryTs: Date.now(),
    entryPx,
    notionalUsd,
    impactPct: sched.impactPct,
    whaleUser: sched.whaleUser,
    minutes: sched.minutes,
    paperOpenAtMs: sched.openAtMs,
    paperCloseAtMs: sched.closeAtMs,
    twapStartMs: sched.twapStartMs,
  };
  const row: JournalOpen = {
    kind: 'open',
    ts: open.entryTs,
    hash: open.hash,
    coin: open.coin,
    displaySymbol: open.displaySymbol,
    side: open.side,
    entryPx: open.entryPx,
    notionalUsd: open.notionalUsd,
    impactPct: open.impactPct,
    whaleUser: open.whaleUser,
    minutes: open.minutes,
    paperOpenAtMs: open.paperOpenAtMs,
    paperCloseAtMs: open.paperCloseAtMs,
    twapStartMs: open.twapStartMs,
  };
  appendPaperJournal(filePath, row);
  return open;
}

export function closePaperTrade(
  sig: Pick<NormalizedTwapSignal, 'hash' | 'displaySymbol'>,
  exitPx: number,
  exitReason: string,
): HlTwapPaperClose | null {
  const filePath = paperJournalPath();
  const opens = loadPaperOpensFromJournal(filePath);
  const pos = opens.get(sig.hash);
  if (!pos || exitPx <= 0) return null;

  const dir = pos.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((exitPx - pos.entryPx) / pos.entryPx) * 100;
  const pnlUsd = (pnlPct / 100) * pos.notionalUsd;

  appendPaperJournal(filePath, {
    kind: 'close',
    ts: Date.now(),
    hash: pos.hash,
    exitPx,
    pnlUsd,
    pnlPct,
    exitReason,
  });

  return { ...pos, exitTs: Date.now(), exitPx, pnlUsd, pnlPct, exitReason };
}

/** Таймеры: открыть/закрыть по циклам; без лимита позиций. */
export async function processPaperTrades(cache: HyperliquidMarketCache): Promise<void> {
  const filePath = paperJournalPath();
  const now = Date.now();
  const pending = loadPendingSchedules(filePath);
  for (const sched of pending.values()) {
    if (now >= sched.openAtMs) {
      const px = markPxForCoin(sched.coin, cache) || markPxForSymbol(sched.displaySymbol, cache);
      if (px > 0) executePaperOpen(sched, px);
    }
  }

  const opens = loadPaperOpensFromJournal(filePath);
  for (const pos of opens.values()) {
    if (now >= pos.paperCloseAtMs) {
      const px = exitPxForOpen(pos, cache);
      closePaperTrade({ hash: pos.hash, displaySymbol: pos.displaySymbol }, px, 'before_last_cycle');
    }
  }
}

/** Sell-TWAP того же кита по той же монете — закрыть все бумажные long по этой паре. */
export function closePaperForWhaleSellReversal(
  sig: Pick<NormalizedTwapSignal, 'user' | 'coin' | 'displaySymbol'>,
  cache: HyperliquidMarketCache,
): number {
  const filePath = paperJournalPath();
  const opens = loadPaperOpensFromJournal(filePath);
  const user = sig.user.toLowerCase();
  let closed = 0;
  for (const pos of opens.values()) {
    if (pos.whaleUser.toLowerCase() !== user || pos.coin !== sig.coin) continue;
    const px = exitPxForOpen(pos, cache);
    if (closePaperTrade({ hash: pos.hash, displaySymbol: pos.displaySymbol }, px, 'whale_sell_reversal')) {
      closed += 1;
    }
  }
  return closed;
}

/** TWAP завершился раньше планового close — закрыть бумагу или снять schedule. */
export function handlePaperOnTwapEnd(
  sig: NormalizedTwapSignal,
  cache: HyperliquidMarketCache,
  endedStatus: string,
): void {
  const filePath = paperJournalPath();
  const opens = loadPaperOpensFromJournal(filePath);
  if (opens.has(sig.hash)) {
    const px = exitPxForOpen(opens.get(sig.hash)!, cache);
    closePaperTrade(sig, px, `twap_${endedStatus}`);
    return;
  }
  cancelSchedule(filePath, sig.hash, `twap_${endedStatus}_before_open`);
}

export function markPxForCoin(coin: string, cache: HyperliquidMarketCache): number {
  const direct = cache.mids.get(coin);
  if (direct != null && direct > 0) return direct;
  const stripped = coin.includes(':') ? coin.split(':').pop()! : coin.replace(/^@/, '');
  return cache.mids.get(stripped) ?? 0;
}

function markPxForSymbol(symbol: string, cache: HyperliquidMarketCache): number {
  return cache.mids.get(symbol) ?? 0;
}

export function exitPxForOpen(open: HlTwapPaperOpen, cache: HyperliquidMarketCache): number {
  const fromMids = markPxForCoin(open.coin, cache);
  if (fromMids > 0) return fromMids;
  const fromSym = markPxForSymbol(open.displaySymbol, cache);
  if (fromSym > 0) return fromSym;
  return open.entryPx;
}

export function unrealizedUsd(open: HlTwapPaperOpen, markPx: number): number {
  const dir = open.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((markPx - open.entryPx) / open.entryPx) * 100;
  return (pnlPct / 100) * open.notionalUsd;
}

export function buildPaperPositionTimeline(o: HlTwapPaperOpen, markPx: number, pnlUsd: number): Array<{
  ts: string;
  kind: string;
  label: string;
  reason?: string;
}> {
  const dir = o.side === 'buy' ? 'LONG' : 'SHORT';
  return [
    {
      ts: timelineIso(o.twapStartMs, o.entryTs),
      kind: 'strategy_note',
      label: `Telegram OPEN · whale TWAP ${dir}`,
    },
    {
      ts: timelineIso(o.paperOpenAtMs, o.entryTs),
      kind: 'open',
      label: `Paper ${dir} $${o.notionalUsd.toFixed(0)} @ ${o.entryPx.toFixed(4)} (после 1-го цикла)`,
      reason: 'after_cycle_1',
    },
    {
      ts: timelineIso(o.paperCloseAtMs, o.entryTs),
      kind: 'strategy_note',
      label: `Плановый выход перед последним циклом (МСК ${formatMoscowDateTime(o.paperCloseAtMs)})`,
    },
    {
      ts: new Date().toISOString(),
      kind: 'strategy_note',
      label: `Mark ${markPx.toFixed(4)} · uPnL ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} USD`,
    },
  ];
}
