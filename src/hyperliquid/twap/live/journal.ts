import fs from 'node:fs';
import path from 'node:path';

import type { TwapSide } from '../types.js';
import type { HlTwapLiveOpen } from './types.js';

export type JournalSchedule = {
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
  whaleNotionalUsd: number | null;
  whaleSize: number | null;
};

type JournalScheduleCancel = { kind: 'schedule_cancel'; ts: number; hash: string; reason: string };

type JournalOpen = {
  kind: 'open';
  ts: number;
  hash: string;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  entryAnchorPx: number;
  avgEntryPx: number;
  initialNotionalUsd: number;
  currentNotionalUsd: number;
  marginUsd?: number;
  entryLeverage?: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
  liveOpenAtMs: number;
  liveCloseAtMs: number;
  twapStartMs: number;
  tpLevelsTaken: number;
  dcaLevelsTaken: number;
  whaleNotionalUsd?: number | null;
  whaleSize?: number | null;
};

type JournalTp = {
  kind: 'tp';
  ts: number;
  hash: string;
  level: number;
  notionalUsd: number;
  fillPx: number;
  currentNotionalUsd: number;
  tpLevelsTaken: number;
};

type JournalDca = {
  kind: 'dca';
  ts: number;
  hash: string;
  level: number;
  notionalUsd: number;
  fillPx: number;
  avgEntryPx: number;
  currentNotionalUsd: number;
  dcaLevelsTaken: number;
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

type JournalOrder = {
  kind: 'order';
  ts: number;
  action: 'open' | 'close' | 'tp' | 'dca';
  coin: string;
  side: TwapSide;
  notionalUsd: number;
  markPx: number;
  reduceOnly: boolean;
  mode: 'dry_run' | 'live';
  fillPx?: number;
  sizeBase?: number;
};

type JournalResidualFlatten = {
  kind: 'residual_flatten';
  ts: number;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  sizeBase: number;
  notionalUsd: number;
  flat: boolean;
  remainingAbsSize: number;
};

export type LiveJournalRow =
  | JournalSchedule
  | JournalScheduleCancel
  | JournalOpen
  | JournalTp
  | JournalDca
  | JournalClose
  | JournalOrder
  | JournalResidualFlatten;

function readJournal(filePath: string): LiveJournalRow[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: LiveJournalRow[] = [];
  for (const ln of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try {
      rows.push(JSON.parse(ln) as LiveJournalRow);
    } catch {
      /* skip */
    }
  }
  return rows;
}

export function appendLiveJournal(filePath: string, row: LiveJournalRow): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

export function loadLiveOpensFromJournal(filePath: string): Map<string, HlTwapLiveOpen> {
  const opens = new Map<string, HlTwapLiveOpen>();
  for (const ev of readJournal(filePath)) {
    if (ev.kind === 'open') {
      opens.set(ev.hash, {
        hash: ev.hash,
        coin: ev.coin,
        displaySymbol: ev.displaySymbol,
        side: ev.side,
        entryTs: ev.ts,
        entryAnchorPx: ev.entryAnchorPx,
        avgEntryPx: ev.avgEntryPx,
        initialNotionalUsd: ev.initialNotionalUsd,
        currentNotionalUsd: ev.currentNotionalUsd,
        marginUsd: ev.marginUsd ?? ev.initialNotionalUsd,
        entryLeverage: ev.entryLeverage ?? 1,
        impactPct: ev.impactPct,
        whaleUser: ev.whaleUser,
        minutes: ev.minutes,
        liveOpenAtMs: ev.liveOpenAtMs,
        liveCloseAtMs: ev.liveCloseAtMs,
        twapStartMs: ev.twapStartMs,
        tpLevelsTaken: ev.tpLevelsTaken,
        dcaLevelsTaken: ev.dcaLevelsTaken,
        whaleNotionalUsd: ev.whaleNotionalUsd ?? null,
        whaleSize: ev.whaleSize ?? null,
      });
    } else if (ev.kind === 'tp') {
      const pos = opens.get(ev.hash);
      if (pos) {
        pos.currentNotionalUsd = ev.currentNotionalUsd;
        pos.tpLevelsTaken = ev.tpLevelsTaken;
      }
    } else if (ev.kind === 'dca') {
      const pos = opens.get(ev.hash);
      if (pos) {
        pos.avgEntryPx = ev.avgEntryPx;
        pos.currentNotionalUsd = ev.currentNotionalUsd;
        pos.dcaLevelsTaken = ev.dcaLevelsTaken;
      }
    } else if (ev.kind === 'close') {
      opens.delete(ev.hash);
    }
  }
  return opens;
}

export function loadPendingLiveSchedules(filePath: string): Map<string, JournalSchedule> {
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

export function journalScheduleRow(
  sched: Omit<JournalSchedule, 'kind' | 'ts'>,
): JournalSchedule {
  return { kind: 'schedule', ts: Date.now(), ...sched };
}

export function journalOpenRow(pos: HlTwapLiveOpen): JournalOpen {
  return {
    kind: 'open',
    ts: pos.entryTs,
    hash: pos.hash,
    coin: pos.coin,
    displaySymbol: pos.displaySymbol,
    side: pos.side,
    entryAnchorPx: pos.entryAnchorPx,
    avgEntryPx: pos.avgEntryPx,
    initialNotionalUsd: pos.initialNotionalUsd,
    currentNotionalUsd: pos.currentNotionalUsd,
    marginUsd: pos.marginUsd,
    entryLeverage: pos.entryLeverage,
    impactPct: pos.impactPct,
    whaleUser: pos.whaleUser,
    minutes: pos.minutes,
    liveOpenAtMs: pos.liveOpenAtMs,
    liveCloseAtMs: pos.liveCloseAtMs,
    twapStartMs: pos.twapStartMs,
    tpLevelsTaken: pos.tpLevelsTaken,
    dcaLevelsTaken: pos.dcaLevelsTaken,
    whaleNotionalUsd: pos.whaleNotionalUsd,
    whaleSize: pos.whaleSize,
  };
}

export function journalTpRow(
  hash: string,
  level: number,
  notionalUsd: number,
  fillPx: number,
  currentNotionalUsd: number,
  tpLevelsTaken: number,
): JournalTp {
  return {
    kind: 'tp',
    ts: Date.now(),
    hash,
    level,
    notionalUsd,
    fillPx,
    currentNotionalUsd,
    tpLevelsTaken,
  };
}

export function journalDcaRow(
  hash: string,
  level: number,
  notionalUsd: number,
  fillPx: number,
  avgEntryPx: number,
  currentNotionalUsd: number,
  dcaLevelsTaken: number,
): JournalDca {
  return {
    kind: 'dca',
    ts: Date.now(),
    hash,
    level,
    notionalUsd,
    fillPx,
    avgEntryPx,
    currentNotionalUsd,
    dcaLevelsTaken,
  };
}

export function journalOrderRow(
  action: JournalOrder['action'],
  params: {
    coin: string;
    side: TwapSide;
    notionalUsd: number;
    markPx: number;
    reduceOnly: boolean;
    mode: 'dry_run' | 'live';
    fillPx?: number;
    sizeBase?: number;
  },
): JournalOrder {
  return { kind: 'order', ts: Date.now(), action, ...params };
}
