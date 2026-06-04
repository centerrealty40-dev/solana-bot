import fs from 'node:fs';

import { loadHyperliquidMarketCache } from './hyperliquid-meta.js';
import {
  exitPxForOpen,
  loadPaperOpensFromJournal,
  paperJournalPath,
  unrealizedUsd,
  type HlTwapPaperClose,
  type HlTwapPaperOpen,
} from './paper-trader.js';

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
};

export type HlTwapDashboardExtras = {
  watchMinImpactPct: number;
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
      const ev = JSON.parse(ln) as JournalOpen | JournalClose;
      if (ev.kind === 'open') opens.push(ev);
      if (ev.kind === 'close') closes.push(ev);
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
    exitTs: c.ts,
    exitPx: c.exitPx,
    pnlUsd: c.pnlUsd,
    pnlPct: c.pnlPct,
    exitReason: c.exitReason,
  };
}

/** Dashboard `/api/paper2` strategy row (subset used by hl-twap tile). */
export type HlTwapPaperDashboardRow = {
  strategyId: string;
  file: string;
  openCount: number;
  closedCount: number;
  startedAt: number;
  lastTs: number;
  hoursOfData: number;
  sumPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  winRate: number;
  avgPnl: number;
  avgPeak: number;
  bestPnlUsd: number;
  worstPnlUsd: number;
  unrealizedUsd: number;
  exits: Record<string, number>;
  exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }>;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  open: unknown[];
  recentClosed: unknown[];
  priorityFeeUsdTotal: number;
  priceVerify: {
    okCount: number;
    blockedCount: number;
    skippedCount: number;
    avgSlipPct: number | null;
    p90SlipPct: number | null;
  };
  liqDrain: { exits: number; avgDropPct: number | null; p90DropPct: number | null };
  hlTwap: HlTwapDashboardExtras;
};

/** Build dashboard row for tile 3 (`hl-twap-paper`). */
export async function buildHlTwapPaperDashboardRow(
  filePath = paperJournalPath(),
): Promise<HlTwapPaperDashboardRow> {
  const journal = readJournal(filePath);
  const openMap = loadPaperOpensFromJournal(filePath);
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
    const ageMin = (now - o.entryTs) / 60_000;
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
      ageMin,
      pnlPct,
      pnlUsd,
      remainingCostBasisUsd: o.notionalUsd,
      timeline: [
        {
          ts: new Date(o.entryTs).toISOString(),
          label: `TWAP ${o.side === 'buy' ? 'buy' : 'sell'} · impact ${o.impactPct != null ? o.impactPct.toFixed(2) : '?'}%`,
        },
      ],
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

  const recentClosed = closedEnriched
    .slice(-30)
    .reverse()
    .map((c) => ({
      mint: c.hash,
      symbol: c.displaySymbol,
      side: c.side,
      entryTs: c.entryTs,
      exitTs: c.exitTs,
      pnlPct: c.pnlPct,
      pnlUsd: c.pnlUsd,
      exitReason: c.exitReason,
      impactPct: c.impactPct,
      whaleUser: c.whaleUser,
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
    exits: { TWAP_END: closedEnriched.length },
    exitsBreakdown: {},
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
      signalsFeedUrl: 'https://api.hypurrscan.io/twap/*',
      telegramConfigured: Boolean(
        process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() && process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim(),
      ),
    },
  };
}
