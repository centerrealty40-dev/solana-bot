import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const FOLLOW_LEG_USD_DEFAULT = 3;

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export type PumpswapComboFollowDashboardLoad = {
  open: Paper2OpenItem[];
  closed: Array<Record<string, unknown>>;
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
  hbOpen?: number;
  hbClosed?: number;
  pumpswapComboFollow: {
    buys1h: number;
    adds1h: number;
    sells1h: number;
    leaderSignals1h: number;
    leaderSells1h: number;
    halted: boolean;
    pendingBuys: number;
    executionMode: string;
    targetWallet: string;
    exitLeadPct: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    totalPnlUsd: number;
    lastBootTs: number;
  };
};

type OpenPos = {
  mint: string;
  symbol: string;
  entryTs: number;
  entryPriceUsd: number;
  sizeUsd: number;
  txSignature?: string | null;
};

export function loadPumpswapComboFollowJsonlForDashboard(
  jsonlPath: string,
): PumpswapComboFollowDashboardLoad {
  const openMap = new Map<string, OpenPos>();
  const closed: Array<Record<string, unknown>> = [];
  const openTimelines = new Map<string, TimelineEvent[]>();
  const failCounts = new Map<string, number>();
  let firstTs = Date.now();
  let lastTs = 0;
  let buys1h = 0;
  let adds1h = 0;
  let sells1h = 0;
  let leaderSignals1h = 0;
  let leaderSells1h = 0;
  let lastBootTs = 0;
  let lastHb = {
    openCount: 0,
    pendingBuys: 0,
    halted: false,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    executionMode: 'paper',
    targetWallet: '',
    exitLeadPct: 2,
  };
  const hourAgo = Date.now() - 3_600_000;

  const recordBuy = (ev: Record<string, unknown>, ts: number, kind: 'entry' | 'add'): void => {
    if (ts >= hourAgo) {
      if (kind === 'add') adds1h++;
      else buys1h++;
    }
    const mint = String(ev.mint ?? '');
    if (!mint) return;
    const legUsd = Number(ev.legUsd ?? ev.usd ?? FOLLOW_LEG_USD_DEFAULT);
    const prev = openMap.get(mint);
    const fillPriceUsd = Number(ev.fillPriceUsd ?? 0);
    const sizeUsd = (prev?.sizeUsd ?? 0) + legUsd;
    const pos: OpenPos = {
      mint,
      symbol: String(ev.symbol ?? mint.slice(0, 6)),
      entryTs: prev?.entryTs ?? ts,
      entryPriceUsd: fillPriceUsd > 0 ? fillPriceUsd : (prev?.entryPriceUsd ?? 0),
      sizeUsd,
      txSignature: ev.txSignature ? String(ev.txSignature) : (prev?.txSignature ?? null),
    };
    openMap.set(mint, pos);
    const tl = openTimelines.get(mint) ?? [];
    tl.push({
      ts,
      kind: kind === 'add' ? 'dca' : 'open',
      label:
        kind === 'add'
          ? `mirror add · $${legUsd.toFixed(0)}`
          : `mirror entry · $${legUsd.toFixed(0)}`,
      priceUsd: fillPriceUsd > 0 ? fillPriceUsd : undefined,
      txSignature: pos.txSignature ?? undefined,
    });
    openTimelines.set(mint, tl);
  };

  for (const line of iterJsonlLinesBounded(jsonlPath, TAIL_BYTES, FULL_SCAN_MAX)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = Number(ev.ts ?? 0);
    if (!ts) continue;
    if (lastTs === 0) firstTs = ts;
    lastTs = ts;
    const kind = String(ev.kind ?? '');

    if (kind === 'boot') {
      lastBootTs = ts;
      lastHb.executionMode = String(ev.executionMode ?? lastHb.executionMode);
      lastHb.targetWallet = String(ev.targetWallet ?? lastHb.targetWallet);
      lastHb.exitLeadPct = Number(ev.exitLeadPct ?? lastHb.exitLeadPct);
    }

    if (kind === 'heartbeat') {
      lastHb = {
        ...lastHb,
        openCount: Number(ev.openCount ?? 0),
        pendingBuys: Number(ev.pendingBuys ?? 0),
        halted: Boolean(ev.halted),
        realizedPnlUsd: Number(ev.realizedPnlUsd ?? 0),
        unrealizedPnlUsd: Number(ev.unrealizedPnlUsd ?? 0),
        totalPnlUsd: Number(ev.totalPnlUsd ?? 0),
        executionMode: String(ev.executionMode ?? lastHb.executionMode),
        targetWallet: String(ev.targetWallet ?? lastHb.targetWallet),
      };
    }

    if (kind === 'leader_buy_scheduled' || kind === 'leader_add_scheduled') {
      if (ts >= hourAgo) leaderSignals1h++;
    }

    if (kind === 'leader_sell_observed' && ts >= hourAgo) {
      leaderSells1h++;
    }

    if (kind === 'buy_ok') recordBuy(ev, ts, 'entry');
    if (kind === 'add_ok') recordBuy(ev, ts, 'add');

    if (kind === 'partial_sell') {
      if (ts >= hourAgo) sells1h++;
      const mint = String(ev.mint ?? '');
      const tl = openTimelines.get(mint) ?? [];
      const exitReason = String(ev.exitReason ?? 'partial');
      const pnlPct = Number(ev.pnlPct ?? 0);
      tl.push({
        ts,
        kind: 'partial_tp',
        label: `${exitReason}${pnlPct !== 0 ? ` · ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''}`,
        txSignature: ev.txSignature ? String(ev.txSignature) : undefined,
      });
      openTimelines.set(mint, tl);
    }

    if (kind === 'close' || kind === 'round_trip') {
      if (ts >= hourAgo) sells1h++;
      const mint = String(ev.mint ?? '');
      const entryTs = openMap.get(mint)?.entryTs ?? ts - 60_000;
      const entryPriceUsd = openMap.get(mint)?.entryPriceUsd ?? 0;
      const sizeUsd = openMap.get(mint)?.sizeUsd ?? FOLLOW_LEG_USD_DEFAULT;
      const pnlUsd = Number(ev.pnlUsd ?? 0);
      const pnlPct = Number(ev.pnlPct ?? 0);
      const exitReasonRaw = String(ev.exitReason ?? kind);
      if (kind === 'round_trip' || kind === 'close') {
        openMap.delete(mint);
        const priorTl = openTimelines.get(mint) ?? [];
        const timeline: TimelineEvent[] = [
          priorTl[0] ?? {
            ts: entryTs,
            kind: 'open',
            label: `follow entry · $${sizeUsd.toFixed(0)}`,
            priceUsd: entryPriceUsd > 0 ? entryPriceUsd : undefined,
          },
          ...priorTl.slice(1),
          {
            ts,
            kind: 'close',
            label: `${exitReasonRaw}${pnlPct !== 0 ? ` · ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''}`,
            txSignature: ev.txSignature ? String(ev.txSignature) : undefined,
          },
        ];
        openTimelines.delete(mint);
        if (kind === 'round_trip') {
          closed.unshift({
            mint,
            symbol: String(ev.symbol ?? mint.slice(0, 6)),
            entryTs,
            exitTs: ts,
            entryPriceUsd,
            exitPriceUsd: 0,
            sizeUsd,
            pnlPct,
            pnlUsd,
            exitReason: exitReasonRaw,
            txSignature: ev.txSignature ? String(ev.txSignature) : null,
            source: 'pumpswap',
            __timeline: timeline,
          });
        }
      }
    }

    if (kind === 'buy_fail' || kind === 'add_fail' || kind === 'sell_fail') {
      const reason = String(ev.reason ?? ev.error ?? kind);
      failCounts.set(reason, (failCounts.get(reason) ?? 0) + 1);
    }
  }

  const open: Paper2OpenItem[] = [...openMap.values()].map((p) => ({
    mint: p.mint,
    symbol: p.symbol,
    entryTs: p.entryTs,
    entryPriceUsd: p.entryPriceUsd,
    entryMcUsd: p.entryPriceUsd,
    entryRealMcUsd: null,
    currentPriceUsd: p.entryPriceUsd,
    sizeUsd: p.sizeUsd,
    totalInvestedUsd: p.sizeUsd > 0 ? p.sizeUsd : FOLLOW_LEG_USD_DEFAULT,
    pnlPct: 0,
    pnlUsd: 0,
    peakPct: 0,
    source: 'pumpswap',
    metricType: 'price' as const,
    baselinePriceUsd: p.entryPriceUsd,
  }));

  return {
    open,
    closed: closed.slice(0, 80),
    firstTs,
    lastTs,
    resetTs: 0,
    evals1h: leaderSignals1h,
    passed1h: buys1h + adds1h,
    failReasons: [...failCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    openTimelines,
    hbOpen: lastHb.openCount,
    hbClosed: closed.length,
    pumpswapComboFollow: {
      buys1h,
      adds1h,
      sells1h,
      leaderSignals1h,
      leaderSells1h,
      halted: lastHb.halted,
      pendingBuys: lastHb.pendingBuys,
      executionMode: lastHb.executionMode,
      targetWallet: lastHb.targetWallet,
      exitLeadPct: lastHb.exitLeadPct,
      realizedPnlUsd: lastHb.realizedPnlUsd,
      unrealizedPnlUsd: lastHb.unrealizedPnlUsd,
      totalPnlUsd: lastHb.totalPnlUsd,
      lastBootTs,
    },
  };
}
