/**
 * BasePulse — dashboard loader for `/papertrader2` tile 5.
 * Reads BasePulse JSONL journal (synced from 72.62.152.201 or local path).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { iterJsonlLines, iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(
  process.env.DASHBOARD_BASEPULSE_TAIL_BYTES ?? process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 512 * 1024 * 1024,
);
/** BasePulse journal ~350MB — full scan below this cap avoids phantom opens from tail truncation. */
const FULL_SCAN_MAX = Number(
  process.env.DASHBOARD_BASEPULSE_FULL_SCAN_MAX_BYTES ??
    process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ??
    512 * 1024 * 1024,
);

/** Well-known Base token symbols when journal rows omit `symbol`. */
const BASE_KNOWN_SYMBOLS: Record<string, string> = {
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO',
  '0xbf927b841994731c573bdf09ceb0c6b0aa887cdd': 'VELVET',
  '0x9126236476efba9ad8ab77855c60eb5bf37586eb': 'CHECK',
};

/** GMGN token page for Base chain (same slug pattern as Solana `/sol/token/`). */
export function basePulseGmgnTokenUrl(tokenAddress: string): string {
  return `https://gmgn.ai/base/token/${encodeURIComponent(tokenAddress.trim())}`;
}

export function basePulseDashboardJsonlPath(): string {
  return (
    process.env.DASHBOARD_BASEPULSE_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'basepulse', 'basepulse-journal.jsonl')
  );
}

export type BasePulseDashboardLoad = {
  open: Paper2OpenItem[];
  closed: Array<Record<string, unknown>>;
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
};

type JournalEv = Record<string, unknown>;
type OpenRow = Paper2OpenItem & { timeline: TimelineEvent[] };

function* journalLines(filePath: string): Generator<string> {
  yield* iterJsonlLinesBounded(filePath, TAIL_BYTES, FULL_SCAN_MAX);
}

/** Position state from entire journal when it fits FULL_SCAN_MAX; else tail only. */
function* positionStateLines(filePath: string): Generator<string> {
  const size = fs.statSync(filePath).size;
  if (size <= FULL_SCAN_MAX) {
    yield* iterJsonlLines(filePath);
    return;
  }
  yield* journalLines(filePath);
}

