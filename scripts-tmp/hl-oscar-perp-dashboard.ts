/**
 * HL Oscar perp — dashboard loader for `/papertrader2` tile 7.
 * Journal: `data/hl-oscar-perp/live.jsonl` (same host as bot on VPS).
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export function hlOscarPerpDashboardJsonlPath(): string {
  return (
    process.env.DASHBOARD_HL_OSCAR_PERP_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'hl-oscar-perp', 'live.jsonl')
  );
}

export function hlOscarHyperliquidTradeUrl(coin: string): string {
  return `https://app.hyperliquid.xyz/trade/${encodeURIComponent(String(coin).trim().toUpperCase())}`;
}

export type HlOscarPerpDashboardMeta = {
  mode: 'dry_run' | 'live';
  liveDryRun: boolean;
  openCount: number;
  universeSize: number;
  leverage: number;
  notionalUsd: number;
};

export type HlOscarPerpDashboardLoad = {
  open: Paper2OpenItem[];
  closed: Array<Record<string, unknown>>;
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
  hlOscar?: HlOscarPerpDashboardMeta;
};

type JournalEv = Record<string, unknown>;
type OpenRow = Paper2OpenItem & { timeline: TimelineEvent[]; coin: string; positionId: string };

function* journalLines(filePath: string): Generator<string> {
  yield* iterJsonlLinesBounded(filePath, TAIL_BYTES, FULL_SCAN_MAX);
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tsMs(ev: JournalEv): number {
  const t = ev.ts;
  if (typeof t === 'number' && t > 0) return t;
  return 0;
}

function pushTimeline(
  tl: TimelineEvent[],
  ev: Partial<TimelineEvent> & { ts: number; kind: TimelineEvent['kind']; label: string },
): void {
  tl.push({
    mcUsd: ev.mcUsd ?? null,
    spotPxUsd: ev.spotPxUsd ?? null,
    sizePct: ev.sizePct ?? null,
    pnlPct: ev.pnlPct ?? null,
    pnlUsd: ev.pnlUsd ?? null,
    reason: ev.reason ?? null,
    remainingFraction: ev.remainingFraction ?? null,
    amountUsd: ev.amountUsd ?? null,
    contextNote: ev.contextNote ?? null,
    txSignature: ev.txSignature ?? null,
    ts: ev.ts,
    kind: ev.kind,
    label: ev.label,
  });
}

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    TP: 'Take profit partial',
    TRAIL: 'Trail partial',
    KILL: 'Kill stop',
    STAGED_KILL: 'Staged kill',
    TIME_STOP: 'Time stop',
    BREAKEVEN: 'Breakeven exit',
    cooldown: 'Signal cooldown',
  };
  return map[reason] ?? reason;
}

/** Map HL Oscar close reason → dashboard exit bucket (TP/TRAIL/SL/TIMEOUT). */
export function hlOscarExitReasonForMetrics(raw: string): string {
  const r = raw.trim().toUpperCase();
  if (r === 'KILL' || r === 'STAGED_KILL') return 'SL';
  if (r === 'TIME_STOP') return 'TIMEOUT';
  if (r === 'BREAKEVEN') return 'TRAIL';
  if (r === 'TP') return 'TP';
  if (r === 'TRAIL') return 'TRAIL';
  return r || 'NO_DATA';
}

function emptyOpenRow(posId: string, coin: string, symbol: string, ts: number): OpenRow {
  return {
    mint: posId,
    symbol,
    entryTs: ts,
    entryMcUsd: 0,
    entryRealMcUsd: null,
    baselinePriceUsd: null,
    openedAtIso: new Date(ts).toISOString(),
    lane: 'hl-oscar-perp',
    source: 'hyperliquid',
    metricType: 'price',
    features: { coin, positionId: posId, hyperliquidUrl: hlOscarHyperliquidTradeUrl(coin) },
    btc: null,
    peakMcUsd: 0,
    peakPnlPct: 0,
    trailingArmed: false,
    totalInvestedUsd: 0,
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: null,
    entryPriceVerifyImpactPct: null,
    entryPriceVerifySource: null,
    pairAddress: coin,
    entryLiqUsd: null,
    remainingFraction: 1,
    liveOscarTradeLane: null,
    isScalpWave: false,
    timeline: [],
    coin,
    positionId: posId,
  };
}

