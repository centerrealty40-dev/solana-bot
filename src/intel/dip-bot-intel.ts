/**
 * W9.0 — dip_bot intel: buyers in `swaps` before Live Oscar anchor time (Postgres-first, zero RPC).
 */
import type postgres from 'postgres';
import { parseLiveEventBody } from '../live/events.js';
import type { LiveEventBody } from '../live/events.js';

export const DIP_BOT_TAG = 'dip_bot';
export const DIP_BOT_TAG_SOURCE = 'dip_bot_intel';

export type DipBotIntelEnv = {
  liveJsonlPath: string;
  /**
   * Accept anchors only if journal `strategyId` is in this list.
   * `null` = accept any `strategyId` that matches anchor shape (set env `DIP_BOT_ANCHOR_STRATEGY_IDS=*` or `all`).
   */
  strategyIds: string[] | null;
  tPreMs: number;
  minUsdPerAnchorBuyer: number;
  minHitsForTag: number;
  maxAnchorsPerRun: number;
  excludeWallet: string | null;
};

export function loadDipBotEnv(): DipBotIntelEnv {
  const root = process.cwd();
  const liveJsonlPath =
    process.env.DIP_BOT_LIVE_JSONL?.trim() ||
    process.env.LIVE_TRADES_PATH?.trim() ||
    `${root}/data/live/pt1-oscar-live.jsonl`;
  const rawIds = (process.env.DIP_BOT_ANCHOR_STRATEGY_IDS || 'live-oscar,pt1-oscar').trim();
  const lower = rawIds.toLowerCase();
  const strategyIdsAny =
    rawIds === '*' || lower === 'all' || process.env.DIP_BOT_ANCHOR_ANY_STRATEGY === '1';
  const strategyIdsList = rawIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== '*' && s.toLowerCase() !== 'all');
  return {
    liveJsonlPath,
    strategyIds: strategyIdsAny ? null : strategyIdsList.length > 0 ? strategyIdsList : ['live-oscar'],
    tPreMs: Math.max(5_000, Number(process.env.DIP_BOT_T_PRE_MS || 60_000)),
    minUsdPerAnchorBuyer: Math.max(0, Number(process.env.DIP_BOT_MIN_USD_ONE_EVENT || 50)),
    minHitsForTag: Math.max(1, Number(process.env.DIP_BOT_MIN_HITS || 3)),
    maxAnchorsPerRun: Math.max(1, Number(process.env.DIP_BOT_MAX_ANCHORS_PER_RUN || 30)),
    excludeWallet: process.env.DIP_BOT_EXCLUDE_WALLET?.trim() || process.env.LIVE_WALLET_PUBKEY?.trim() || null,
  };
}

function strategyAllowed(strategyIds: string[] | null, sid: string): boolean {
  if (strategyIds === null) return true;
  return strategyIds.includes(sid);
}

export function extractLiveOscarOpenAnchors(
  line: string,
  strategyIds: string[] | null,
): { mint: string; entryTsMs: number } | null {
  const t = line.trim();
  if (!t) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const sid = String(rec.strategyId || '');
  if (!strategyAllowed(strategyIds, sid)) return null;
  let body: LiveEventBody;
  try {
    body = parseLiveEventBody(obj);
  } catch {
    return null;
  }
  if (body.kind !== 'live_position_open') return null;
  const mint = String(body.mint || '').trim();
  const ot = body.openTrade as Record<string, unknown> | undefined;
  const entryTsMs = Number(ot?.entryTs ?? rec.entryTs ?? NaN);
  if (!mint || !Number.isFinite(entryTsMs) || entryTsMs <= 0) return null;
  return { mint, entryTsMs };
}

/**
 * Paper Oscar journal (`pt1-oscar.jsonl`): native rows use `kind: "open"` + `mint` + `entryTs`
 * (see `papertrader/main.ts` `journalAppend`). Distinct from mirrored `live_position_open`.
 */
export function extractPaperOscarOpenAnchors(
  line: string,
  strategyIds: string[] | null,
): { mint: string; entryTsMs: number } | null {
  const t = line.trim();
  if (!t) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const sid = String(rec.strategyId || '');
  if (!strategyAllowed(strategyIds, sid)) return null;
  if (String(rec.kind || '') !== 'open') return null;
  const mint = String(rec.mint || '').trim();
  const entryTsMs = Number(rec.entryTs ?? NaN);
  if (!mint || !Number.isFinite(entryTsMs) || entryTsMs <= 0) return null;
  return { mint, entryTsMs };
}

