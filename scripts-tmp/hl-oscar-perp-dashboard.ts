/**
 * HL Oscar journal dashboard loader — perp alts (tile 4) and majors BTC/ETH (tile 7).
 * Journals: `data/hl-oscar-perp/live.jsonl`, `data/hl-oscar-majors/live.jsonl`.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { hlOscarMajorsSizingFromEnv } from '../src/hyperliquid/oscar-majors/config.js';
import { hlOscarSizingFromEnv } from '../src/hyperliquid/oscar-perp/config.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export function hlOscarPerpDashboardJsonlPath(): string {
  return (
    process.env.DASHBOARD_HL_OSCAR_PERP_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'hl-oscar-perp', 'live.jsonl')
  );
}

export function hlOscarPerpHeartbeatPath(): string {
  const jsonl = hlOscarPerpDashboardJsonlPath();
  return (
    process.env.DASHBOARD_HL_OSCAR_HEARTBEAT?.trim() ||
    process.env.HL_OSCAR_HEARTBEAT_PATH?.trim() ||
    path.join(path.dirname(jsonl), 'heartbeat.json')
  );
}

export function hlOscarMajorsDashboardJsonlPath(): string {
  return (
    process.env.DASHBOARD_HL_OSCAR_MAJORS_JSONL?.trim() ||
    process.env.HL_MAJORS_JOURNAL_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'hl-oscar-majors', 'live.jsonl')
  );
}

export function hlOscarMajorsHeartbeatPath(): string {
  const jsonl = hlOscarMajorsDashboardJsonlPath();
  return (
    process.env.DASHBOARD_HL_OSCAR_MAJORS_HEARTBEAT?.trim() ||
    process.env.HL_MAJORS_HEARTBEAT_PATH?.trim() ||
    path.join(path.dirname(jsonl), 'heartbeat.json')
  );
}

type HlOscarHeartbeatSnapshot = {
  mode?: 'dry_run' | 'live';
  openCount?: number;
  paperOpenCount?: number;
  universeSize?: number;
};

function readHlOscarHeartbeatFile(heartbeatPath: string): HlOscarHeartbeatSnapshot | null {
  if (!fs.existsSync(heartbeatPath)) return null;
  try {
    const raw = fs.readFileSync(heartbeatPath, 'utf8').trim();
    if (!raw) return null;
    const row = JSON.parse(raw.split('\n')[0]!) as Record<string, unknown>;
    const mode =
      row.mode === 'live' ? 'live' : row.mode === 'dry_run' ? 'dry_run' : undefined;
    return {
      mode,
      openCount: num(row.openCount) ?? undefined,
      paperOpenCount: num(row.paperOpenCount) ?? undefined,
      universeSize: num(row.universeSize) ?? undefined,
    };
  } catch {
    return null;
  }
}

export function resolveHlOscarCoinFromRow(row: {
  pairAddress?: string | null;
  symbol?: string | null;
  features?: { coin?: string; hyperliquidUrl?: string } | null;
}): { coin: string; hyperliquidUrl: string } {
  const coin =
    (typeof row.pairAddress === 'string' && row.pairAddress.trim()) ||
    (typeof row.features?.coin === 'string' && row.features.coin.trim()) ||
    (typeof row.symbol === 'string' && row.symbol.trim() && row.symbol !== '?'
      ? row.symbol.trim()
      : '') ||
    '?';
  const normalized = coin === '?' ? coin : String(coin).trim().toUpperCase();
  return {
    coin: normalized,
    hyperliquidUrl:
      (typeof row.features?.hyperliquidUrl === 'string' && row.features.hyperliquidUrl.trim()) ||
      hlOscarHyperliquidTradeUrl(normalized),
  };
}

export function hlOscarHyperliquidTradeUrl(coin: string): string {
  return `https://app.hyperliquid.xyz/trade/${encodeURIComponent(String(coin).trim().toUpperCase())}`;
}

export type HlOscarPerpDashboardMeta = {
  mode: 'dry_run' | 'live';
  liveDryRun: boolean;
  openCount: number;
  paperPhantomCount: number;
  universeSize: number;
  leverage: number;
  /** Gross notional per entry. */
  notionalUsd: number;
  /** Margin per entry (= gross / leverage). */
  marginUsd: number;
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
type OpenRow = Paper2OpenItem & {
  timeline: TimelineEvent[];
  coin: string;
  positionId: string;
  journalMode: 'dry_run' | 'live';
};

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

