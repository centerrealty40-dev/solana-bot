import type { Paper2OpenItem } from './dashboard-server.js';
import type { TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export type PumpswapDipDashboardLoad = {
  open: Paper2OpenItem[];
  closed: Array<Record<string, unknown>>;
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
  pumpswapDip: {
    signals1h: number;
    buys1h: number;
    sells1h: number;
    mode: string | null;
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

export function loadPumpswapDipJsonlForDashboard(jsonlPath: string): PumpswapDipDashboardLoad {
  const openMap = new Map<string, OpenPos>();
  const closed: Array<Record<string, unknown>> = [];
  const openTimelines = new Map<string, TimelineEvent[]>();
  const failCounts = new Map<string, number>();
  let firstTs = Date.now();
  let lastTs = 0;
  let signals1h = 0;
  let buys1h = 0;
  let sells1h = 0;
  let lastMode: string | null = null;
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
    if (kind === 'boot' && ev.executionMode) lastMode = String(ev.executionMode);

    if (kind === 'signal_skip' && ts >= hourAgo) signals1h++;
    if (kind === 'open') {
      if (ts >= hourAgo) buys1h++;
      const mint = String(ev.mint ?? '');
      if (!mint) continue;
      const pos: OpenPos = {
        mint,
        symbol: String(ev.symbol ?? mint.slice(0, 6)),
        entryTs: ts,
        entryPriceUsd: Number(ev.priceUsd ?? 0),
        sizeUsd: Number(ev.sizeUsd ?? 0),
        dumpPct: Number(ev.dumpPct ?? 0),
        txSignature: ev.txSignature ? String(ev.txSignature) : null,
      };
      openMap.set(mint, pos);
      openTimelines.set(mint, [
        {
          ts,
          kind: 'open',
          label: `dip ${pos.dumpPct.toFixed(1)}% · $${pos.sizeUsd.toFixed(0)}`,
          priceUsd: pos.entryPriceUsd,
          txSignature: pos.txSignature ?? undefined,
        },
      ]);
    }
    if (kind === 'close') {
      if (ts >= hourAgo) sells1h++;
      const mint = String(ev.mint ?? '');
      openMap.delete(mint);
      closed.unshift({
        mint,
        symbol: String(ev.symbol ?? mint.slice(0, 6)),
        entryTs: Number(ev.entryTs ?? ts - 60_000),
        exitTs: ts,
        entryPriceUsd: Number(ev.entryPriceUsd ?? 0),
        exitPriceUsd: Number(ev.exitPriceUsd ?? 0),
        pnlPct: Number(ev.pnlPct ?? 0),
        pnlUsd: Number(ev.pnlUsd ?? 0),
        exitReason: String(ev.exitReason ?? 'close'),
        txSignature: ev.txSignature ? String(ev.txSignature) : null,
      });
    }
    if (kind === 'buy_fail' || kind === 'sell_fail') {
      const reason = String(ev.reason ?? kind);
      failCounts.set(reason, (failCounts.get(reason) ?? 0) + 1);
    }
  }

  const open: Paper2OpenItem[] = [...openMap.values()].map((p) => ({
    mint: p.mint,
    symbol: p.symbol,
    entryTs: p.entryTs,
    entryPriceUsd: p.entryPriceUsd,
    currentPriceUsd: p.entryPriceUsd,
    sizeUsd: p.sizeUsd,
    pnlPct: 0,
    pnlUsd: 0,
    peakPct: 0,
    source: 'pumpswap',
  }));

  return {
    open,
    closed: closed.slice(0, 80),
    firstTs,
    lastTs,
    resetTs: 0,
    evals1h: signals1h,
    passed1h: buys1h,
    failReasons: [...failCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    openTimelines,
    pumpswapDip: { signals1h, buys1h, sells1h, mode: lastMode },
  };
}
