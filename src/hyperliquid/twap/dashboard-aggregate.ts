import fs from 'node:fs';
import path from 'node:path';

import {
  displaySymbolFromCoin,
  fetchHlClearinghousePositions,
  loadHyperliquidMarketCache,
} from './hyperliquid-meta.js';
import {
  buildPaperPositionTimeline,
  exitPxForOpen,
  loadPaperOpensFromJournal,
  loadPendingSchedules,
  markPxForCoin,
  paperJournalPath,
  paperNotionalUsd,
  unrealizedUsd,
  type HlTwapPaperClose,
  type HlTwapPaperOpen,
} from './paper-trader.js';
import {
  computeTwapSchedule,
  formatMoscowDateTime,
  HL_TWAP_SLICE_INTERVAL_SEC,
  timelineIso,
} from './twap-schedule.js';

/** Master HL account that holds perp positions (agent wallet trades on its behalf). */
export function hlTwapMasterAddress(): string {
  return (
    process.env.HL_TWAP_MASTER_ADDRESS?.trim() ||
    '0x37adDf55f2d36e34Bb9a8d79546591131FFecdd3'
  ).toLowerCase();
}

/** Dashboard tile 3 reads live journal by default (`data/hl-twap/live.jsonl`). */
export function hlTwapDashboardJsonlPath(): string {
  return (
    process.env.HL_TWAP_DASHBOARD_JSONL?.trim() ||
    process.env.HL_TWAP_LIVE_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'hl-twap', 'live.jsonl')
  );
}

