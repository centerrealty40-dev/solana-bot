/**
 * W8.0 Phase 7 — deterministic replay of `live_position_*` rows from LIVE_TRADES_PATH (P7-I1).
 */
import fs from 'node:fs';
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import { restoreOpenTradeFromJson } from '../papertrader/executor/store-restore.js';
import { restoreClosedTradeFromJson } from './strategy-snapshot.js';

/** Read UTF-8 lines; if file larger than `maxFileBytes`, only the trailing chunk is read (partial first line dropped). */
export function readLiveJournalLinesBounded(
  storePath: string,
  maxFileBytes: number,
): { lines: string[]; truncated: boolean } {
  const stat = fs.statSync(storePath);
  const sz = stat.size;
  if (sz <= maxFileBytes) {
    return { lines: fs.readFileSync(storePath, 'utf-8').split('\n'), truncated: false };
  }
  const fd = fs.openSync(storePath, 'r');
  try {
    const readLen = Math.min(maxFileBytes, sz);
    const start = sz - readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return { lines: text.split('\n'), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

const POSITION_KINDS = new Set([
  'live_position_open',
  'live_position_dca',
  'live_position_partial_sell',
  'live_position_close',
]);

export interface ReplayLiveStrategyJournalOpts {
  storePath: string;
  strategyId: string;
  /** If set, keep only the last N non-empty lines before parse (large files). */
  tailLines?: number;
  /** If set, drop rows whose envelope `ts` is strictly less than this. */
  sinceTs?: number;
  /**
   * Max journal file size (bytes) to load fully; beyond this only the trailing `maxFileBytes` chunk is scanned.
   * @default 26_214_400 (25 MiB) when passed from `loadLiveOscarConfig`; omit in tests for unbounded read.
   */
  maxFileBytes?: number;
  /**
   * W8.0-p7.1 — when false (default), `live_position_open` / `live_position_dca` rows without chain/simulate anchors are skipped.
   */
  trustGhostPositions?: boolean;
}

interface SortRow {
  ts: number;
  lineIdx: number;
  kind: string;
  mint: string;
  payload: Record<string, unknown>;
}

/** Collect canonical + legacy repair signatures from a serialized `openTrade` object. */
export function entryLegSignaturesFromOpenTradeJson(raw: Record<string, unknown>): string[] {
  const el = raw.entryLegSignatures;
  const out: string[] = [];
  if (Array.isArray(el)) {
    for (const x of el) {
      if (typeof x === 'string' && x.length >= 32) out.push(x);
    }
  }
  if (out.length > 0) return out;
  const legacyPrimary = raw.repairedFromTxSignature;
  if (typeof legacyPrimary === 'string' && legacyPrimary.length >= 32) out.push(legacyPrimary);
  const legs = raw.repairedLegSignatures;
  if (Array.isArray(legs)) {
    for (const x of legs) {
      if (typeof x === 'string' && x.length >= 32) out.push(x);
    }
  }
  return out;
}

export function openTradePassesReplayAnchorGate(raw: Record<string, unknown>, trustGhostPositions: boolean): boolean {
  if (trustGhostPositions) return true;
  const mode = raw.liveAnchorMode;
  if (mode === 'simulate') return true;
  return entryLegSignaturesFromOpenTradeJson(raw).length > 0;
}

export interface ReplayLiveStrategyJournalResult {
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  /** True when only a trailing byte chunk of the journal was scanned (`maxFileBytes` cap). */
  journalTruncated?: boolean;
}

function lineMatchesChannel(row: Record<string, unknown>): boolean {
  const ch = row.channel;
  return ch === undefined || ch === null || ch === 'live';
}

export function replayLiveStrategyJournal(opts: ReplayLiveStrategyJournalOpts): ReplayLiveStrategyJournalResult {
  const open = new Map<string, OpenTrade>();
  const closed: ClosedTrade[] = [];
  const trustGhost = opts.trustGhostPositions === true;

  if (!opts.storePath?.trim() || !fs.existsSync(opts.storePath)) {
    return { open, closed };
  }

  const maxB = opts.maxFileBytes ?? Number.MAX_SAFE_INTEGER;
  const { lines: rawLines, truncated } =
    maxB >= Number.MAX_SAFE_INTEGER
      ? { lines: fs.readFileSync(opts.storePath, 'utf-8').split('\n'), truncated: false }
      : readLiveJournalLinesBounded(opts.storePath, maxB);

  let lines = rawLines.filter((ln) => ln.trim().length > 0);
  if (opts.tailLines != null && opts.tailLines > 0 && lines.length > opts.tailLines) {
    lines = lines.slice(-opts.tailLines);
  }

  const batch: SortRow[] = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const ln = lines[lineIdx]!;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const sid = row.strategyId != null ? String(row.strategyId) : '';
    if (sid !== opts.strategyId) continue;
    if (!lineMatchesChannel(row)) continue;

    const kind = row.kind != null ? String(row.kind) : '';
    if (!POSITION_KINDS.has(kind)) continue;

    const tsRaw = row.ts;
    const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) ? tsRaw : 0;
    if (opts.sinceTs != null && ts < opts.sinceTs) continue;

    const mint = row.mint != null ? String(row.mint) : '';
    if (!mint) continue;

    batch.push({ ts, lineIdx, kind, mint, payload: row });
  }

  batch.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.lineIdx - b.lineIdx;
  });

  for (const row of batch) {
    switch (row.kind) {
      case 'live_position_open':
      case 'live_position_dca': {
        const otRaw = row.payload.openTrade;
        if (typeof otRaw !== 'object' || otRaw === null) break;
        const otr = otRaw as Record<string, unknown>;
        if (!openTradePassesReplayAnchorGate(otr, trustGhost)) break;
        const ot = restoreOpenTradeFromJson(otRaw as Partial<OpenTrade> & { mint: string });
        if (ot) open.set(row.mint, ot);
        break;
      }
      case 'live_position_partial_sell': {
        const otRaw = row.payload.openTrade;
        if (typeof otRaw !== 'object' || otRaw === null) break;
        const otr = otRaw as Record<string, unknown>;
        if (!openTradePassesReplayAnchorGate(otr, trustGhost)) break;
        const ot = restoreOpenTradeFromJson(otRaw as Partial<OpenTrade> & { mint: string });
        if (ot) open.set(row.mint, ot);
        break;
      }
      case 'live_position_close': {
        const ctRaw = row.payload.closedTrade;
        if (typeof ctRaw !== 'object' || ctRaw === null) break;
        const ct = restoreClosedTradeFromJson(ctRaw as Record<string, unknown>);
        if (ct) {
          open.delete(row.mint);
          closed.push(ct);
        }
        break;
      }
      default:
        break;
    }
  }

  return { open, closed, journalTruncated: truncated || undefined };
}
