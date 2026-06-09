import type { Paper2OpenItem } from './dashboard-server.js';
import type { TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const COMBO_LEG_USD_DEFAULT = 3;

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export type PumpswapComboDashboardLoad = {
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
  pumpswapCombo: {
    buys1h: number;
    sells1h: number;
    halted: boolean;
    watchlistSize: number;
    dumpBandCount: number;
    probeReadyCount: number;
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
  dumpPct: number;
  txSignature?: string | null;
};

export function loadPumpswapComboJsonlForDashboard(jsonlPath: string): PumpswapComboDashboardLoad {
  const openMap = new Map<string, OpenPos>();
  const closed: Array<Record<string, unknown>> = [];
  const openTimelines = new Map<string, TimelineEvent[]>();
  const failCounts = new Map<string, number>();
  let firstTs = Date.now();
  let lastTs = 0;
  let buys1h = 0;
  let sells1h = 0;
  let lastBootTs = 0;
  let lastHb = {
    openCount: 0,
    halted: false,
    watchlistSize: 0,
    dumpBandCount: 0,
    probeReadyCount: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
  };
  const hourAgo = Date.now() - 3_600_000;

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

    if (kind === 'boot') lastBootTs = ts;

    if (kind === 'heartbeat') {
      lastHb = {
        openCount: Number(ev.openCount ?? 0),
        halted: Boolean(ev.halted),
        watchlistSize: Number(ev.watchlistSize ?? 0),
        dumpBandCount: Number(ev.dumpBandCount ?? 0),
        probeReadyCount: Number(ev.probeReadyCount ?? 0),
        realizedPnlUsd: Number(ev.realizedPnlUsd ?? 0),
        unrealizedPnlUsd: Number(ev.unrealizedPnlUsd ?? 0),
        totalPnlUsd: Number(ev.totalPnlUsd ?? 0),
      };
    }

    if (kind === 'buy_ok') {
      if (ts >= hourAgo) buys1h++;
      const mint = String(ev.mint ?? '');
      if (!mint) continue;
      const legUsd = Number(ev.usd ?? COMBO_LEG_USD_DEFAULT);
      const prev = openMap.get(mint);
      const fillPriceUsd = Number(ev.fillPriceUsd ?? 0);
      const sizeUsd = (prev?.sizeUsd ?? 0) + legUsd;
      const pos: OpenPos = {
        mint,
        symbol: String(ev.symbol ?? mint.slice(0, 6)),
        entryTs: prev?.entryTs ?? ts,
        entryPriceUsd: fillPriceUsd > 0 ? fillPriceUsd : (prev?.entryPriceUsd ?? 0),
        sizeUsd,
        dumpPct: Number(ev.dumpPct ?? prev?.dumpPct ?? 0),
        txSignature: ev.txSignature ? String(ev.txSignature) : prev?.txSignature ?? null,
      };
      openMap.set(mint, pos);
      const tl = openTimelines.get(mint) ?? [];
      tl.push({
        ts,
        kind: 'open',
        label: `buy ${String(ev.intent ?? 'leg')} dump ${pos.dumpPct.toFixed(1)}% · $${legUsd.toFixed(0)}`,
        priceUsd: fillPriceUsd > 0 ? fillPriceUsd : undefined,
        txSignature: pos.txSignature ?? undefined,
      });
      openTimelines.set(mint, tl);
    }

    if (kind === 'partial_sell' || kind === 'close' || kind === 'round_trip') {
      if (ts >= hourAgo && kind !== 'partial_sell') sells1h++;
      if (ts >= hourAgo && kind === 'partial_sell') sells1h++;
      const mint = String(ev.mint ?? '');
      const entryTs = openMap.get(mint)?.entryTs ?? ts - 60_000;
      const entryPriceUsd = openMap.get(mint)?.entryPriceUsd ?? 0;
      const sizeUsd = openMap.get(mint)?.sizeUsd ?? COMBO_LEG_USD_DEFAULT;
      const pnlUsd = Number(ev.pnlUsd ?? 0);
      const pnlPct = Number(ev.pnlPct ?? 0);
      const exitReasonRaw = String(ev.exitReason ?? kind);
      if (kind === 'close' || kind === 'round_trip') {
        openMap.delete(mint);
        const priorOpen = openTimelines.get(mint)?.[0];
        const timeline: TimelineEvent[] = [
          priorOpen ?? {
            ts: entryTs,
            kind: 'open',
            label: `combo entry · $${sizeUsd.toFixed(0)}`,
            priceUsd: entryPriceUsd > 0 ? entryPriceUsd : undefined,
          },
          {
            ts,
            kind: 'close',
            label: `${exitReasonRaw}${pnlPct !== 0 ? ` · ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''}`,
            txSignature: ev.txSignature ? String(ev.txSignature) : undefined,
          },
        ];
        openTimelines.delete(mint);
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

    if (kind === 'buy_fail' || kind === 'sell_fail') {
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
    totalInvestedUsd: p.sizeUsd > 0 ? p.sizeUsd : COMBO_LEG_USD_DEFAULT,
    pnlPct: 0,
    pnlUsd: 0,
    peakPct: 0,
    source: 'pumpswap',
    metricType: 'price' as const,
    baselinePriceUsd: p.entryPriceUsd,
  }));

  const dumpSignals1h = lastHb.dumpBandCount;

  return {
    open,
    closed: closed.slice(0, 80),
    firstTs,
    lastTs,
    resetTs: 0,
    evals1h: dumpSignals1h,
    passed1h: buys1h,
    failReasons: [...failCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    openTimelines,
    hbOpen: lastHb.openCount,
    hbClosed: closed.length,
    pumpswapCombo: {
      buys1h,
      sells1h,
      halted: lastHb.halted,
      watchlistSize: lastHb.watchlistSize,
      dumpBandCount: lastHb.dumpBandCount,
      probeReadyCount: lastHb.probeReadyCount,
      realizedPnlUsd: lastHb.realizedPnlUsd,
      unrealizedPnlUsd: lastHb.unrealizedPnlUsd,
      totalPnlUsd: lastHb.totalPnlUsd,
      lastBootTs,
    },
  };
}
