/**
 * Shared QuickNode JSON-RPC client: reserve credits (global + per-feature), single POST, rollback on transport failure.
 */
import { fetch } from 'undici';
import { child } from '../logger.js';
import { releaseSolanaRpcCredits, reserveSolanaRpcCredits, solanaRpcMeterCounters } from './solana-rpc-meter.js';
import {
  type QnFeature,
  QN_FEATURE_KEYS,
  readQnFeatureUsageForSnapshot,
  releaseQnFeatureCredits,
  reserveQnFeatureCredits,
  qnFeatureBudgetMonth,
} from './qn-feature-usage.js';

const log = child('qn-client');

export type { QnFeature } from './qn-feature-usage.js';

export type QnCallOpts = {
  feature: QnFeature;
  /** Для подсчёта кредитов; default 30 (Solana standard). */
  creditsPerCall?: number;
  /** Per-call timeout, ms. Default 8000. */
  timeoutMs?: number;
  /** POST JSON-RPC here instead of SA_RPC_HTTP_URL (Phase 6 LIVE_RPC_HTTP_URL). */
  httpUrl?: string;
};

export type QnRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: 'budget' | 'rate' | 'http' | 'timeout' | 'rpc_error';
      status?: number;
      message?: string;
    };

type JsonRpcSingle = {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: unknown[];
};

type JsonRpcResp = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function rpcUrl(): string {
  return (process.env.SA_RPC_HTTP_URL || '').trim();
}

function resolveRpcUrl(httpUrlOverride?: string): string {
  const o = httpUrlOverride?.trim();
  return o && o.length > 0 ? o : rpcUrl();
}

