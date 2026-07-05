/**
 * LERA — cross-product dashboard tile on Oscar `/papertrader2`.
 * SSOT journal: `/opt/lera/data/live/pt1-lera-live.jsonl` (VPS 72.62.152.201).
 *
 * Oscar dashboard reads:
 * - local path `DASHBOARD_LERA_JSONL` / `LERA_LIVE_JOURNAL_PATH` (rsync via `scripts/ops/sync-lera-journal.sh`), or
 * - remote row from LERA dashboard `DASHBOARD_LERA_API_URL` (+ optional basic auth env).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';

export const LERA_DASHBOARD_STRATEGY_ID = 'live-lera';

export type LeraRemoteStrategyRow = {
  strategyId: string;
  file?: string;
  openCount?: number;
  closedCount?: number;
  startedAt?: number;
  lastTs?: number;
  hoursOfData?: number;
  sumPnlUsd?: number;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  totalPnlUsd?: number;
  winRate?: number;
  avgPnl?: number;
  avgPeak?: number;
  bestPnlUsd?: number;
  worstPnlUsd?: number;
  unrealizedUsd?: number;
  exits?: Record<string, number>;
  exitsBreakdown?: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }>;
  evals1h?: number;
  passed1h?: number;
  failReasons?: Array<{ reason: string; count: number }>;
  open?: unknown[];
  recentClosed?: unknown[];
  priorityFeeUsdTotal?: number;
  priceVerify?: {
    okCount: number;
    blockedCount: number;
    skippedCount: number;
    avgSlipPct: number | null;
    p90SlipPct: number | null;
  };
  liqDrain?: { exits: number; avgDropPct: number | null; p90DropPct: number | null };
  liveReconcileBoot?: {
    status?: string;
    skipReason?: string;
    divergentCount?: number;
    chainOnlyCount?: number;
    journalTruncated?: boolean;
  };
  liveReconcileReport?: {
    ts: number;
    ok: boolean;
    reconcileStatus: string;
    txAnchorMissing?: number;
    txAnchorRpcErrors?: number;
  };
};

export function leraDashboardJsonlPath(): string {
  return (
    process.env.DASHBOARD_LERA_JSONL?.trim() ||
    process.env.LERA_LIVE_JOURNAL_PATH?.trim() ||
    path.join(process.cwd(), 'data', 'lera', 'pt1-lera-live.jsonl')
  );
}

export function leraDashboardJournalReady(jsonlPath = leraDashboardJsonlPath()): boolean {
  try {
    return fs.existsSync(jsonlPath) && fs.statSync(jsonlPath).size > 0;
  } catch {
    return false;
  }
}

export function pickLeraStrategyRowFromApiPayload(data: unknown): LeraRemoteStrategyRow | null {
  if (!data || typeof data !== 'object') return null;
  const strategies = (data as { strategies?: unknown }).strategies;
  if (!Array.isArray(strategies)) return null;
  for (const raw of strategies) {
    if (!raw || typeof raw !== 'object') continue;
    const sid = (raw as { strategyId?: unknown }).strategyId;
    if (sid === LERA_DASHBOARD_STRATEGY_ID || sid === 'live-lera') {
      return raw as LeraRemoteStrategyRow;
    }
  }
  const first = strategies[0];
  return first && typeof first === 'object' ? (first as LeraRemoteStrategyRow) : null;
}

export async function fetchLeraStrategyRowFromRemoteApi(): Promise<LeraRemoteStrategyRow | null> {
  const url = process.env.DASHBOARD_LERA_API_URL?.trim();
  if (!url) return null;
  const user = process.env.DASHBOARD_LERA_API_BASIC_USER?.trim();
  const pass = process.env.DASHBOARD_LERA_API_BASIC_PASSWORD?.trim();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (user && pass) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  const timeoutMs = Number(process.env.DASHBOARD_LERA_API_TIMEOUT_MS ?? 12_000);
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12_000),
    });
    if (!res.ok) {
      console.warn('[dashboard] lera api fetch failed', res.status);
      return null;
    }
    const data = await res.json();
    const row = pickLeraStrategyRowFromApiPayload(data);
    if (!row) return null;
    return { ...row, strategyId: LERA_DASHBOARD_STRATEGY_ID };
  } catch (e) {
    console.warn('[dashboard] lera api fetch error', String(e).slice(0, 200));
    return null;
  }
}