export function loadHlOscarPerpForDashboard(
  jsonlPath = hlOscarPerpDashboardJsonlPath(),
): HlOscarPerpDashboardLoad {
  const openById = new Map<string, OpenRow>();
  const closed: Array<Record<string, unknown>> = [];
  const failMap = new Map<string, number>();
  let firstTs = 0;
  let lastTs = 0;
  let evals1h = 0;
  let passed1h = 0;
  let heartbeatMode: 'dry_run' | 'live' = 'dry_run';
  let heartbeatOpenCount = 0;
  let heartbeatUniverse = 0;
  const oneHourAgo = Date.now() - 3_600_000;

  if (!fs.existsSync(jsonlPath)) {
    return {
      open: [],
      closed: [],
      firstTs: Date.now(),
      lastTs: 0,
      resetTs: 0,
      evals1h: 0,
      passed1h: 0,
      failReasons: [],
      openTimelines: new Map(),
      hlOscar: {
        mode: 'dry_run',
        liveDryRun: true,
        openCount: 0,
        universeSize: 0,
        leverage: Number(process.env.HL_OSCAR_LEVERAGE ?? 2),
        notionalUsd: Number(process.env.HL_OSCAR_POSITION_NOTIONAL_USD ?? 50),
      },
    };
  }

  for (const ln of journalLines(jsonlPath)) {
    let ev: JournalEv;
    try {
      ev = JSON.parse(ln) as JournalEv;
    } catch {
      continue;
    }
    const ts = tsMs(ev);
    if (ts <= 0) continue;
    if (firstTs === 0 || ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;

    const kind = typeof ev.kind === 'string' ? ev.kind : '';
    const posId = typeof ev.id === 'string' ? ev.id : '';
    const coin = typeof ev.coin === 'string' ? ev.coin : '';
    const displaySymbol =
      typeof ev.displaySymbol === 'string' && ev.displaySymbol.trim()
        ? ev.displaySymbol.trim()
        : coin || '?';

    if (kind === 'heartbeat') {
      const mode = ev.mode === 'live' ? 'live' : 'dry_run';
      heartbeatMode = mode;
      heartbeatOpenCount = num(ev.openCount) ?? heartbeatOpenCount;
      heartbeatUniverse = num(ev.universeSize) ?? heartbeatUniverse;
      continue;
    }

    if (kind === 'signal_skip') {
      if (ts >= oneHourAgo) {
        evals1h += 1;
        const reason = typeof ev.reason === 'string' ? ev.reason : 'skip';
        failMap.set(reason, (failMap.get(reason) ?? 0) + 1);
      }
      continue;
    }

    if (!posId) continue;

    if (kind === 'open') {
      const fillPx = num(ev.fillPx);
      const grossUsd = num(ev.grossUsd) ?? 0;
      const marginUsd = num(ev.marginUsd);
      const dipPct = num(ev.dipPct);
      const impulsePct = num(ev.impulsePct);
      const row = emptyOpenRow(posId, coin, displaySymbol, ts);
      row.baselinePriceUsd = fillPx;
      row.entryMcUsd = fillPx ?? 0;
      row.totalInvestedUsd = grossUsd;
      const ctxParts: string[] = [];
      if (dipPct != null) ctxParts.push(`dip ${dipPct.toFixed(1)}%`);
      if (impulsePct != null) ctxParts.push(`impulse +${impulsePct.toFixed(1)}%`);
      if (marginUsd != null) ctxParts.push(`margin $${marginUsd.toFixed(0)}`);
      const modeTag = ev.mode === 'live' ? 'LIVE' : 'dry-run';
      pushTimeline(row.timeline, {
        ts,
        kind: 'open',
        label: `Leg 1 open (${modeTag})`,
        spotPxUsd: fillPx,
        amountUsd: grossUsd,
        contextNote: ctxParts.length ? ctxParts.join(' · ') : null,
      });
      openById.set(posId, row);
      if (ts >= oneHourAgo) {
        evals1h += 1;
        passed1h += 1;
      }
      continue;
    }

    const row = openById.get(posId);
    if (!row) continue;

    if (kind === 'add_leg') {
      const legIndex = num(ev.legIndex);
      const fillPx = num(ev.fillPx);
      const grossUsd = num(ev.grossUsd) ?? 0;
      const avgEntryPx = num(ev.avgEntryPx);
      if (grossUsd > 0) row.totalInvestedUsd += grossUsd;
      if (avgEntryPx != null && avgEntryPx > 0) {
        row.baselinePriceUsd = avgEntryPx;
        row.entryMcUsd = avgEntryPx;
      }
      pushTimeline(row.timeline, {
        ts,
        kind: 'scale_in_add',
        label: legIndex != null ? `Leg ${legIndex} staged add` : 'Staged leg add',
        spotPxUsd: fillPx,
        amountUsd: grossUsd,
        contextNote:
          avgEntryPx != null ? `avg entry $${avgEntryPx.toFixed(4)}` : null,
      });
      continue;
    }

    if (kind === 'partial_exit') {
      const reason = typeof ev.reason === 'string' ? ev.reason : 'partial';
      const fraction = num(ev.fraction);
      const fillPx = num(ev.fillPx);
      const pnlUsd = num(ev.pnlUsd);
      const remainingFraction = num(ev.remainingFraction);
      if (remainingFraction != null) row.remainingFraction = remainingFraction;
      pushTimeline(row.timeline, {
        ts,
        kind: 'partial_sell',
        label: reasonLabel(reason),
        reason,
        spotPxUsd: fillPx,
        pnlUsd,
        sizePct: fraction != null ? fraction * 100 : null,
        remainingFraction,
        amountUsd: num(ev.notionalUsd),
      });
      continue;
    }

    if (kind === 'close') {
      const reason = typeof ev.reason === 'string' ? ev.reason : 'close';
      const exitPx = num(ev.exitPx);
      const pnlUsd = num(ev.pnlUsd) ?? 0;
      const pnlPct = num(ev.pnlPct) ?? 0;
      const holdHours = num(ev.holdHours);
      pushTimeline(row.timeline, {
        ts,
        kind: 'close',
        label: reasonLabel(reason),
        reason,
        spotPxUsd: exitPx,
        pnlUsd,
        pnlPct,
        remainingFraction: 0,
      });
      closed.unshift({
        mint: row.mint,
        symbol: row.symbol,
        coin: row.coin,
        entryTs: row.entryTs,
        exitTs: ts,
        entryPx: row.baselinePriceUsd,
        exitPx,
        baselinePriceUsd: row.baselinePriceUsd,
        pnlPct,
        pnlUsd,
        exitReason: hlOscarExitReasonForMetrics(reason),
        hlOscarRawExitReason: reason,
        holdHours,
        timeline: row.timeline,
        durationMin: Math.max(0, Math.round((ts - row.entryTs) / 60_000)),
        __timeline: row.timeline,
        totalInvestedUsd: row.totalInvestedUsd,
        features: row.features,
        pairAddress: row.coin,
        metricType: 'price',
        source: 'hyperliquid',
      });
      openById.delete(posId);
    }
  }

  const open: Paper2OpenItem[] = [...openById.values()].map(({ timeline: _tl, coin: _c, positionId: _p, ...rest }) => rest);
  const openTimelines = new Map<string, TimelineEvent[]>(
    [...openById.entries()].map(([, r]) => [r.mint, r.timeline]),
  );

  const failReasons = [...failMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const mode = heartbeatMode;
  return {
    open,
    closed,
    firstTs,
    lastTs,
    resetTs: 0,
    evals1h,
    passed1h,
    failReasons,
    openTimelines,
    hlOscar: {
      mode,
      liveDryRun: mode !== 'live',
      openCount: open.length || heartbeatOpenCount,
      universeSize: heartbeatUniverse,
      leverage: Number(process.env.HL_OSCAR_LEVERAGE ?? 2),
      notionalUsd: Number(process.env.HL_OSCAR_POSITION_NOTIONAL_USD ?? 50),
    },
  };
}
