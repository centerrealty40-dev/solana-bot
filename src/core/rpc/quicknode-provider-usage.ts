/**
 * QuickNode Console Admin API — суммарное потребление RPC-кредитов за интервал
 * (включая HTTP и WebSocket), см. https://www.quicknode.com/docs/console-api/usage/v0-usage-rpc
 *
 * Ключ: https://dashboard.quicknode.com/api-keys с правом CONSOLE_REST.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { child } from '../logger.js';

const log = child('quicknode-provider-usage');

const API_BASE = 'https://api.quicknode.com/v0/usage/rpc';

export type ProviderDailyCache = {
  dayUtc: string;
  providerCreditsUsed: number;
  windowStartSec: number;
  windowEndSec: number;
  polledAtMs: number;
  creditsRemaining?: number;
  planLimit?: number;
};

function cachePath(): string {
  return process.env.QUICKNODE_PROVIDER_CACHE_PATH || path.join('data', 'quicknode-provider-daily.json');
}

function readKeyFile(): string | null {
  const f = process.env.QUICKNODE_ADMIN_API_KEY_FILE?.trim();
  if (!f) return null;
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function adminApiKey(): string | null {
  const fromFile = readKeyFile();
  if (fromFile) return fromFile;
  const k =
    process.env.QUICKNODE_ADMIN_API_KEY?.trim() ||
    process.env.QUICKNODE_API_KEY?.trim() ||
    process.env.QN_ADMIN_API_KEY?.trim();
  return k || null;
}

function utcDayKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Unix sec UTC at today 00:00:00 */
export function utcDayStartSec(d = new Date()): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) / 1000);
}

function extractUsage(body: unknown): {
  credits_used: number;
  credits_remaining?: number;
  limit?: number;
  start_time?: number;
  end_time?: number;
} | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const inner = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
  const cu = inner.credits_used;
  const n = typeof cu === 'number' ? cu : typeof cu === 'string' ? Number(cu) : NaN;
  if (!Number.isFinite(n)) return null;
  const cr = inner.credits_remaining;
  const lim = inner.limit;
  const st = inner.start_time;
  const et = inner.end_time;
  return {
    credits_used: n,
    credits_remaining: typeof cr === 'number' ? cr : typeof cr === 'string' ? Number(cr) : undefined,
    limit: typeof lim === 'number' ? lim : typeof lim === 'string' ? Number(lim) : undefined,
    start_time: typeof st === 'number' ? st : undefined,
    end_time: typeof et === 'number' ? et : undefined,
  };
}

/**
 * Кредиты QuickNode за [startSec, endSec] (оба inclusive-ish по доке — границы в секундах).
 */
export async function fetchQuickNodeRpcUsageWindow(
  startSec: number,
  endSec: number,
): Promise<{ credits_used: number; credits_remaining?: number; limit?: number } | null> {
  const key = adminApiKey();
  if (!key) return null;
  const url = new URL(API_BASE);
  url.searchParams.set('start_time', String(startSec));
  url.searchParams.set('end_time', String(endSec));
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json', 'x-api-key': key },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'QuickNode usage/rpc HTTP error');
      return null;
    }
    const body = (await res.json()) as unknown;
    const u = extractUsage(body);
    if (!u) {
      log.warn({ body: JSON.stringify(body).slice(0, 400) }, 'QuickNode usage/rpc unexpected shape');
      return null;
    }
    return {
      credits_used: u.credits_used,
      credits_remaining: u.credits_remaining,
      limit: u.limit,
    };
  } catch (e) {
    log.warn({ err: String(e) }, 'QuickNode usage/rpc fetch failed');
    return null;
  }
}

/**
 * Сводка за текущий биллинг-период плана (без start/end — как в дашборде QuickNode).
 * В ответе есть credits_remaining и limit.
 */
export async function fetchQuickNodeBillingPeriodSummary(): Promise<{
  credits_used: number;
  credits_remaining: number;
  limit: number;
  start_time?: number;
  end_time?: number;
} | null> {
  const key = adminApiKey();
  if (!key) return null;
  try {
    const res = await fetch(API_BASE, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-api-key': key },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'QuickNode usage/rpc (billing period) HTTP error');
      return null;
    }
    const body = (await res.json()) as unknown;
    const u = extractUsage(body);
    if (!u) {
      log.warn({ body: JSON.stringify(body).slice(0, 400) }, 'QuickNode billing summary unexpected shape');
      return null;
    }
    const rem = u.credits_remaining;
    const lim = u.limit;
    if (
      rem === undefined ||
      lim === undefined ||
      !Number.isFinite(rem) ||
      !Number.isFinite(lim) ||
      lim <= 0
    ) {
      log.warn({ u }, 'QuickNode billing summary missing credits_remaining/limit');
      return null;
    }
    return {
      credits_used: u.credits_used,
      credits_remaining: rem,
      limit: lim,
      start_time: u.start_time,
      end_time: u.end_time,
    };
  } catch (e) {
    log.warn({ err: String(e) }, 'QuickNode billing summary fetch failed');
    return null;
  }
}

/** Текущие кредиты за календарный UTC-день (по данным провайдера). */
export async function fetchQuickNodeCreditsUsedUtcToday(): Promise<{
  credits_used: number;
  credits_remaining?: number;
  limit?: number;
  windowStartSec: number;
  windowEndSec: number;
} | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = utcDayStartSec();
  const r = await fetchQuickNodeRpcUsageWindow(startSec, nowSec);
  if (!r) return null;
  return { ...r, windowStartSec: startSec, windowEndSec: nowSec };
}

export function readProviderDailyCache(): ProviderDailyCache | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const j = JSON.parse(raw) as ProviderDailyCache;
    if (
      j &&
      typeof j.dayUtc === 'string' &&
      typeof j.providerCreditsUsed === 'number' &&
      typeof j.polledAtMs === 'number'
    ) {
      return j;
    }
  } catch {
    /* */
  }
  return null;
}

export function writeProviderDailyCache(c: ProviderDailyCache): void {
  const p = cachePath();
  const dir = path.dirname(p);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * Опрос провайдера и запись кэша. При смене UTC-дня кэш перезаписывается свежим окном.
 */
export async function refreshQuickNodeProviderDailyCache(): Promise<ProviderDailyCache | null> {
  const key = adminApiKey();
  if (!key) {
    if (process.env.QUICKNODE_ADMIN_API_KEY_FILE?.trim()) {
      log.warn(
        { file: process.env.QUICKNODE_ADMIN_API_KEY_FILE },
        'QUICKNODE_ADMIN_API_KEY_FILE missing or empty — add Console API key (one line, no spaces)',
      );
    } else {
      log.debug('no QuickNode Admin API key — skip provider usage poll');
    }
    return null;
  }
  const today = utcDayKey();
  const got = await fetchQuickNodeCreditsUsedUtcToday();
  if (!got) return null;
  const row: ProviderDailyCache = {
    dayUtc: today,
    providerCreditsUsed: got.credits_used,
    windowStartSec: got.windowStartSec,
    windowEndSec: got.windowEndSec,
    polledAtMs: Date.now(),
    creditsRemaining: got.credits_remaining,
    planLimit: got.limit,
  };
  writeProviderDailyCache(row);
  log.info(
    {
      dayUtc: row.dayUtc,
      providerCreditsUsed: row.providerCreditsUsed,
      creditsRemaining: row.creditsRemaining,
    },
    'quicknode provider daily usage refreshed',
  );
  return row;
}