function emptyOpenRow(
  posId: string,
  coin: string,
  symbol: string,
  ts: number,
  journalMode: 'dry_run' | 'live',
  lane: string,
): OpenRow {
  return {
    mint: posId,
    symbol,
    entryTs: ts,
    entryMcUsd: 0,
    entryRealMcUsd: null,
    baselinePriceUsd: null,
    openedAtIso: new Date(ts).toISOString(),
    lane,
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
    isRunnerProbe: false,
    timeline: [],
    coin,
    positionId: posId,
    journalMode,
  };
}

type HlOscarJournalDashboardOpts = {
  jsonlPath: string;
  heartbeatPath: string;
  lane: string;
  sizing: { leverage: number; grossUsd: number; marginUsd: number };
};

function loadHlOscarJournalForDashboard(opts: HlOscarJournalDashboardOpts): HlOscarPerpDashboardLoad {
  const { jsonlPath, heartbeatPath, lane, sizing } = opts;
  const openById = new Map<string, OpenRow>();
  const closed: Array<Record<string, unknown>> = [];
  const failMap = new Map<string, number>();
  let firstTs = 0;
  let lastTs = 0;
  let evals1h = 0;
  let passed1h = 0;
  let journalHeartbeatMode: 'dry_run' | 'live' | null = null;
  let journalHeartbeatOpenCount = 0;
  let journalHeartbeatUniverse = 0;
  let latestEventMode: 'dry_run' | 'live' | null = null;
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
        paperPhantomCount: 0,
        universeSize: 0,
        leverage: sizing.leverage,
        notionalUsd: sizing.grossUsd,
        marginUsd: sizing.marginUsd,
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

    if (ev.mode === 'live' || ev.mode === 'dry_run') {
      latestEventMode = ev.mode;
    }

    if (kind === 'heartbeat') {
      journalHeartbeatMode = ev.mode === 'live' ? 'live' : 'dry_run';
      journalHeartbeatOpenCount = num(ev.openCount) ?? journalHeartbeatOpenCount;
      journalHeartbeatUniverse = num(ev.universeSize) ?? journalHeartbeatUniverse;
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
      const journalMode: 'dry_run' | 'live' = ev.mode === 'live' ? 'live' : 'dry_run';
      const row = emptyOpenRow(posId, coin, displaySymbol, ts, journalMode, lane);
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

  const fileHb = readHlOscarHeartbeatFile(heartbeatPath);
  const mode =
    fileHb?.mode ?? journalHeartbeatMode ?? latestEventMode ?? 'dry_run';
  const allOpenRows = [...openById.values()];
  const paperPhantomCount =
    fileHb?.paperOpenCount ??
    allOpenRows.filter((r) => r.journalMode === 'dry_run').length;
  const visibleOpenRows =
    mode === 'live'
      ? allOpenRows.filter((r) => r.journalMode === 'live')
      : allOpenRows;
  const open: Paper2OpenItem[] = visibleOpenRows.map(
    ({ timeline: _tl, coin: _c, positionId: _p, journalMode: _m, ...rest }) => rest,
  );
  const openTimelines = new Map<string, TimelineEvent[]>(
    visibleOpenRows.map((r) => [r.mint, r.timeline]),
  );
  const openCount = open.length > 0 ? open.length : (fileHb?.openCount ?? journalHeartbeatOpenCount ?? 0);
  const universeSize = fileHb?.universeSize ?? journalHeartbeatUniverse ?? 0;
  const failReasons = [...failMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  const sizingFinal = sizing;
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
      openCount,
      paperPhantomCount,
      universeSize,
      leverage: sizingFinal.leverage,
      notionalUsd: sizingFinal.grossUsd,
      marginUsd: sizingFinal.marginUsd,
    },
  };
}

export function loadHlOscarPerpForDashboard(
  jsonlPath = hlOscarPerpDashboardJsonlPath(),
): HlOscarPerpDashboardLoad {
  const sizing = hlOscarSizingFromEnv();
  return loadHlOscarJournalForDashboard({
    jsonlPath,
    heartbeatPath: hlOscarPerpHeartbeatPath(),
    lane: 'hl-oscar-perp',
    sizing,
  });
}

export function loadHlOscarMajorsForDashboard(
  jsonlPath = hlOscarMajorsDashboardJsonlPath(),
): HlOscarPerpDashboardLoad {
  const sizing = hlOscarMajorsSizingFromEnv();
  return loadHlOscarJournalForDashboard({
    jsonlPath,
    heartbeatPath: hlOscarMajorsHeartbeatPath(),
    lane: 'hl-oscar-majors',
    sizing,
  });
}
