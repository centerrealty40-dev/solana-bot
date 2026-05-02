/**
 * W8.0 Phase 7 — deterministic replay of `live_position_*` rows from LIVE_TRADES_PATH (P7-I1).
 */
import fs from 'node:fs';
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import { restoreOpenTradeFromJson } from '../papertrader/executor/store-restore.js';
import { restoreClosedTradeFromJson } from './strategy-snapshot.js';

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
}

interface SortRow {
  ts: number;
  lineIdx: number;
  kind: string;
  mint: string;
  payload: Record<string, unknown>;
}

export interface ReplayLiveStrategyJournalResult {
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
}

function lineMatchesChannel(row: Record<string, unknown>): boolean {
  const ch = row.channel;
  return ch === undefined || ch === null || ch === 'live';
}

export function replayLiveStrategyJournal(opts: ReplayLiveStrategyJournalOpts): ReplayLiveStrategyJournalResult {
  const open = new Map<string, OpenTrade>();
  const closed: ClosedTrade[] = [];

  if (!opts.storePath?.trim() || !fs.existsSync(opts.storePath)) {
    return { open, closed };
  }

  let lines = fs.readFileSync(opts.storePath, 'utf-8').split('\n');
  lines = lines.filter((ln) => ln.trim().length > 0);
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
      case 'live_position_dca':
      case 'live_position_partial_sell': {
        const otRaw = row.payload.openTrade;
        if (typeof otRaw !== 'object' || otRaw === null) break;
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

  return { open, closed };
}