function defaultCreditsPerCall(opts: QnCallOpts): number {
  const n = opts.creditsPerCall ?? 30;
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function nextId(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

/** Snapshot для /api/qn/usage. */
export function qnUsageSnapshot(): {
  monthCredits: number;
  dayCredits: number;
  hourCredits: number;
  budgets: { month: number; day: number; hour: number };
  perFeature: Record<
    QnFeature,
    { monthCredits: number; dayCredits: number; hourCredits: number; budgetMonth: number }
  >;
} {
  const g = solanaRpcMeterCounters();
  const f = readQnFeatureUsageForSnapshot();
  const perFeature = {} as Record<
    QnFeature,
    { monthCredits: number; dayCredits: number; hourCredits: number; budgetMonth: number }
  >;
  for (const k of QN_FEATURE_KEYS) {
    const s = f.perFeature[k];
    perFeature[k] = {
      monthCredits: s.monthCredits,
      dayCredits: s.dayCredits,
      hourCredits: s.hourCredits,
      budgetMonth: qnFeatureBudgetMonth(k),
    };
  }
  return {
    monthCredits: g.monthCredits,
    dayCredits: g.dayCredits,
    hourCredits: g.hourCredits,
    budgets: g.budgets,
    perFeature,
  };
}

async function reserveAll(feature: QnFeature, cost: number): Promise<boolean> {
  const g = await reserveSolanaRpcCredits(cost);
  if (!g) return false;
  const f = await reserveQnFeatureCredits(feature, cost);
  if (!f) {
    await releaseSolanaRpcCredits(cost);
    return false;
  }
  return true;
}

async function releaseAll(feature: QnFeature, cost: number): Promise<void> {
  await releaseSolanaRpcCredits(cost);
  await releaseQnFeatureCredits(feature, cost);
}

export async function qnCall<T>(method: string, params: unknown[], opts: QnCallOpts): Promise<QnRpcResult<T>> {
  const url = resolveRpcUrl(opts.httpUrl);
  if (!url) {
    return { ok: false, reason: 'http', message: 'SA_RPC_HTTP_URL missing (or empty LIVE_RPC_HTTP_URL)' };
  }
  const cost = defaultCreditsPerCall(opts);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const reserved = await reserveAll(opts.feature, cost);
  if (!reserved) {
    return { ok: false, reason: 'budget' };
  }

  const body: JsonRpcSingle = { jsonrpc: '2.0', id: nextId(), method, params };
  log.debug({ method, feature: opts.feature, cost }, 'qn rpc request');

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(to);
    if (res.status === 429) {
      await releaseAll(opts.feature, cost);
      return { ok: false, reason: 'rate', status: res.status, message: 'Too Many Requests' };
    }
    if (!res.ok) {
      await releaseAll(opts.feature, cost);
      const t = await res.text().catch(() => '');
      return { ok: false, reason: 'http', status: res.status, message: t.slice(0, 500) || res.statusText };
    }
    const j = (await res.json()) as JsonRpcResp;
    if (j.error) {
      return {
        ok: false,
        reason: 'rpc_error',
        message: typeof j.error.message === 'string' ? j.error.message : JSON.stringify(j.error),
      };
    }
    return { ok: true, value: j.result as T };
  } catch (e) {
    clearTimeout(to);
    await releaseAll(opts.feature, cost);
    const name = e instanceof Error ? e.name : '';
    const isAbort = name === 'AbortError' || (e instanceof Error && e.message.includes('aborted'));
    if (isAbort) {
      return { ok: false, reason: 'timeout', message: e instanceof Error ? e.message : String(e) };
    }
    return { ok: false, reason: 'http', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Solana `getBalance` JSON-RPC: some nodes return a bare lamports integer; QuickNode often returns
 * `{ context: {...}, value: number }`. Parses either shape for Phase 5 / reconcile.
 */
export function lamportsFromGetBalanceResult(result: unknown): bigint | null {
  if (typeof result === 'number' && Number.isFinite(result)) {
    return BigInt(Math.floor(result));
  }
  if (typeof result === 'string' && /^\d+$/.test(result)) {
    try {
      return BigInt(result);
    } catch {
      return null;
    }
  }
  if (result && typeof result === 'object' && 'value' in result) {
    return lamportsFromGetBalanceResult((result as { value: unknown }).value);
  }
  return null;
}

export async function qnBatchCall<T>(
  items: Array<{ method: string; params: unknown[] }>,
  opts: QnCallOpts,
): Promise<QnRpcResult<T[]>> {
  const url = resolveRpcUrl(opts.httpUrl);
  if (!url) {
    return { ok: false, reason: 'http', message: 'SA_RPC_HTTP_URL missing (or empty LIVE_RPC_HTTP_URL)' };
  }
  if (items.length === 0) {
    return { ok: true, value: [] };
  }
  const per = defaultCreditsPerCall(opts);
  const cost = items.length * per;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const reserved = await reserveAll(opts.feature, cost);
  if (!reserved) {
    return { ok: false, reason: 'budget' };
  }

  const batch: JsonRpcSingle[] = items.map((it, i) => ({
    jsonrpc: '2.0' as const,
    id: nextId() + i,
    method: it.method,
    params: it.params,
  }));
  log.debug({ batch: items.length, feature: opts.feature, cost }, 'qn rpc batch request');

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: ac.signal,
    });
    clearTimeout(to);
    if (res.status === 429) {
      await releaseAll(opts.feature, cost);
      return { ok: false, reason: 'rate', status: res.status, message: 'Too Many Requests' };
    }
    if (!res.ok) {
      await releaseAll(opts.feature, cost);
      const t = await res.text().catch(() => '');
      return { ok: false, reason: 'http', status: res.status, message: t.slice(0, 500) || res.statusText };
    }
    const arr = (await res.json()) as JsonRpcResp[];
    if (!Array.isArray(arr) || arr.length !== items.length) {
      await releaseAll(opts.feature, cost);
      return { ok: false, reason: 'rpc_error', message: 'batch response shape mismatch' };
    }
    const out: T[] = [];
    for (let i = 0; i < arr.length; i++) {
      const j = arr[i];
      if (j?.error) {
        return {
          ok: false,
          reason: 'rpc_error',
          message: typeof j.error.message === 'string' ? j.error.message : JSON.stringify(j.error),
        };
      }
      out.push(j?.result as T);
    }
    return { ok: true, value: out };
  } catch (e) {
    clearTimeout(to);
    await releaseAll(opts.feature, cost);
    const name = e instanceof Error ? e.name : '';
    const isAbort = name === 'AbortError' || (e instanceof Error && e.message.includes('aborted'));
    if (isAbort) {
      return { ok: false, reason: 'timeout', message: e instanceof Error ? e.message : String(e) };
    }
    return { ok: false, reason: 'http', message: e instanceof Error ? e.message : String(e) };
  }
}