/** Try live mirror row first, then paper-native `open`. */
export function extractDipBotJournalAnchors(
  line: string,
  strategyIds: string[] | null,
): { mint: string; entryTsMs: number } | null {
  return extractLiveOscarOpenAnchors(line, strategyIds) ?? extractPaperOscarOpenAnchors(line, strategyIds);
}

export async function fetchBuyersInWindow(
  sql: postgres.Sql,
  args: { mint: string; windowStartMs: number; windowEndMs: number; minUsd: number; excludeWallet: string | null },
): Promise<{ wallet: string; buyUsd: number; swapsRows: number }[]> {
  // `postgres` tagged-template driver does not bind JS `Date`; use ISO for timestamptz.
  const t0 = new Date(args.windowStartMs).toISOString();
  const t1 = new Date(args.windowEndMs).toISOString();
  const rows = await sql<{ wallet: string; buy_usd: number; ct: number }[]>`
    SELECT wallet::text,
           COALESCE(SUM(amount_usd), 0)::float8 AS buy_usd,
           COUNT(*)::int AS ct
    FROM swaps
    WHERE base_mint = ${args.mint}
      AND side = 'buy'
      AND block_time >= ${t0}
      AND block_time < ${t1}
    GROUP BY wallet
    HAVING COALESCE(SUM(amount_usd), 0) >= ${args.minUsd}
  `;
  const out: { wallet: string; buyUsd: number; swapsRows: number }[] = [];
  for (const r of rows) {
    const w = String(r.wallet || '').trim();
    if (!w) continue;
    if (args.excludeWallet && w === args.excludeWallet) continue;
    const buyUsd = Number(r.buy_usd);
    const swapsRows = Number(r.ct ?? 0);
    if (!Number.isFinite(buyUsd) || buyUsd <= 0) continue;
    out.push({ wallet: w, buyUsd, swapsRows });
  }
  return out;
}

export async function upsertObservation(
  sql: postgres.Sql,
  wallet: string,
  anchorMint: string,
  anchorEntryTsMs: number,
  buyUsd: number,
): Promise<void> {
  await sql`
    INSERT INTO dip_bot_intel_observations (wallet, anchor_mint, anchor_entry_ts_ms, buy_usd)
    VALUES (${wallet}, ${anchorMint}, ${anchorEntryTsMs}, ${buyUsd})
    ON CONFLICT (wallet, anchor_mint, anchor_entry_ts_ms)
    DO UPDATE SET buy_usd = EXCLUDED.buy_usd
  `;
}

export async function markAnchorProcessed(
  sql: postgres.Sql,
  mint: string,
  entryTsMs: number,
  buyerRows: number,
  swapsRowsUsed: number,
): Promise<void> {
  await sql`
    INSERT INTO dip_bot_intel_anchors_processed
      (anchor_mint, anchor_entry_ts_ms, buyer_rows, swaps_rows_used)
    VALUES (${mint}, ${entryTsMs}, ${buyerRows}, ${swapsRowsUsed})
    ON CONFLICT (anchor_mint, anchor_entry_ts_ms) DO UPDATE SET
      processed_at = now(),
      buyer_rows = EXCLUDED.buyer_rows,
      swaps_rows_used = EXCLUDED.swaps_rows_used
  `;
}

export async function promoteWalletsToTags(sql: postgres.Sql, minHits: number): Promise<number> {
  const rows = await sql<{ wallet: string; hits: number; total_usd: number }[]>`
    SELECT wallet::text,
           COUNT(*)::int AS hits,
           COALESCE(SUM(buy_usd), 0)::float8 AS total_usd
    FROM dip_bot_intel_observations
    GROUP BY wallet
    HAVING COUNT(*) >= ${minHits}
  `;
  let n = 0;
  for (const r of rows) {
    const hits = Number(r.hits);
    const totalUsd = Number(r.total_usd);
    const confidence = Math.min(100, Math.floor(40 + hits * 15 + Math.min(25, totalUsd / 1000)));
    const ctx = JSON.stringify({
      hits,
      totalUsdObserved: totalUsd,
      promotedBy: DIP_BOT_TAG_SOURCE,
      ts: Date.now(),
    });
    await sql`
      INSERT INTO wallet_tags (wallet, tag, confidence, source, context)
      VALUES (${r.wallet}, ${DIP_BOT_TAG}, ${confidence}, ${DIP_BOT_TAG_SOURCE}, ${ctx})
      ON CONFLICT (wallet, tag, source) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        context = EXCLUDED.context,
        added_at = now()
    `;
    n++;
  }
  return n;
}
