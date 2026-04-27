import { request } from 'undici';
type AnyResponseData = Awaited<ReturnType<typeof request>>;
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from './db/client.js';
import { config } from './config.js';
import { child } from './logger.js';

const log = child('helius-guard');

/**
 * Why this module exists
 * ----------------------
 * On 2026-04-19 we accidentally subscribed a Helius enhanced webhook to entire
 * DEX programs (Raydium, Pumpfun, Jupiter, Orca). Helius dutifully tried to
 * deliver every matching transaction — at ~hundreds per second — and burned
 * 984k of 1M monthly free credits in roughly one hour.
 *
 * Every outbound Helius API call now MUST go through `heliusFetch`. The guard:
 *   1. Refuses to call out at all when `HELIUS_MODE=off`.
 *   2. Tracks estimated credits in `helius_usage` (append-only ledger).
 *   3. Short-circuits when daily / monthly budgets are exceeded.
 *   4. Logs every attempt for forensic audit.
 *
 * The webhook registration code further refuses to subscribe to programs;
 * see {@link https://docs.helius.dev/webhooks-and-websockets} for the API.
 */

export type HeliusKind =
  | 'webhook_list'
  | 'webhook_create'
  | 'webhook_update'
  | 'webhook_delete'
  | 'wallet_history'
  | 'rpc_call'
  | 'other';

const KIND_CREDITS: Record<HeliusKind, number> = {
  webhook_list: 1,
  webhook_create: 5,
  webhook_update: 5,
  webhook_delete: 1,
  wallet_history: 100, // one /addresses/.../transactions page
  rpc_call: 1,
  other: 1,
};

export class HeliusGuardError extends Error {
  constructor(message: string, readonly reason: 'mode_off' | 'daily_cap' | 'monthly_cap' | 'no_key') {
    super(message);
    this.name = 'HeliusGuardError';
  }
}

interface UsageWindow {
  today: number;
  thisMonth: number;
}

let cache: { window: UsageWindow; expiresAt: number } | null = null;
const CACHE_MS = 30_000;

async function readUsage(): Promise<UsageWindow> {
  if (cache && cache.expiresAt > Date.now()) return cache.window;
  try {
    const rows = await db.execute(dsql`
      SELECT
        COALESCE(SUM(credits_estimate) FILTER (WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC')), 0)::int AS today,
        COALESCE(SUM(credits_estimate) FILTER (WHERE ts >= date_trunc('month', now() AT TIME ZONE 'UTC')), 0)::int AS month
      FROM ${schema.heliusUsage}
    `);
    const anyRows = rows as unknown as
      | { rows?: Array<{ today: number; month: number }> }
      | Array<{ today: number; month: number }>;
    const r = Array.isArray(anyRows) ? anyRows[0] : anyRows.rows?.[0];
    const window: UsageWindow = {
      today: Number(r?.today ?? 0),
      thisMonth: Number(r?.month ?? 0),
    };
    cache = { window, expiresAt: Date.now() + CACHE_MS };
    return window;
  } catch (err) {
    log.warn({ err: String(err) }, 'failed to read helius_usage; assuming zero (fail-open is dangerous, set mode=off if unsure)');
    return { today: 0, thisMonth: 0 };
  }
}

async function recordUsage(args: {
  kind: HeliusKind;
  credits: number;
  statusCode: number;
  note?: string;
}): Promise<void> {
  cache = null;
  try {
    await db.insert(schema.heliusUsage).values({
      kind: args.kind,
      creditsEstimate: args.credits,
      statusCode: args.statusCode,
      note: args.note?.slice(0, 500) ?? null,
    });
  } catch (err) {
    log.warn({ err: String(err) }, 'failed to record helius_usage row');
  }
}

export async function getUsageSnapshot(): Promise<{
  today: number;
  thisMonth: number;
  dailyBudget: number;
  monthlyBudget: number;
  dailyPctUsed: number;
  monthlyPctUsed: number;
  mode: string;
}> {
  const w = await readUsage();
  cache = null; // force fresh next time too
  return {
    today: w.today,
    thisMonth: w.thisMonth,
    dailyBudget: config.heliusDailyBudget,
    monthlyBudget: config.heliusMonthlyBudget,
    dailyPctUsed: Math.round((w.today / config.heliusDailyBudget) * 1000) / 10,
    monthlyPctUsed: Math.round((w.thisMonth / config.heliusMonthlyBudget) * 1000) / 10,
    mode: config.heliusMode,
  };
}

/**
 * Wraps an outbound HTTP request to Helius with mode/budget checks.
 *
 * Throws {@link HeliusGuardError} BEFORE the network call when:
 *   - HELIUS_MODE=off (never call out)
 *   - HELIUS_API_KEY is missing
 *   - daily or monthly credit budget already met
 *
 * Otherwise performs the request, records usage, and returns the response.
 */
export async function heliusFetch(args: {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  kind: HeliusKind;
  /** override the default credit estimate for unusual payload sizes */
  credits?: number;
  /** debug note (no secrets!) */
  note?: string;
}): Promise<AnyResponseData> {
  if (!config.heliusApiKey) {
    throw new HeliusGuardError('HELIUS_API_KEY is empty; refusing to call', 'no_key');
  }
  if (config.heliusMode === 'off') {
    throw new HeliusGuardError(
      `HELIUS_MODE=off; refusing ${args.kind} request to keep credits safe`,
      'mode_off',
    );
  }

  const credits = args.credits ?? KIND_CREDITS[args.kind] ?? 1;
  const usage = await readUsage();

  if (usage.today + credits > config.heliusDailyBudget) {
    await recordUsage({ kind: args.kind, credits: 0, statusCode: 0, note: 'BLOCKED daily cap' });
    throw new HeliusGuardError(
      `daily budget exceeded: used ${usage.today} + need ${credits} > cap ${config.heliusDailyBudget}`,
      'daily_cap',
    );
  }
  if (usage.thisMonth + credits > config.heliusMonthlyBudget) {
    await recordUsage({ kind: args.kind, credits: 0, statusCode: 0, note: 'BLOCKED monthly cap' });
    throw new HeliusGuardError(
      `monthly budget exceeded: used ${usage.thisMonth} + need ${credits} > cap ${config.heliusMonthlyBudget}`,
      'monthly_cap',
    );
  }

  const opts: Parameters<typeof request>[1] = {
    method: args.method ?? 'GET',
    headers: args.body ? { 'content-type': 'application/json' } : undefined,
    body: args.body ? JSON.stringify(args.body) : undefined,
  };

  const t0 = Date.now();
  let statusCode = 0;
  try {
    const res = await request(args.url, opts);
    statusCode = res.statusCode;
    return res;
  } catch (err) {
    statusCode = -1;
    throw err;
  } finally {
    const dur = Date.now() - t0;
    await recordUsage({
      kind: args.kind,
      credits,
      statusCode,
      note: `${args.method ?? 'GET'} ${args.note ?? ''} (${dur}ms)`,
    });
  }
}