type JournalClose = {
  kind: 'close';
  ts: number;
  hash: string;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

type PaperJournalOpen = {
  kind: 'open';
  ts: number;
  hash: string;
  coin: string;
  displaySymbol: string;
  side: 'buy' | 'sell';
  entryPx: number;
  notionalUsd: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
  paperOpenAtMs: number;
  paperCloseAtMs: number;
  twapStartMs: number;
};

type LiveJournalOpen = {
  kind: 'open';
  ts: number;
  hash: string;
  coin: string;
  displaySymbol: string;
  side: 'buy' | 'sell';
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
  tpLevelsTaken?: number;
  dcaLevelsTaken?: number;
  whaleNotionalUsd?: number;
};

type LiveJournalRow = {
  kind: string;
  ts: number;
  hash?: string;
  [key: string]: unknown;
};

type LiveOpenState = {
  hash: string;
  coin: string;
  displaySymbol: string;
  side: 'buy' | 'sell';
  entryTs: number;
  entryAnchorPx: number;
  avgEntryPx: number;
  initialNotionalUsd: number;
  currentNotionalUsd: number;
  marginUsd: number | null;
  entryLeverage: number | null;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
  liveOpenAtMs: number;
  liveCloseAtMs: number;
  twapStartMs: number;
  tpLevelsTaken: number;
  dcaLevelsTaken: number;
};

type LiveCloseState = LiveOpenState & {
  exitTs: number;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

export type HlTwapDashboardExtras = {
  watchMinImpactPct: number;
  watchBuyOnly: boolean;
  paperNotionalUsd: number;
  pendingSchedules: number;
  openLongCount: number;
  openShortCount: number;
  closedLongCount: number;
  closedShortCount: number;
  signalsFeedUrl: string;
  telegramConfigured: boolean;
  liveDryRun: boolean;
  exchangeOpenCount?: number;
  journalOpenCount?: number;
  residualOpenCount?: number;
};

function readAllRows(filePath: string): LiveJournalRow[] {
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

function isLiveJournal(rows: LiveJournalRow[]): boolean {
  return rows.some((r) => r.kind === 'open' && 'avgEntryPx' in r);
}

function readPaperJournal(filePath: string): { opens: PaperJournalOpen[]; closes: JournalClose[] } {
  const opens: PaperJournalOpen[] = [];
  const closes: JournalClose[] = [];
  for (const ev of readAllRows(filePath)) {
    if (ev.kind === 'open' && 'entryPx' in ev) opens.push(ev as unknown as PaperJournalOpen);
    if (ev.kind === 'close') closes.push(ev as unknown as JournalClose);
  }
  return { opens, closes };
}

function loadLiveOpensFromJournal(filePath: string): Map<string, LiveOpenState> {
  const opens = new Map<string, LiveOpenState>();
  for (const ev of readAllRows(filePath)) {
    if (ev.kind === 'open') {
      const o = ev as unknown as LiveJournalOpen;
      opens.set(o.hash, {
        hash: o.hash,
        coin: o.coin,
        displaySymbol: o.displaySymbol,
        side: o.side,
        entryTs: o.ts,
        entryAnchorPx: o.entryAnchorPx,
        avgEntryPx: o.avgEntryPx,
        initialNotionalUsd: o.initialNotionalUsd,
        currentNotionalUsd: o.currentNotionalUsd,
        marginUsd: typeof o.marginUsd === 'number' ? o.marginUsd : null,
        entryLeverage: typeof o.entryLeverage === 'number' ? o.entryLeverage : null,
        impactPct: o.impactPct,
        whaleUser: o.whaleUser,
        minutes: o.minutes,
        liveOpenAtMs: o.liveOpenAtMs,
        liveCloseAtMs: o.liveCloseAtMs,
        twapStartMs: o.twapStartMs,
        tpLevelsTaken: o.tpLevelsTaken ?? 0,
        dcaLevelsTaken: o.dcaLevelsTaken ?? 0,
      });
    } else if (ev.kind === 'tp' && ev.hash) {
      const pos = opens.get(ev.hash);
      if (pos) {
        pos.currentNotionalUsd = Number(ev.currentNotionalUsd) || pos.currentNotionalUsd;
        pos.tpLevelsTaken = Number(ev.tpLevelsTaken) || pos.tpLevelsTaken;
      }
    } else if (ev.kind === 'dca' && ev.hash) {
      const pos = opens.get(ev.hash);
      if (pos) {
        pos.avgEntryPx = Number(ev.avgEntryPx) || pos.avgEntryPx;
        pos.currentNotionalUsd = Number(ev.currentNotionalUsd) || pos.currentNotionalUsd;
        pos.dcaLevelsTaken = Number(ev.dcaLevelsTaken) || pos.dcaLevelsTaken;
      }
    } else if (ev.kind === 'close' && ev.hash) {
      opens.delete(ev.hash);
    }
  }
  return opens;
}

function loadLiveOpenHistory(filePath: string): Map<string, LiveOpenState> {
  const history = new Map<string, LiveOpenState>();
  for (const ev of readAllRows(filePath)) {
    if (ev.kind !== 'open') continue;
    const o = ev as unknown as LiveJournalOpen;
    history.set(o.hash, {
      hash: o.hash,
      coin: o.coin,
      displaySymbol: o.displaySymbol,
      side: o.side,
      entryTs: o.ts,
      entryAnchorPx: o.entryAnchorPx,
      avgEntryPx: o.avgEntryPx,
      initialNotionalUsd: o.initialNotionalUsd,
      currentNotionalUsd: o.currentNotionalUsd,
      marginUsd: typeof o.marginUsd === 'number' ? o.marginUsd : null,
      entryLeverage: typeof o.entryLeverage === 'number' ? o.entryLeverage : null,
      impactPct: o.impactPct,
      whaleUser: o.whaleUser,
      minutes: o.minutes,
      liveOpenAtMs: o.liveOpenAtMs,
      liveCloseAtMs: o.liveCloseAtMs,
      twapStartMs: o.twapStartMs,
      tpLevelsTaken: o.tpLevelsTaken ?? 0,
      dcaLevelsTaken: o.dcaLevelsTaken ?? 0,
    });
  }
  return history;
}

function loadPendingLiveSchedules(filePath: string): Map<string, LiveJournalRow> {
  const cancelled = new Set<string>();
  const opened = new Set<string>();
  const pending = new Map<string, LiveJournalRow>();
  for (const ev of readAllRows(filePath)) {
    if (ev.kind === 'schedule_cancel' && ev.hash) cancelled.add(ev.hash);
    if ((ev.kind === 'open' || ev.kind === 'close') && ev.hash) opened.add(ev.hash);
    if (ev.kind === 'schedule' && ev.hash) pending.set(ev.hash, ev);
  }
  for (const h of cancelled) pending.delete(h);
  for (const h of opened) pending.delete(h);
  return pending;
}

function sideLabel(side: 'buy' | 'sell'): string {
  return side === 'buy' ? 'LONG' : 'SHORT';
}

function hyperliquidTradeUrl(coin: string): string {
  return `https://app.hyperliquid.xyz/trade/${encodeURIComponent(coin)}`;
}

function exitReasonShort(reason: string): string {
  return reason.replace(/^twap_/, '').replace(/_/g, ' ');
}

function hlTwapMeta(
  o: Pick<
    LiveOpenState,
    | 'coin'
    | 'side'
    | 'impactPct'
    | 'whaleUser'
    | 'minutes'
    | 'liveOpenAtMs'
    | 'initialNotionalUsd'
    | 'currentNotionalUsd'
    | 'marginUsd'
    | 'entryLeverage'
    | 'twapStartMs'
  >,
  sched: ReturnType<typeof computeTwapSchedule>,
) {
  const dir = sideLabel(o.side);
  return {
    hyperliquidUrl: hyperliquidTradeUrl(o.coin),
    sideLabel: dir,
    entryReasonShort: `Whale TWAP ${dir} · impact ${o.impactPct != null ? o.impactPct.toFixed(1) : '?'}% · ${o.whaleUser.slice(0, 10)}…`,
    entryAtMs: o.liveOpenAtMs,
    twapMinutes: o.minutes,
    cycleCount: sched.cycleCount,
    sliceIntervalSec: HL_TWAP_SLICE_INTERVAL_SEC,
    initialNotionalUsd: o.initialNotionalUsd,
    currentNotionalUsd: o.currentNotionalUsd,
    marginUsd: o.marginUsd,
    entryLeverage: o.entryLeverage,
  };
}

function liveUnrealizedUsd(o: LiveOpenState, markPx: number): number {
  if (markPx <= 0 || o.avgEntryPx <= 0) return 0;
  const dir = o.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((markPx - o.avgEntryPx) / o.avgEntryPx) * 100;
  return (pnlPct / 100) * o.currentNotionalUsd;
}

function buildLiveTimeline(
  filePath: string,
  hash: string,
  o: LiveOpenState,
  markPx: number,
  pnlUsd: number,
): Array<{ ts: string; kind: string; label: string; reason?: string }> {
  const rows = readAllRows(filePath).filter((r) => r.hash === hash);
  const out: Array<{ ts: string; kind: string; label: string; reason?: string }> = [];
  const dir = sideLabel(o.side);

  out.push({
    ts: timelineIso(o.twapStartMs, o.entryTs),
    kind: 'strategy_note',
    label: `Whale TWAP ${dir} · ${o.displaySymbol}`,
  });

  for (const ev of rows) {
    if (ev.kind === 'open') {
      out.push({
        ts: timelineIso(o.liveOpenAtMs, o.entryTs),
        kind: 'open',
        label: `Live ${dir} $${o.initialNotionalUsd.toFixed(0)} @ ${o.avgEntryPx.toFixed(4)}`,
      });
    } else if (ev.kind === 'tp') {
      out.push({
        ts: timelineIso(ev.ts, o.entryTs),
        kind: 'tp',
        label: `TP L${ev.level} $${Number(ev.notionalUsd || 0).toFixed(0)} @ ${Number(ev.fillPx || 0).toFixed(4)}`,
      });
    } else if (ev.kind === 'dca') {
      out.push({
        ts: timelineIso(ev.ts, o.entryTs),
        kind: 'dca',
        label: `DCA L${ev.level} $${Number(ev.notionalUsd || 0).toFixed(0)} @ ${Number(ev.fillPx || 0).toFixed(4)} · avg ${Number(ev.avgEntryPx || 0).toFixed(4)}`,
      });
    } else if (ev.kind === 'order') {
      const action = String(ev.action || '');
      out.push({
        ts: timelineIso(ev.ts, o.entryTs),
        kind: 'order',
        label: `${action.toUpperCase()} ${String(ev.coin || o.coin)} ${String(ev.mode || 'live')} @ ${Number(ev.fillPx ?? ev.markPx ?? 0).toFixed(4)}`,
      });
    } else if (ev.kind === 'close') {
      out.push({
        ts: timelineIso(ev.ts, o.entryTs),
        kind: 'close',
        label: `Closed @ ${Number(ev.exitPx || 0).toFixed(4)} · ${Number(ev.pnlUsd || 0) >= 0 ? '+' : ''}${Number(ev.pnlUsd || 0).toFixed(2)} USD`,
        reason: String(ev.exitReason || ''),
      });
    }
  }

  if (markPx > 0) {
    out.push({
      ts: new Date().toISOString(),
      kind: 'strategy_note',
      label: `Mark ${markPx.toFixed(4)} · uPnL ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} USD`,
    });
  }

  return out;
}

function enrichPaperClose(
  c: JournalClose,
  openByHash: Map<string, PaperJournalOpen>,
): HlTwapPaperClose | null {
  const o = openByHash.get(c.hash);
  if (!o) return null;
  const entryTs = Number.isFinite(o.ts) ? o.ts : 0;
  return {
    hash: c.hash,
    coin: o.coin,
    displaySymbol: o.displaySymbol,
    side: o.side,
    entryTs,
    entryPx: o.entryPx,
    notionalUsd: o.notionalUsd,
    impactPct: o.impactPct,
    whaleUser: o.whaleUser,
    minutes: o.minutes,
    paperOpenAtMs: o.paperOpenAtMs,
    paperCloseAtMs: o.paperCloseAtMs,
    twapStartMs: o.twapStartMs,
    exitTs: c.ts,
    exitPx: c.exitPx,
    pnlUsd: c.pnlUsd,
    pnlPct: c.pnlPct,
    exitReason: c.exitReason,
  };
}

function paperClosedTimeline(c: HlTwapPaperClose): Array<{ ts: string; kind: string; label: string; reason?: string }> {
  const dir = sideLabel(c.side);
  return [
    {
      ts: timelineIso(c.twapStartMs, c.entryTs),
      kind: 'strategy_note',
      label: `Telegram OPEN · whale TWAP ${dir}`,
    },
    {
      ts: timelineIso(c.paperOpenAtMs, c.entryTs),
      kind: 'open',
      label: `Paper ${dir} $${c.notionalUsd.toFixed(0)} @ ${c.entryPx.toFixed(4)}`,
    },
    {
      ts: timelineIso(c.paperCloseAtMs, c.entryTs),
      kind: 'strategy_note',
      label: `Плановый выход (МСК ${formatMoscowDateTime(c.paperCloseAtMs)})`,
    },
    {
      ts: timelineIso(c.exitTs, c.entryTs),
      kind: 'close',
      label: `Closed @ ${c.exitPx.toFixed(4)} · ${c.pnlUsd >= 0 ? '+' : ''}${c.pnlUsd.toFixed(2)} USD (${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct.toFixed(2)}%)`,
      reason: c.exitReason,
    },
  ];
}

function matchJournalForExchange(
  coin: string,
  side: 'buy' | 'sell',
  openMap: Map<string, LiveOpenState>,
  openHistory: Map<string, LiveOpenState>,
  closedHashes: Set<string>,
): { journal: LiveOpenState | null; residual: boolean } {
  for (const o of openMap.values()) {
    if (o.coin === coin && o.side === side) return { journal: o, residual: false };
  }
  let best: LiveOpenState | null = null;
  for (const [hash, o] of openHistory) {
    if (o.coin !== coin || o.side !== side || !closedHashes.has(hash)) continue;
    if (!best || o.entryTs > best.entryTs) best = o;
  }
  if (best) return { journal: best, residual: true };
  return { journal: null, residual: true };
}

function useExchangePositionsForDashboard(): boolean {
  const off = process.env.HL_TWAP_DASHBOARD_EXCHANGE?.trim();
  if (off === '0' || off?.toLowerCase() === 'false' || off?.toLowerCase() === 'no') return false;
  if (process.env.VITEST) return false;
  return true;
}

async function buildFromLiveJournal(filePath: string): Promise<Record<string, unknown>> {
  const rows = readAllRows(filePath);
  const openMap = loadLiveOpensFromJournal(filePath);
  const openHistory = loadLiveOpenHistory(filePath);
  const pending = loadPendingLiveSchedules(filePath);
  const closedHashes = new Set(
    rows.filter((r) => r.kind === 'close' && r.hash).map((r) => String(r.hash)),
  );

  let cache = null as Awaited<ReturnType<typeof loadHyperliquidMarketCache>> | null;
  let exchangePositions: Awaited<ReturnType<typeof fetchHlClearinghousePositions>> = [];
  const fetchExchange = useExchangePositionsForDashboard();
  try {
    if (fetchExchange) {
      [cache, exchangePositions] = await Promise.all([
        loadHyperliquidMarketCache(),
        fetchHlClearinghousePositions(hlTwapMasterAddress()),
      ]);
    } else {
      cache = await loadHyperliquidMarketCache();
    }
  } catch {
    try {
      cache = await loadHyperliquidMarketCache();
    } catch {
      cache = null;
    }
    if (fetchExchange) {
      try {
        exchangePositions = await fetchHlClearinghousePositions(hlTwapMasterAddress());
      } catch {
        exchangePositions = [];
      }
    }
  }

  const now = Date.now();
  const journalOpenRows = [...openMap.values()];
  let unrealizedTotal = 0;
  let residualCount = 0;

  const openUi =
    exchangePositions.length > 0
      ? exchangePositions.map((ex) => {
          const markPx = cache ? markPxForCoin(ex.coin, cache) : ex.entryPx;
          const { journal, residual } = matchJournalForExchange(
            ex.coin,
            ex.side,
            openMap,
            openHistory,
            closedHashes,
          );
          if (residual) residualCount += 1;
          const pnlUsd = ex.unrealizedPnlUsd;
          const pnlPct =
            ex.entryPx > 0 && ex.notionalUsd > 0
              ? (pnlUsd / ex.notionalUsd) * 100 * (ex.side === 'buy' ? 1 : -1)
              : 0;
          unrealizedTotal += pnlUsd;

          if (journal) {
            const sched = computeTwapSchedule({
              size: 0,
              minutes: Math.max(1, journal.minutes || 1),
              randomize: false,
              midPx: journal.avgEntryPx > 0 ? journal.avgEntryPx : ex.entryPx || 1,
              startedAtMs: journal.twapStartMs,
            });
            return {
              mint: journal.hash,
              symbol: journal.displaySymbol,
              side: journal.side,
              entryTs: journal.entryTs,
              entryPx: ex.entryPx,
              markPx: markPx || ex.entryPx,
              impactPct: journal.impactPct,
              whaleUser: journal.whaleUser,
              minutes: journal.minutes,
              notionalUsd: ex.notionalUsd,
              ageMin: (now - journal.entryTs) / 60_000,
              pnlPct,
              pnlUsd,
              remainingCostBasisUsd: ex.notionalUsd,
              hlTwap: {
                ...hlTwapMeta(
                  { ...journal, initialNotionalUsd: ex.notionalUsd, currentNotionalUsd: ex.notionalUsd },
                  sched,
                ),
                residual,
                entryReasonShort: residual
                  ? `${journal.displaySymbol} · остаток на бирже (журнал: closed)`
                  : undefined,
              },
              timeline: buildLiveTimeline(filePath, journal.hash, journal, markPx || ex.entryPx, pnlUsd),
            };
          }

          const displaySymbol = ex.displaySymbol || displaySymbolFromCoin(ex.coin);
          return {
            mint: `exchange:${ex.coin}:${ex.side}`,
            symbol: displaySymbol,
            side: ex.side,
            entryTs: now,
            entryPx: ex.entryPx,
            markPx: markPx || ex.entryPx,
            impactPct: null,
            whaleUser: '',
            minutes: 0,
            notionalUsd: ex.notionalUsd,
            ageMin: 0,
            pnlPct,
            pnlUsd,
            remainingCostBasisUsd: ex.notionalUsd,
            hlTwap: {
              hyperliquidUrl: hyperliquidTradeUrl(ex.coin),
              sideLabel: sideLabel(ex.side),
              entryReasonShort: `${displaySymbol} · позиция на бирже (нет цикла в журнале)`,
              entryAtMs: now,
              twapMinutes: 0,
              cycleCount: 0,
              sliceIntervalSec: HL_TWAP_SLICE_INTERVAL_SEC,
              initialNotionalUsd: ex.notionalUsd,
              currentNotionalUsd: ex.notionalUsd,
              marginUsd: null,
              entryLeverage: null,
              residual: true,
            },
            timeline: [
              {
                ts: new Date().toISOString(),
                kind: 'strategy_note',
                label: `Exchange ${sideLabel(ex.side)} · $${ex.notionalUsd.toFixed(0)} @ ${ex.entryPx.toFixed(4)} · uPnL ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} USD`,
              },
            ],
          };
        })
      : journalOpenRows.map((o) => {
          const markPx = cache ? markPxForCoin(o.coin, cache) : o.avgEntryPx;
          const pnlUsd = liveUnrealizedUsd(o, markPx);
          const dir = o.side === 'buy' ? 1 : -1;
          const pnlPct = o.avgEntryPx > 0 ? dir * ((markPx - o.avgEntryPx) / o.avgEntryPx) * 100 : 0;
          unrealizedTotal += pnlUsd;
          const sched = computeTwapSchedule({
            size: 0,
            minutes: Math.max(1, o.minutes || 1),
            randomize: false,
            midPx: o.avgEntryPx > 0 ? o.avgEntryPx : 1,
            startedAtMs: o.twapStartMs,
          });
          return {
            mint: o.hash,
            symbol: o.displaySymbol,
            side: o.side,
            entryTs: o.entryTs,
            entryPx: o.avgEntryPx,
            markPx,
            impactPct: o.impactPct,
            whaleUser: o.whaleUser,
            minutes: o.minutes,
            notionalUsd: o.currentNotionalUsd,
            ageMin: (now - o.entryTs) / 60_000,
            pnlPct,
            pnlUsd,
            remainingCostBasisUsd: o.currentNotionalUsd,
            hlTwap: hlTwapMeta(o, sched),
            timeline: buildLiveTimeline(filePath, o.hash, o, markPx, pnlUsd),
          };
        });

  const closedEnriched: LiveCloseState[] = [];
  for (const ev of rows) {
    if (ev.kind !== 'close' || !ev.hash) continue;
    const o = openHistory.get(ev.hash);
    if (!o) continue;
    closedEnriched.push({
      ...o,
      exitTs: Number(ev.ts),
      exitPx: Number(ev.exitPx),
      pnlUsd: Number(ev.pnlUsd),
      pnlPct: Number(ev.pnlPct),
      exitReason: String(ev.exitReason || ''),
    });
  }

  const realized = closedEnriched.reduce((s, c) => s + c.pnlUsd, 0);
  const wins = closedEnriched.filter((c) => c.pnlUsd > 0).length;
  const firstTs =
    rows.length > 0
      ? Math.min(...rows.map((r) => Number(r.ts)).filter(Number.isFinite))
      : now;

  const exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }> = {};
  for (const c of closedEnriched) {
    const key = c.exitReason.replace(/^twap_/, '').toUpperCase() || 'OTHER';
    const slot = exitsBreakdown[key] ?? { count: 0, sumPct: 0, sumUsd: 0, avgPct: 0 };
    slot.count += 1;
    slot.sumPct += c.pnlPct;
    slot.sumUsd += c.pnlUsd;
    exitsBreakdown[key] = slot;
  }
  for (const k of Object.keys(exitsBreakdown)) {
    const s = exitsBreakdown[k]!;
    s.avgPct = s.count ? s.sumPct / s.count : 0;
  }

  const recentClosed = closedEnriched
    .slice(-40)
    .reverse()
    .map((c) => {
      const sched = computeTwapSchedule({
        size: 0,
        minutes: Math.max(1, c.minutes || 1),
        randomize: false,
        midPx: c.avgEntryPx > 0 ? c.avgEntryPx : 1,
        startedAtMs: c.twapStartMs,
      });
      return {
        mint: c.hash,
        symbol: c.displaySymbol,
        side: c.side,
        entryTs: c.entryTs,
        exitTs: c.exitTs,
        entryPx: c.avgEntryPx,
        exitPx: c.exitPx,
        pnlPct: c.pnlPct,
        pnlUsd: c.pnlUsd,
        exitReason: c.exitReason,
        impactPct: c.impactPct,
        whaleUser: c.whaleUser,
        notionalUsd: c.initialNotionalUsd,
        durationMin: (c.exitTs - c.entryTs) / 60_000,
        hlTwap: {
          ...hlTwapMeta(c, sched),
          exitReasonShort: exitReasonShort(c.exitReason),
        },
        timeline: buildLiveTimeline(filePath, c.hash, c, c.exitPx, 0),
      };
    });

  const minImpact = Number(process.env.HL_TWAP_MIN_IMPACT_PCT_HOUR ?? process.env.HL_TWAP_MIN_VOLUME_SHARE_PCT ?? 2);
  const buyOnlyEnv = process.env.HL_TWAP_BUY_ONLY?.trim();
  const watchBuyOnly =
    buyOnlyEnv === '1' || buyOnlyEnv?.toLowerCase() === 'true' || buyOnlyEnv?.toLowerCase() === 'yes';
  const dryRunEnv = process.env.HL_TWAP_LIVE_DRY_RUN?.trim();
  const liveDryRun =
    dryRunEnv === '1' || dryRunEnv?.toLowerCase() === 'true' || dryRunEnv?.toLowerCase() === 'yes';

  return {
    strategyId: 'hl-twap-paper',
    file: filePath,
    openCount: openUi.length,
    closedCount: closedEnriched.length,
    startedAt: firstTs,
    lastTs: now,
    hoursOfData: Math.max(0, (now - firstTs) / 3_600_000),
    sumPnlUsd: realized,
    realizedPnlUsd: realized,
    unrealizedPnlUsd: unrealizedTotal,
    totalPnlUsd: realized + unrealizedTotal,
    winRate: closedEnriched.length ? wins / closedEnriched.length : 0,
    avgPnl: closedEnriched.length ? realized / closedEnriched.length : 0,
    avgPeak: 0,
    bestPnlUsd: closedEnriched.length ? Math.max(...closedEnriched.map((c) => c.pnlUsd)) : 0,
    worstPnlUsd: closedEnriched.length ? Math.min(...closedEnriched.map((c) => c.pnlUsd)) : 0,
    unrealizedUsd: unrealizedTotal,
    exits: Object.fromEntries(Object.entries(exitsBreakdown).map(([k, v]) => [k, v.count])),
    exitsBreakdown,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    open: openUi,
    recentClosed,
    priorityFeeUsdTotal: 0,
    priceVerify: { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
    hlTwap: {
      watchMinImpactPct: Number.isFinite(minImpact) ? minImpact : 1,
      watchBuyOnly,
      paperNotionalUsd: paperNotionalUsd(),
      pendingSchedules: pending.size,
      openLongCount: openUi.filter((o) => o.side === 'buy').length,
      openShortCount: openUi.filter((o) => o.side === 'sell').length,
      closedLongCount: closedEnriched.filter((c) => c.side === 'buy').length,
      closedShortCount: closedEnriched.filter((c) => c.side === 'sell').length,
      exchangeOpenCount: exchangePositions.length,
      journalOpenCount: journalOpenRows.length,
      residualOpenCount: residualCount,
      signalsFeedUrl: 'https://api.hypurrscan.io/twap/*',
      telegramConfigured: Boolean(
        process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() && process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim(),
      ),
      liveDryRun,
    },
  };
}

async function buildFromPaperJournal(filePath: string): Promise<Record<string, unknown>> {
  const journal = readPaperJournal(filePath);
  const openMap = loadPaperOpensFromJournal(filePath);
  const pending = loadPendingSchedules(filePath);
  let cache = null as Awaited<ReturnType<typeof loadHyperliquidMarketCache>> | null;
  try {
    cache = await loadHyperliquidMarketCache();
  } catch {
    cache = null;
  }

  const openRows: HlTwapPaperOpen[] = [...openMap.values()];
  const openByHash = new Map(journal.opens.map((o) => [o.hash, o]));
  const closedEnriched: HlTwapPaperClose[] = [];
  for (const c of journal.closes) {
    const row = enrichPaperClose(c, openByHash);
    if (row) closedEnriched.push(row);
  }

  const now = Date.now();
  let unrealizedTotal = 0;
  const openUi = openRows.map((o) => {
    const markPx = cache ? exitPxForOpen(o, cache) : o.entryPx;
    const pnlUsd = cache ? unrealizedUsd(o, markPx) : 0;
    const dir = o.side === 'buy' ? 1 : -1;
    const pnlPct = markPx > 0 ? dir * ((markPx - o.entryPx) / o.entryPx) * 100 : 0;
    unrealizedTotal += pnlUsd;
    const twapStartMs = Number.isFinite(o.twapStartMs) ? o.twapStartMs : o.entryTs;
    const paperCloseAtMs = Number.isFinite(o.paperCloseAtMs) ? o.paperCloseAtMs : o.entryTs;
    const sched = computeTwapSchedule({
      size: 0,
      minutes: Math.max(1, o.minutes || 1),
      randomize: false,
      midPx: o.entryPx > 0 ? o.entryPx : 1,
      startedAtMs: twapStartMs,
    });
    return {
      mint: o.hash,
      symbol: o.displaySymbol,
      side: o.side,
      entryTs: o.entryTs,
      entryPx: o.entryPx,
      markPx,
      impactPct: o.impactPct,
      whaleUser: o.whaleUser,
      minutes: o.minutes,
      notionalUsd: o.notionalUsd,
      ageMin: (now - o.entryTs) / 60_000,
      pnlPct,
      pnlUsd,
      remainingCostBasisUsd: o.notionalUsd,
      paperCloseAtMs,
      timeline: buildPaperPositionTimeline(o, markPx, pnlUsd).concat(
        Number.isFinite(paperCloseAtMs) && now < paperCloseAtMs
          ? [
              {
                ts: timelineIso(paperCloseAtMs, o.entryTs),
                kind: 'strategy_note',
                label: `ETA выход · ${sched.cycleCount} циклов TWAP`,
              },
            ]
          : [],
      ),
    };
  });

  const realized = closedEnriched.reduce((s, c) => s + c.pnlUsd, 0);
  const wins = closedEnriched.filter((c) => c.pnlUsd > 0).length;
  const firstTs =
    journal.opens.length > 0
      ? Math.min(...journal.opens.map((o) => o.ts))
      : journal.closes.length > 0
        ? Math.min(...journal.closes.map((c) => c.ts))
        : now;

  const exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }> = {};
  for (const c of closedEnriched) {
    const key = c.exitReason.replace(/^twap_/, '').toUpperCase() || 'OTHER';
    const slot = exitsBreakdown[key] ?? { count: 0, sumPct: 0, sumUsd: 0, avgPct: 0 };
    slot.count += 1;
    slot.sumPct += c.pnlPct;
    slot.sumUsd += c.pnlUsd;
    exitsBreakdown[key] = slot;
  }
  for (const k of Object.keys(exitsBreakdown)) {
    const s = exitsBreakdown[k]!;
    s.avgPct = s.count ? s.sumPct / s.count : 0;
  }

  const recentClosed = closedEnriched
    .slice(-40)
    .reverse()
    .map((c) => ({
      mint: c.hash,
      symbol: c.displaySymbol,
      side: c.side,
      entryTs: c.entryTs,
      exitTs: c.exitTs,
      entryPx: c.entryPx,
      exitPx: c.exitPx,
      pnlPct: c.pnlPct,
      pnlUsd: c.pnlUsd,
      exitReason: c.exitReason,
      impactPct: c.impactPct,
      whaleUser: c.whaleUser,
      notionalUsd: c.notionalUsd,
      durationMin: (c.exitTs - c.entryTs) / 60_000,
      timeline: paperClosedTimeline(c),
    }));

  const minImpact = Number(process.env.HL_TWAP_MIN_IMPACT_PCT_HOUR ?? process.env.HL_TWAP_MIN_VOLUME_SHARE_PCT ?? 2);
  const buyOnlyEnv = process.env.HL_TWAP_BUY_ONLY?.trim();
  const watchBuyOnly =
    buyOnlyEnv === '1' || buyOnlyEnv?.toLowerCase() === 'true' || buyOnlyEnv?.toLowerCase() === 'yes';

  return {
    strategyId: 'hl-twap-paper',
    file: filePath,
    openCount: openRows.length,
    closedCount: closedEnriched.length,
    startedAt: firstTs,
    lastTs: now,
    hoursOfData: Math.max(0, (now - firstTs) / 3_600_000),
    sumPnlUsd: realized,
    realizedPnlUsd: realized,
    unrealizedPnlUsd: unrealizedTotal,
    totalPnlUsd: realized + unrealizedTotal,
    winRate: closedEnriched.length ? wins / closedEnriched.length : 0,
    avgPnl: closedEnriched.length ? realized / closedEnriched.length : 0,
    avgPeak: 0,
    bestPnlUsd: closedEnriched.length ? Math.max(...closedEnriched.map((c) => c.pnlUsd)) : 0,
    worstPnlUsd: closedEnriched.length ? Math.min(...closedEnriched.map((c) => c.pnlUsd)) : 0,
    unrealizedUsd: unrealizedTotal,
    exits: Object.fromEntries(Object.entries(exitsBreakdown).map(([k, v]) => [k, v.count])),
    exitsBreakdown,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    open: openUi,
    recentClosed,
    priorityFeeUsdTotal: 0,
    priceVerify: { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
    hlTwap: {
      watchMinImpactPct: Number.isFinite(minImpact) ? minImpact : 1,
      watchBuyOnly,
      paperNotionalUsd: paperNotionalUsd(),
      pendingSchedules: pending.size,
      openLongCount: openRows.filter((o) => o.side === 'buy').length,
      openShortCount: openRows.filter((o) => o.side === 'sell').length,
      closedLongCount: closedEnriched.filter((c) => c.side === 'buy').length,
      closedShortCount: closedEnriched.filter((c) => c.side === 'sell').length,
      signalsFeedUrl: 'https://api.hypurrscan.io/twap/*',
      telegramConfigured: Boolean(
        process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() && process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim(),
      ),
      liveDryRun: false,
    },
  };
}

/** Build dashboard row for tile 3 (`hl-twap-paper`). */
export async function buildHlTwapPaperDashboardRow(
  filePath = hlTwapDashboardJsonlPath(),
): Promise<Record<string, unknown>> {
  const resolved = filePath.trim() || hlTwapDashboardJsonlPath();
  const rows = readAllRows(resolved);
  if (isLiveJournal(rows)) return buildFromLiveJournal(resolved);
  if (rows.length === 0 && fs.existsSync(paperJournalPath())) {
    return buildFromPaperJournal(paperJournalPath());
  }
  return buildFromPaperJournal(resolved);
}
