import fs from 'node:fs';

import { loadHyperliquidMarketCache } from './hyperliquid-meta.js';
import {
  buildPaperPositionTimeline,
  exitPxForOpen,
  loadPaperOpensFromJournal,
  loadPendingSchedules,
  paperJournalPath,
  paperNotionalUsd,
  unrealizedUsd,
  type HlTwapPaperClose,
  type HlTwapPaperOpen,
} from './paper-trader.js';
import { computeTwapSchedule, formatMoscowDateTime } from './twap-schedule.js';

type JournalClose = {
  kind: 'close';
  ts: number;
  hash: string;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

type JournalOpen = {
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

export type HlTwapDashboardExtras = {
  watchMinImpactPct: number;
  paperNotionalUsd: number;
  pendingSchedules: number;
  signalsFeedUrl: string;
  telegramConfigured: boolean;
};

function readJournal(filePath: string): { opens: JournalOpen[]; closes: JournalClose[] } {
  const opens: JournalOpen[] = [];
  const closes: JournalClose[] = [];
  if (!fs.existsSync(filePath)) return { opens, closes };
  for (const ln of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try {
      const ev = JSON.parse(ln) as { kind?: string };
      if (ev.kind === 'open') opens.push(ev as JournalOpen);
      if (ev.kind === 'close') closes.push(ev as JournalClose);
    } catch {
      /* skip */
    }
  }
  return { opens, closes };
}

function enrichClose(
  c: JournalClose,
  openByHash: Map<string, JournalOpen>,
): HlTwapPaperClose | null {
  const o = openByHash.get(c.hash);
  if (!o) return null;
  return {
    hash: c.hash,
    coin: o.coin,
    displaySymbol: o.displaySymbol,
    side: o.side,
    entryTs: o.ts,
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

function closedTimeline(c: HlTwapPaperClose): Array<{ ts: string; kind: string; label: string; reason?: string }> {
  const dir = c.side === 'buy' ? 'LONG' : 'SHORT';
  return [
    {
      ts: new Date(c.twapStartMs).toISOString(),
      kind: 'strategy_note',
      label: `Telegram OPEN · whale TWAP ${dir}`,
    },
    {
      ts: new Date(c.paperOpenAtMs).toISOString(),
      kind: 'open',
      label: `Paper ${dir} $${c.notionalUsd.toFixed(0)} @ ${c.entryPx.toFixed(4)}`,
      reason: 'after_cycle_1',
    },
    {
      ts: new Date(c.paperCloseAtMs).toISOString(),
      kind: 'strategy_note',
      label: `Плановый выход (МСК ${formatMoscowDateTime(c.paperCloseAtMs)})`,
    },
    {
      ts: new Date(c.exitTs).toISOString(),
      kind: 'close',
      label: `Closed @ ${c.exitPx.toFixed(4)} · ${c.pnlUsd >= 0 ? '+' : ''}${c.pnlUsd.toFixed(2)} USD (${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct.toFixed(2)}%)`,
      reason: c.exitReason,
    },
  ];
}

/** Build dashboard row for tile 3 (`hl-twap-paper`). */
export async function buildHlTwapPaperDashboardRow(
  filePath = paperJournalPath(),
): Promise<Record<string, unknown>> {
  const journal = readJournal(filePath);
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
    const row = enrichClose(c, openByHash);
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
    const sched = computeTwapSchedule({
      size: 0,
      minutes: o.minutes,
      randomize: false,
      midPx: o.entryPx,
      startedAtMs: o.twapStartMs,
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
      paperCloseAtMs: o.paperCloseAtMs,
      timeline: buildPaperPositionTimeline(o, markPx, pnlUsd).concat(
        now < o.paperCloseAtMs
          ? [
              {
                ts: new Date(o.paperCloseAtMs).toISOString(),
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

  const exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }> =
    {};
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
      timeline: closedTimeline(c),
    }));

  const minImpact = Number(process.env.HL_TWAP_MIN_VOLUME_SHARE_PCT ?? 1);

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
    priceVerify: {
      okCount: 0,
      blockedCount: 0,
      skippedCount: 0,
      avgSlipPct: null,
      p90SlipPct: null,
    },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
    hlTwap: {
      watchMinImpactPct: Number.isFinite(minImpact) ? minImpact : 1,
      paperNotionalUsd: paperNotionalUsd(),
      pendingSchedules: pending.size,
      signalsFeedUrl: 'https://api.hypurrscan.io/twap/*',
      telegramConfigured: Boolean(
        process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() && process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim(),
      ),
    },
  };
}