function tsMs(ev: JournalEv): number {
  const t = ev.ts;
  if (typeof t === 'number' && t > 0) return t > 1e12 ? t : t * 1000;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseJournalLine(ln: string): JournalEv | null {
  try {
    return JSON.parse(ln) as JournalEv;
  } catch {
    return null;
  }
}

function eventTokenId(ev: JournalEv): string {
  const tokenRaw =
    typeof ev.token === 'string' ? ev.token : typeof ev.baseToken === 'string' ? ev.baseToken : '';
  const pairRaw = typeof ev.pair === 'string' ? ev.pair : '';
  const token = tokenRaw || pairRaw;
  return token ? tokenKey(token) : '';
}

function isPositionOpenEv(ev: JournalEv): boolean {
  const kind = typeof ev.kind === 'string' ? ev.kind : '';
  const type = typeof ev.type === 'string' ? ev.type : '';
  return kind === 'open' || type === 'live_open';
}

function isPositionCloseEv(ev: JournalEv): boolean {
  const kind = typeof ev.kind === 'string' ? ev.kind : '';
  const type = typeof ev.type === 'string' ? ev.type : '';
  return kind === 'close' || type === 'live_close';
}

/** Last live_open/live_close per token in the scanned window (reverse pass). */
function openTokenIdsFromTailReverse(lines: readonly string[]): Set<string> {
  const lastState = new Map<string, 'open' | 'close'>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = parseJournalLine(lines[i]!);
    if (!ev) continue;
    const tokenId = eventTokenId(ev);
    if (!tokenId || lastState.has(tokenId)) continue;
    if (isPositionOpenEv(ev)) lastState.set(tokenId, 'open');
    else if (isPositionCloseEv(ev)) lastState.set(tokenId, 'close');
  }
  const open = new Set<string>();
  for (const [id, state] of lastState) {
    if (state === 'open') open.add(id);
  }
  return open;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tokenKey(token: string): string {
  return token.trim().toLowerCase();
}

function shortToken(token: unknown): string {
  const s = typeof token === 'string' ? token : '';
  if (s.length <= 12) return s || '?';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function resolveSymbol(token: string, ev: JournalEv, symbolHints: Map<string, string>): string {
  const key = tokenKey(token);
  const known = BASE_KNOWN_SYMBOLS[key];
  if (known) return known;
  const fromEv = typeof ev.symbol === 'string' ? ev.symbol.trim() : '';
  if (fromEv) return fromEv.slice(0, 32);
  const hinted = symbolHints.get(key);
  if (hinted) return hinted;
  return shortToken(token);
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

function entryPriceFromEv(ev: JournalEv): number | null {
  return num(ev.fillPriceUsd) ?? num(ev.spotPxUsd) ?? num(ev.priceUsd);
}

function impactPctFromEv(ev: JournalEv): number | null {
  const bps = num(ev.priceImpactBps);
  return bps != null ? +(bps / 100).toFixed(3) : null;
}

function makeOpenRowFromEv(token: string, symbol: string, ev: JournalEv, ts: number): OpenRow {
  const positionUsd = num(ev.positionUsd) ?? 10;
  const price = entryPriceFromEv(ev);
  const pair = typeof ev.pair === 'string' ? ev.pair : null;
  const impactPct = impactPctFromEv(ev);
  const fdvUsd = num(ev.fdvUsd);
  const row: OpenRow = {
    mint: token,
    symbol,
    entryTs: ts,
    entryMcUsd: price ?? 0,
    entryRealMcUsd: fdvUsd,
    baselinePriceUsd: price,
    openedAtIso: new Date(ts).toISOString(),
    lane: 'base-pulse',
    source: 'base',
    metricType: 'price',
    features: null,
    btc: null,
    peakMcUsd: 0,
    peakPnlPct: 0,
    trailingArmed: false,
    totalInvestedUsd: positionUsd,
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: impactPct,
    entryPriceVerifyImpactPct: impactPct,
    entryPriceVerifySource: impactPct != null ? 'skipped' : null,
    pairAddress: pair,
    entryLiqUsd: num(ev.liquidityUsd),
    remainingFraction: 1,
    liveOscarTradeLane: null,
    isScalpWave: false,
    timeline: [],
  };
  pushTimeline(row.timeline, {
    ts,
    kind: 'open',
    label: 'Open dip-buy',
    spotPxUsd: price,
    amountUsd: positionUsd,
    txSignature: typeof ev.txHash === 'string' ? ev.txHash : null,
    contextNote:
      typeof ev.dropPct === 'number' ? `dip ${ev.dropPct.toFixed(1)}% · $${positionUsd.toFixed(0)}` : null,
  });
  return row;
}

export function loadBasePulseForDashboard(jsonlPath = basePulseDashboardJsonlPath()): BasePulseDashboardLoad {
  const openByToken = new Map<string, OpenRow>();
  const preOpenTimeline = new Map<string, TimelineEvent[]>();
  const closed: Array<Record<string, unknown>> = [];
  const failMap = new Map<string, number>();
  const symbolHints = new Map<string, string>();
  let firstTs = 0;
  let lastTs = 0;
  let evals1h = 0;
  let passed1h = 0;
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
    };
  }

  const lines = [...journalLines(jsonlPath)];
  const trulyOpenIds = openTokenIdsFromTailReverse([...positionStateLines(jsonlPath)]);

  for (const ln of lines) {
    const ev = parseJournalLine(ln);
    if (!ev) continue;
    const ts = tsMs(ev);
    if (ts <= 0) continue;
    if (firstTs === 0 || ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;

    const kind = typeof ev.kind === 'string' ? ev.kind : '';
    const type = typeof ev.type === 'string' ? ev.type : '';
    const tokenRaw =
      typeof ev.token === 'string' ? ev.token : typeof ev.baseToken === 'string' ? ev.baseToken : '';
    const pairRaw = typeof ev.pair === 'string' ? ev.pair : '';
    const token = tokenRaw || pairRaw;
    const tokenId = eventTokenId(ev);

    if (tokenId && typeof ev.symbol === 'string' && ev.symbol.trim()) {
      symbolHints.set(tokenId, ev.symbol.trim().slice(0, 32));
    }

    if (kind === 'eval-skip-open' || kind === 'eval-pass-open' || type === 'dip_signal') {
      if (ts >= oneHourAgo) {
        evals1h += 1;
        if (kind === 'eval-pass-open') passed1h += 1;
        const reason =
          typeof ev.reason === 'string'
            ? ev.reason
            : typeof (ev.decision as { reason?: string } | undefined)?.reason === 'string'
              ? (ev.decision as { reason: string }).reason
              : kind === 'eval-pass-open'
                ? 'pass'
                : 'skip';
        failMap.set(reason, (failMap.get(reason) ?? 0) + 1);
      }
    }

    if (type === 'entry_decision' && kind === 'eval-pass-open') {
      if (!tokenId || openByToken.has(tokenId)) continue;
      const tl = preOpenTimeline.get(tokenId) ?? [];
      const dropPct = num(ev.dropPct);
      const tier = typeof ev.dipTier === 'string' ? ev.dipTier : null;
      pushTimeline(tl, {
        ts,
        kind: 'strategy_note',
        label: 'Entry decision',
        spotPxUsd: entryPriceFromEv(ev),
        contextNote:
          dropPct != null
            ? `dip ${dropPct.toFixed(1)}%${tier ? ` · ${tier}` : ''}`
            : tier
              ? tier
              : null,
      });
      preOpenTimeline.set(tokenId, tl);
      continue;
    }

    if (type === 'swap_ok') {
      if (!tokenId || openByToken.has(tokenId)) continue;
      const tl = preOpenTimeline.get(tokenId) ?? [];
      const provider = typeof ev.provider === 'string' ? ev.provider : 'swap';
      pushTimeline(tl, {
        ts,
        kind: 'strategy_note',
        label: `Swap OK (${provider})`,
        txSignature: typeof ev.txHash === 'string' ? ev.txHash : null,
      });
      preOpenTimeline.set(tokenId, tl);
      continue;
    }

    if (kind === 'open' || type === 'live_open') {
      if (!tokenId) continue;
      const symbol = resolveSymbol(token, ev, symbolHints);
      const row = makeOpenRowFromEv(token, symbol, ev, ts);
      const pre = preOpenTimeline.get(tokenId);
      if (pre?.length) {
        row.timeline.unshift(...pre);
        preOpenTimeline.delete(tokenId);
      }
      openByToken.set(tokenId, row);
      continue;
    }

    if (kind === 'stage_add' || type === 'live_stage_add') {
      const row = openByToken.get(tokenId);
      if (!row) continue;
      const addEth = num(ev.addEth);
      const addUsd = num(ev.addUsd) ?? num(ev.positionUsd) ?? (addEth != null ? addEth * 2500 : null);
      if (addUsd != null && addUsd > 0) {
        row.totalInvestedUsd += addUsd;
      }
      pushTimeline(row.timeline, {
        ts,
        kind: 'scale_in',
        label: 'Stage-2 add',
        amountUsd: addUsd,
        txSignature: typeof ev.txHash === 'string' ? ev.txHash : null,
      });
      continue;
    }

    if (kind === 'close' || type === 'live_close') {
      const row = openByToken.get(tokenId);
      const pnlPct = num(ev.pnlPct) ?? 0;
      const pnlUsd = num(ev.pnlUsd) ?? 0;
      const exitReason = typeof ev.exitReason === 'string' ? ev.exitReason : 'close';
      const entryPx = row?.baselinePriceUsd ?? num(ev.entryPriceUsd);
      if (row) {
        pushTimeline(row.timeline, {
          ts,
          kind: 'close',
          label: exitReason,
          pnlPct,
          pnlUsd,
          reason: exitReason,
          txSignature: typeof ev.txHash === 'string' ? ev.txHash : null,
        });
        closed.unshift({
          mint: row.mint,
          symbol: row.symbol,
          entryTs: row.entryTs,
          exitTs: ts,
          entryPx,
          exitPx: entryPx != null && entryPx > 0 ? entryPx * (1 + pnlPct / 100) : null,
          pnlPct,
          pnlUsd,
          exitReason,
          timeline: row.timeline,
          durationMin: Math.max(0, Math.round((ts - row.entryTs) / 60_000)),
          __timeline: row.timeline,
        });
        openByToken.delete(tokenId);
      } else {
        closed.unshift({
          mint: token || `bp-close-${ts}`,
          symbol: resolveSymbol(token, ev, symbolHints),
          exitTs: ts,
          pnlPct,
          pnlUsd,
          exitReason,
        });
      }
    }
  }

  for (const id of openByToken.keys()) {
    if (!trulyOpenIds.has(id)) openByToken.delete(id);
  }

  const open: Paper2OpenItem[] = [...openByToken.values()].map(({ timeline: _tl, ...rest }) => rest);
  const openTimelines = new Map<string, TimelineEvent[]>(
    [...openByToken.entries()].map(([id, row]) => [row.mint, row.timeline]),
  );

  const failReasons = [...failMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    open,
    closed: closed.slice(0, 50),
    firstTs: firstTs || Date.now(),
    lastTs,
    resetTs: 0,
    evals1h,
    passed1h,
    failReasons,
    openTimelines,
  };
}
