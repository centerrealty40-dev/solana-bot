/**
 * BasePulse — dashboard loader for `/papertrader2` tile 5.
 * Reads BasePulse JSONL journal (synced from 72.62.152.201 or local path).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

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

function* journalLines(filePath: string): Generator<string> {
  yield* iterJsonlLinesBounded(filePath, TAIL_BYTES, FULL_SCAN_MAX);
}

function tsMs(ev: JournalEv): number {
  const t = ev.ts;
  if (typeof t === 'number' && t > 0) return t;
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

function shortToken(token: unknown): string {
  const s = typeof token === 'string' ? token : '';
  if (s.length <= 12) return s || '?';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
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

export function loadBasePulseForDashboard(jsonlPath = basePulseDashboardJsonlPath()): BasePulseDashboardLoad {
  const openByToken = new Map<string, Paper2OpenItem & { timeline: TimelineEvent[] }>();
  const closed: Array<Record<string, unknown>> = [];
  const failMap = new Map<string, number>();
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

    const kind = typeof ev.kind === 'string' ? ev.kind : '';
    const token = typeof ev.token === 'string' ? ev.token : typeof ev.pair === 'string' ? ev.pair : '';

    if (kind === 'eval-skip-open' || kind === 'eval-pass-open' || ev.type === 'dip_signal') {
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
      const positionUsd = num(ev.positionUsd) ?? 10;
      const price = num(ev.spotPxUsd) ?? num(ev.priceUsd);
      const row: Paper2OpenItem & { timeline: TimelineEvent[] } = {
        hash: token || `bp-${ts}`,
        coin: shortToken(token),
        displaySymbol: shortToken(token),
        side: 'buy',
        entryPx: price ?? 0,
        entryAnchorPx: price ?? 0,
        avgEntryPx: price ?? 0,
        initialNotionalUsd: positionUsd,
        currentNotionalUsd: positionUsd,
        entryTs: ts,
        openTs: ts,
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
      openByToken.set(token || row.hash, row);
      continue;
    }

    if (kind === 'stage_add') {
      const row = openByToken.get(token);
      if (!row) continue;
      const addEth = num(ev.addEth);
      pushTimeline(row.timeline, {
        ts,
        kind: 'scale_in',
        label: 'Stage-2 add',
        amountUsd: addEth != null ? addEth * 2500 : null,
        txSignature: typeof ev.txHash === 'string' ? ev.txHash : null,
      });
      continue;
    }

    if (kind === 'close') {
      const row = openByToken.get(token);
      const pnlPct = num(ev.pnlPct) ?? 0;
      const pnlUsd = num(ev.pnlUsd) ?? 0;
      const exitReason = typeof ev.exitReason === 'string' ? ev.exitReason : 'close';
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
          hash: row.hash,
          coin: row.coin,
          displaySymbol: row.displaySymbol,
          entryTs: row.entryTs,
          exitTs: ts,
          entryPx: row.entryPx,
          exitPx: row.entryPx * (1 + pnlPct / 100),
          pnlPct,
          pnlUsd,
          exitReason,
          timeline: row.timeline,
          holdMin: Math.max(0, Math.round((ts - row.entryTs) / 60_000)),
        });
        openByToken.delete(token);
      } else {
        closed.unshift({
          hash: token || `bp-close-${ts}`,
          coin: shortToken(token),
          displaySymbol: shortToken(token),
          exitTs: ts,
          pnlPct,
          pnlUsd,
          exitReason,
        });
      }
    }
  }

  const open = [...openByToken.values()].map(({ timeline, ...rest }) => ({
    ...rest,
    timeline,
  }));
  const openTimelines = new Map(open.map((o) => [o.hash, o.timeline ?? []]));

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
