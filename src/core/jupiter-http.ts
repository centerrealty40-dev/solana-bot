import {
  acquireJupiterApiSlot,
  acquireJupiterApiSlotWithPriority,
  extendJupiterApiPause,
  jupiterRateLimitWaitMs,
} from './jupiter-api-gate.js';
import { recordJupiter429Event } from './jupiter-429-monitor.js';

export const JUPITER_QUOTE_URL_DEFAULT = 'https://api.jup.ag/swap/v1/quote';
export const JUPITER_SWAP_URL_DEFAULT = 'https://api.jup.ag/swap/v1/swap';
export const JUPITER_PRICE_V3_URL_DEFAULT = 'https://api.jup.ag/price/v3';

export function jupiterApiKey(): string | undefined {
  const key = process.env.JUPITER_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

export function jupiterJsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...extra,
  };
  const key = jupiterApiKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}

/** HTTP-layer 429 retries — keep low; sim/tracker retries happen on next tick. */
function jupiterHttp429MaxRetries(): number {
  const quote = process.env.JUPITER_QUOTE_429_MAX_RETRIES?.trim();
  const swap = process.env.JUPITER_SWAP_429_MAX_RETRIES?.trim();
  const raw = quote ?? swap;
  if (raw === '0') return 0;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(2, n) : 1;
}

function jupiterHttp429InitialBackoffMs(): number {
  const s = process.env.JUPITER_QUOTE_429_INITIAL_BACKOFF_MS?.trim();
  if (!s) return 1000;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(10_000, n) : 1000;
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

export type JupiterSwapQuoteGetResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status?: number; aborted?: boolean; gateSkipped?: true };

export type JupiterSwapPostResult =
  | { ok: true; swapTransaction: string }
  | { ok: false; reason: string; status?: number; aborted?: boolean; gateSkipped?: true };

async function jupiterFetchWith429Policy(args: {
  method: 'GET' | 'POST';
  url: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
  body?: string;
  source: 'quote' | 'swap';
  priority?: 'execution' | 'background';
}): Promise<
  | { ok: true; response: Response }
  | { ok: false; status?: number; aborted?: boolean; gateSkipped?: true }
> {
  const priority = args.priority ?? 'execution';
  const maxR = priority === 'background' ? 0 : jupiterHttp429MaxRetries();
  let backoff = jupiterHttp429InitialBackoffMs();

  for (let j = 0; j <= maxR; j++) {
    const granted = priority === 'background'
      ? await acquireJupiterApiSlotWithPriority('background')
      : (await acquireJupiterApiSlot(), true);
    if (!granted) return { ok: false, gateSkipped: true };
    const ac = new AbortController();
    const tt = setTimeout(() => ac.abort(), Math.max(500, args.timeoutMs));
    try {
      const resp = await fetch(args.url, {
        method: args.method,
        signal: ac.signal,
        headers: jupiterJsonHeaders(args.extraHeaders ?? {}),
        ...(args.body != null ? { body: args.body } : {}),
      });

      if (resp.status === 429 && j < maxR) {
        recordJupiter429Event({
          source: args.source,
          retriesAttempted: j + 1,
          background: priority === 'background',
        });
        const waitMs = jupiterRateLimitWaitMs(resp.headers, backoff);
        extendJupiterApiPause(Date.now() + waitMs);
        try {
          await resp.text();
        } catch {
          /* ignore body */
        }
        await sleepMs(waitMs);
        backoff = Math.min(8000, Math.floor(backoff * 1.8) || 1000);
        continue;
      }

      if (resp.status === 429) {
        recordJupiter429Event({
          source: args.source,
          exhausted: true,
          retriesAttempted: maxR + 1,
          background: priority === 'background',
        });
        const waitMs = jupiterRateLimitWaitMs(resp.headers, backoff);
        extendJupiterApiPause(Date.now() + waitMs);
      }

      return { ok: true, response: resp };
    } catch (e) {
      return { ok: false, aborted: (e as Error)?.name === 'AbortError' };
    } finally {
      clearTimeout(tt);
    }
  }

  recordJupiter429Event({
    source: args.source,
    exhausted: true,
    retriesAttempted: maxR + 1,
    background: priority === 'background',
  });
  return { ok: false, status: 429 };
}

/**
 * GET JSON for Jupiter `/swap/v1/quote`.
 * One HTTP-layer 429 retry max by default — execution/tracker retry on next tick.
 */
export async function fetchJupiterSwapQuoteGetResult(args: {
  url: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
  priority?: 'execution' | 'background';
}): Promise<JupiterSwapQuoteGetResult> {
  const fetched = await jupiterFetchWith429Policy({
    method: 'GET',
    url: args.url,
    timeoutMs: args.timeoutMs,
    extraHeaders: args.extraHeaders,
    source: 'quote',
    priority: args.priority,
  });
  if (!fetched.ok) {
    return {
      ok: false,
      status: fetched.status,
      aborted: fetched.aborted,
      ...(fetched.gateSkipped ? { gateSkipped: true as const } : {}),
    };
  }

  const resp = fetched.response;
  if (!resp.ok) {
    try {
      await resp.text();
    } catch {
      /* ignore body */
    }
    return { ok: false, status: resp.status };
  }

  const raw = (await resp.json()) as unknown;
  const body =
    typeof raw === 'object' && raw != null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  if (!body) return { ok: false, status: resp.status };
  return { ok: true, body };
}

export async function fetchJupiterSwapQuoteGetJson(args: {
  url: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
  priority?: 'execution' | 'background';
}): Promise<Record<string, unknown> | null> {
  const r = await fetchJupiterSwapQuoteGetResult(args);
  return r.ok ? r.body : null;
}

/** POST `/swap/v1/swap` — build unsigned tx (live execution path). */
export async function fetchJupiterSwapPostResult(args: {
  url: string;
  timeoutMs: number;
  body: string;
  extraHeaders?: Record<string, string>;
  priority?: 'execution' | 'background';
}): Promise<JupiterSwapPostResult> {
  const fetched = await jupiterFetchWith429Policy({
    method: 'POST',
    url: args.url,
    timeoutMs: args.timeoutMs,
    extraHeaders: { 'content-type': 'application/json', ...(args.extraHeaders ?? {}) },
    body: args.body,
    source: 'swap',
    priority: args.priority,
  });
  if (!fetched.ok) {
    if (fetched.gateSkipped) return { ok: false, reason: 'gate-busy', gateSkipped: true };
    if (fetched.status === 429) return { ok: false, reason: 'swap-http-429', status: 429 };
    if (fetched.aborted) return { ok: false, reason: 'swap-timeout', aborted: true };
    return { ok: false, reason: 'swap-fetch' };
  }

  const resp = fetched.response;
  const txt = await resp.text();
  if (!resp.ok) {
    return { ok: false, reason: `swap-http-${resp.status}`, status: resp.status };
  }

  let parsed: { swapTransaction?: string };
  try {
    parsed = JSON.parse(txt) as { swapTransaction?: string };
  } catch {
    return { ok: false, reason: 'swap-parse' };
  }
  if (!parsed.swapTransaction || typeof parsed.swapTransaction !== 'string') {
    return { ok: false, reason: 'no-swap-tx' };
  }
  return { ok: true, swapTransaction: parsed.swapTransaction };
}

export function jupiterPriceV3Url(id: string): string {
  const url = new URL(JUPITER_PRICE_V3_URL_DEFAULT);
  url.searchParams.set('ids', id);
  return url.toString();
}
