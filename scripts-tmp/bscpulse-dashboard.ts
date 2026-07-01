/**
 * BscPulse — dashboard loader for `/papertrader2` tile 6.
 * Reads BscPulse JSONL journal (synced from 72.62.152.201 or local path).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

/** DexScreener pair/token page for BSC — prefer pair address from journal live_open. */
export function bscPulseDexScreenerUrl(tokenAddress: string, pairAddress?: string | null): string {
  const pair = typeof pairAddress === 'string' ? pairAddress.trim() : '';
  const token = tokenAddress.trim();
  const addr = pair || token;
  return `https://dexscreener.com/bsc/${encodeURIComponent(addr)}`;
}

export function bscPulseDashboardJsonlPath(): string {
  return (
    process.env.DASHBOARD_BSCPULSE_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'bscpulse', 'bscpulse-journal.jsonl')
  );
}

export type BscPulseDashboardLoad = {
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

function tsMs(ev: JournalEv): number {
  const t = ev.ts;
  if (typeof t === 'number' && t > 0) return t > 1e12 ? t : t * 1000;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tokenKey(token: string): string {
  return token.trim().toLowerCase();
}

function resolveToken(ev: JournalEv): string {
  if (typeof ev.token === 'string' && ev.token.trim()) return ev.token.trim();
  if (typeof ev.baseTokenAddress === 'string' && ev.baseTokenAddress.trim()) {
    return ev.baseTokenAddress.trim();
  }
  if (typeof ev.pair === 'string' && ev.pair.trim()) return ev.pair.trim();
  return '';
}

function resolveSymbol(token: string, ev: JournalEv, symbolHints: Map<string, string>): string {
  const key = tokenKey(token);
  const fromEv = typeof ev.symbol === 'string' ? ev.symbol.trim() : '';
  if (fromEv) return fromEv.slice(0, 32);
  const hinted = symbolHints.get(key);
  if (hinted) return hinted;
  return '?';
}

/** Map journal `reason` / partial exit to Oscar-style partial label. */
function partialSellLabel(ev: JournalEv): string {
  const reason = typeof ev.reason === 'string' ? ev.reason.trim() : '';
  const exitReason = typeof ev.exitReason === 'string' ? ev.exitReason.trim() : '';
  const sellFraction = num(ev.fraction) ?? num(ev.sellFraction);
  const sellPct = sellFraction != null ? Math.round(sellFraction * 100) : null;
  const tag = exitReason || reason || 'partial';
  return sellPct != null ? `Частичная продажа · ${tag} · ${sellPct}%` : `Частичная продажа · ${tag}`;
}

function shouldSkipDuplicatePartial(tl: TimelineEvent[], ts: number, label: string): boolean {
  const last = tl[tl.length - 1];
  if (!last || last.kind !== 'partial_sell') return false;
  if (last.label !== label) return false;
  return ts - last.ts < 45_000;
}

function eventKind(ev: JournalEv): string {
  if (typeof ev.kind === 'string' && ev.kind) return ev.kind;
  const type = typeof ev.type === 'string' ? ev.type : '';
  if (type === 'live_open' || type === 'paper_open') return 'open';
  if (type === 'live_close' || type === 'paper_close') return 'close';
  if (type === 'filter_reject') return 'eval-skip-open';
  if (type === 'entry_decision') return 'eval-pass-open';
  if (type === 'dip_signal') return 'dip_signal';
  return type;
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
  return num(ev.fillPriceUsd) ?? num(ev.spotPxUsd) ?? num(ev.priceUsd) ?? num(ev.price);
}

function makeOpenRowFromEv(token: string, symbol: string, ev: JournalEv, ts: number): OpenRow {
  const positionUsd = num(ev.positionUsd) ?? num(ev.legUsd) ?? 10;
  const price = entryPriceFromEv(ev);
  const pair = typeof ev.pair === 'string' ? ev.pair : null;
  const fdvUsd = num(ev.fdvUsd) ?? num(ev.mcapUsd);
  const row: OpenRow = {
    mint: token,
    symbol,
    entryTs: ts,
    entryMcUsd: price ?? 0,
    entryRealMcUsd: fdvUsd,
    baselinePriceUsd: price,
    openedAtIso: new Date(ts).toISOString(),
    lane: 'bsc-pulse',
    source: 'bsc',
    metricType: 'price',
    features: null,
    btc: null,
    peakMcUsd: 0,
    peakPnlPct: 0,
    trailingArmed: false,
    totalInvestedUsd: positionUsd,
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: null,
    entryPriceVerifyImpactPct: null,
    entryPriceVerifySource: null,
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
    contextNote: (() => {
      const dip = num(ev.dropPct) ?? num(ev.dipPct);
      return dip != null ? `dip ${Math.abs(dip).toFixed(1)}% · $${positionUsd.toFixed(0)}` : null;
    })(),
  });
  return row;
}

export function loadBscPulseForDashboard(jsonlPath = bscPulseDashboardJsonlPath()): BscPulseDashboardLoad {
  const openByToken = new Map<string, OpenRow>();
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

    const kind = eventKind(ev);
    const token = resolveToken(ev);
    const tokenId = token ? tokenKey(token) : '';

    if (tokenId && typeof ev.symbol === 'string' && ev.symbol.trim()) {
      symbolHints.set(tokenId, ev.symbol.trim().slice(0, 32));
    }

    if (kind === 'eval-skip-open' || kind === 'eval-pass-open' || kind === 'dip_signal') {
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

    if (kind === 'open') {
      if (!tokenId) continue;
      const symbol = resolveSymbol(token, ev, symbolHints);
      const row = makeOpenRowFromEv(token, symbol, ev, ts);
      openByToken.set(tokenId, row);
      continue;
    }

    if (
      kind === 'partial_sell' ||
      kind === 'partial_exit' ||
      (typeof ev.type === 'string' && (ev.type === 'live_partial' || ev.type === 'paper_partial'))
    ) {
      const row = openByToken.get(tokenId);
      if (!row) continue;
      const label = partialSellLabel(ev);
      if (shouldSkipDuplicatePartial(row.timeline, ts, label)) continue;
      const remainingFraction = num(ev.remainingFraction);
      if (remainingFraction != null && remainingFraction >= 0 && remainingFraction <= 1) {
        row.remainingFraction = remainingFraction;
      } else {
        const fraction = num(ev.fraction) ?? num(ev.sellFraction);
        if (fraction != null && fraction > 0 && fraction <= 1) {
          row.remainingFraction = Math.max(0, (row.remainingFraction ?? 1) * (1 - fraction));
        }
      }
      const pnlPct = num(ev.pnlPct);
      pushTimeline(row.timeline, {
        ts,
        kind: 'partial_sell',
        label,
        pnlPct,
        sizePct: num(ev.fraction) ?? num(ev.sellFraction),
        remainingFraction: row.remainingFraction ?? null,
        reason:
          typeof ev.exitReason === 'string'
            ? ev.exitReason
            : typeof ev.reason === 'string'
              ? ev.reason
              : null,
        txSignature: typeof ev.txHash === 'string' ? ev.txHash : null,
        contextNote:
          row.remainingFraction != null
            ? `остаток позиции ${(row.remainingFraction * 100).toFixed(0)}%`
            : null,
      });
      continue;
    }

    if (kind === 'stage_add' || kind === 'live_stage_add') {
      const row = openByToken.get(tokenId);
      if (!row) continue;
      const addUsd = num(ev.addUsd) ?? num(ev.positionUsd);
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

    if (kind === 'close') {
      const row = openByToken.get(tokenId);
      const pnlPct = num(ev.pnlPct) ?? 0;
      const pnlUsd = num(ev.pnlUsd) ?? 0;
      const exitReason =
        typeof ev.exitReason === 'string'
          ? ev.exitReason
          : typeof ev.reason === 'string'
            ? ev.reason
            : 'close';
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
          pairAddress: row.pairAddress ?? null,
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
      } else if (tokenId) {
        const pairFromEv = typeof ev.pair === 'string' ? ev.pair.trim() : null;
        closed.unshift({
          mint: token,
          symbol: resolveSymbol(token, ev, symbolHints),
          pairAddress: pairFromEv,
          exitTs: ts,
          pnlPct,
          pnlUsd,
          exitReason,
        });
      }
    }
  }

  const open: Paper2OpenItem[] = [...openByToken.values()].map(({ timeline: _tl, ...rest }) => rest);
  const openTimelines = new Map<string, TimelineEvent[]>(
    [...openByToken.entries()].map(([, row]) => [row.mint, row.timeline]),
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
