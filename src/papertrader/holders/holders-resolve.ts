/**
 * W7.6 — Live SPL holder-count resolver via QuickNode.
 *
 * Strategy:
 *   1. positive/negative LRU cache (per mint) — TTLs from cfg
 *   2. singleflight: dedupe concurrent calls for the same mint
 *   3. (optional) try QN add-on method `qn_fetchTokenHolders`
 *   4. fallback: native getProgramAccounts on SPL Token (and optionally Token-2022)
 *      with memcmp(mint) filter and dataSlice(offset=32, length=40) — owner+amount.
 *      Count unique owners with non-zero balance, minus EXCLUDE_OWNERS.
 *   5. fire-and-forget DB writeback into tokens.holder_count + metadata.
 *
 * Errors policy is decided by the caller (cfg.holdersOnFail).
 */
import { PublicKey } from '@solana/web3.js';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import { qnBatchCall, qnCall, type QnRpcResult } from '../../core/rpc/qn-client.js';
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';

const log = child('holders-resolve');

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_ACCOUNT_DATA_SIZE = 165;

export type HolderResolveOk = {
  ok: true;
  count: number;
  source: 'qn_addon' | 'qn_gpa' | 'cache_pos';
  ageMs: number;
  fromCache: boolean;
};

export type HolderResolveFail = {
  ok: false;
  reason: 'budget' | 'rate' | 'http' | 'timeout' | 'rpc_error' | 'parse_error' | 'addon_unsupported';
  message?: string;
  fromCache?: boolean;
};

export type HolderResolveResult = HolderResolveOk | HolderResolveFail;

type GpaItem = {
  pubkey: string;
  account?: { data?: [string, string] | string | null };
};

type CacheEntry =
  | { kind: 'pos'; count: number; source: 'qn_addon' | 'qn_gpa'; ts: number }
  | { kind: 'neg'; reason: HolderResolveFail['reason']; ts: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<HolderResolveResult>>();

/** Stats reported by getHoldersResolveStats(). Reset across process restarts. */
const stats = {
  ok: 0,
  fail: 0,
  fromCache: 0,
  fromAddon: 0,
  fromGpa: 0,
  totalMs: 0,
  /** Last time stats were observed via getHoldersResolveStats() — for monitoring. */
  lastReadAt: 0,
};

/** Lazily computed Set of base64-encoded raw 32-byte owner keys to exclude (vaults, AMM, burn etc.). */
let excludeOwnersSetCache: { spec: string; set: Set<string> } | null = null;

function excludeOwnersAsBase64Set(addresses: string[]): Set<string> {
  const spec = addresses.join(',');
  if (excludeOwnersSetCache && excludeOwnersSetCache.spec === spec) return excludeOwnersSetCache.set;
  const set = new Set<string>();
  for (const a of addresses) {
    try {
      const buf = new PublicKey(a).toBuffer();
      set.add(buf.toString('base64'));
    } catch (e) {
      log.warn({ addr: a, err: (e as Error).message }, 'invalid exclude owner pubkey, skipped');
    }
  }
  excludeOwnersSetCache = { spec, set };
  return set;
}

/** Decode one base64-encoded SPL token-account dataSlice(offset=32,length=40) → owner+amount. */
export function parseOwnerAmountSlice(b64: string): { ownerB64: string; hasBalance: boolean } | null {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 40) return null;
    const ownerBytes = buf.subarray(0, 32);
    const amountBytes = buf.subarray(32, 40);
    let nonZero = false;
    for (let i = 0; i < amountBytes.length; i++) {
      if (amountBytes[i] !== 0) {
        nonZero = true;
        break;
      }
    }
    return { ownerB64: ownerBytes.toString('base64'), hasBalance: nonZero };
  } catch {
    return null;
  }
}

/** Extract base64 data string from a single getProgramAccounts result item. */
function extractB64Data(item: GpaItem): string | null {
  const d = item?.account?.data;
  if (!d) return null;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && typeof d[0] === 'string') return d[0];
  return null;
}

function nowMs(): number {
  return Date.now();
}

function getCachedFresh(mint: string, ttlPosMs: number, ttlNegMs: number): CacheEntry | null {
  const e = cache.get(mint);
  if (!e) return null;
  const age = nowMs() - e.ts;
  if (e.kind === 'pos' && age <= ttlPosMs) return e;
  if (e.kind === 'neg' && age <= ttlNegMs) return e;
  return null;
}

/**
 * Classic SPL Token: все ATA фиксированного размера — `dataSize` ускоряет GPA и снижает трафик.
 * Token-2022: те же поля mint/owner/amount в базе 165 байт, но **расширения увеличивают длину аккаунта**.
 * Фильтр `dataSize: 165` на Token-2022 **выкидывает** такие счета → сильный недосчёт холдеров в live-гейте.
 */
function gpaParamsClassicToken(programId: string, mint: string): unknown[] {
  return [
    programId,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      dataSlice: { offset: 32, length: 40 },
      filters: [{ dataSize: SPL_ACCOUNT_DATA_SIZE }, { memcmp: { offset: 0, bytes: mint } }],
    },
  ];
}

/** Token-2022 only: без `dataSize`, чтобы включить аккаунты с extensions. */
function gpaParamsToken2022AnySize(mint: string): unknown[] {
  return [
    TOKEN_2022_PROGRAM_ID,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
    },
  ];
}

function reasonFromQn(r: Exclude<QnRpcResult<unknown>, { ok: true }>): HolderResolveFail {
  return { ok: false, reason: r.reason, message: r.message };
}

async function callGpa(
  cfg: PaperTraderConfig,
  mint: string,
  includeToken2022: boolean,
): Promise<HolderResolveResult> {
  const items = includeToken2022
    ? [
        { method: 'getProgramAccounts', params: gpaParamsClassicToken(TOKEN_PROGRAM_ID, mint) },
        { method: 'getProgramAccounts', params: gpaParamsToken2022AnySize(mint) },
      ]
    : [{ method: 'getProgramAccounts', params: gpaParamsClassicToken(TOKEN_PROGRAM_ID, mint) }];

  const res = await qnBatchCall<GpaItem[]>(items, {
    feature: 'holders',
    creditsPerCall: cfg.holdersGpaCreditsPerCall,
    timeoutMs: cfg.holdersTimeoutMs,
  });
  if (!res.ok) return reasonFromQn(res);

  const owners = new Set<string>();
  const exclude = excludeOwnersAsBase64Set(cfg.holdersExcludeOwners);
  for (const part of res.value) {
    if (!Array.isArray(part)) continue;
    for (const it of part) {
      const b64 = extractB64Data(it);
      if (!b64) continue;
      const dec = parseOwnerAmountSlice(b64);
      if (!dec) continue;
      if (!dec.hasBalance) continue;
      if (exclude.has(dec.ownerB64)) continue;
      owners.add(dec.ownerB64);
    }
  }
  return { ok: true, count: owners.size, source: 'qn_gpa', ageMs: 0, fromCache: false };
}

async function callAddon(cfg: PaperTraderConfig, mint: string): Promise<HolderResolveResult> {
  /**
   * QN add-on `qn_fetchTokenHolders` (Token & NFT API). Some plans expose `total` directly.
   * We try once; if endpoint not enabled — return addon_unsupported and let caller fall back.
   */
  const res = await qnCall<{ total?: number; result?: { totalCount?: number } }>(
    'qn_fetchTokenHolders',
    [{ mint, perPage: 1, page: 1 }],
    { feature: 'holders', creditsPerCall: 30, timeoutMs: cfg.holdersTimeoutMs },
  );
  if (!res.ok) {
    if (res.reason === 'rpc_error' && /not\s*found|method|enabled/i.test(res.message ?? '')) {
      return { ok: false, reason: 'addon_unsupported', message: res.message };
    }
    return reasonFromQn(res);
  }
  const v = res.value;
  const total = Number(v?.total ?? v?.result?.totalCount ?? NaN);
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, reason: 'parse_error', message: 'addon: total missing' };
  }
  return { ok: true, count: total, source: 'qn_addon', ageMs: 0, fromCache: false };
}

function recordOk(res: HolderResolveOk, ms: number): void {
  stats.ok += 1;
  stats.totalMs += ms;
  if (res.fromCache) stats.fromCache += 1;
  else if (res.source === 'qn_addon') stats.fromAddon += 1;
  else if (res.source === 'qn_gpa') stats.fromGpa += 1;
}

function recordFail(_res: HolderResolveFail, ms: number): void {
  stats.fail += 1;
  stats.totalMs += ms;
}

async function dbWriteback(
  mint: string,
  count: number,
  source: 'qn_addon' | 'qn_gpa',
): Promise<void> {
  try {
    await db.execute(dsql.raw(`
      INSERT INTO tokens (mint, decimals, holder_count, metadata, updated_at)
      VALUES ('${mint.replace(/'/g, "''")}', 0, ${count},
              jsonb_build_object('holder_count_source', '${source}', 'holder_count_ts', extract(epoch from now())),
              now())
      ON CONFLICT (mint) DO UPDATE SET
        holder_count = EXCLUDED.holder_count,
        metadata = COALESCE(tokens.metadata, '{}'::jsonb) ||
          jsonb_build_object('holder_count_source', '${source}', 'holder_count_ts', extract(epoch from now())),
        updated_at = now()
    `));
  } catch (e) {
    log.debug({ mint, err: (e as Error).message }, 'holders writeback failed');
  }
}

export async function resolveHolderCount(
  cfg: PaperTraderConfig,
  mint: string,
): Promise<HolderResolveResult> {
  const ttlPos = cfg.holdersTtlMs;
  const ttlNeg = cfg.holdersNegTtlMs;
  const cached = getCachedFresh(mint, ttlPos, ttlNeg);
  if (cached) {
    if (cached.kind === 'pos') {
      const res: HolderResolveOk = {
        ok: true,
        count: cached.count,
        source: 'cache_pos',
        ageMs: nowMs() - cached.ts,
        fromCache: true,
      };
      recordOk(res, 0);
      return res;
    }
    const res: HolderResolveFail = { ok: false, reason: cached.reason, fromCache: true };
    recordFail(res, 0);
    return res;
  }

  const existing = inflight.get(mint);
  if (existing) return existing;

  const start = nowMs();
  const p = (async (): Promise<HolderResolveResult> => {
    let result: HolderResolveResult | null = null;

    if (cfg.holdersUseQnAddon) {
      const ad = await callAddon(cfg, mint);
      if (ad.ok) result = ad;
      else if (ad.reason !== 'addon_unsupported') {
        log.debug({ mint, reason: ad.reason }, 'holders addon failed, fallback to gpa');
      }
    }
    if (!result) {
      result = await callGpa(cfg, mint, cfg.holdersIncludeToken2022);
    }

    const ms = nowMs() - start;
    if (result.ok) {
      cache.set(mint, { kind: 'pos', count: result.count, source: result.source as 'qn_addon' | 'qn_gpa', ts: nowMs() });
      result.ageMs = 0;
      recordOk(result, ms);
      if (cfg.holdersDbWriteback && (result.source === 'qn_addon' || result.source === 'qn_gpa')) {
        void dbWriteback(mint, result.count, result.source);
      }
    } else {
      cache.set(mint, { kind: 'neg', reason: result.reason, ts: nowMs() });
      recordFail(result, ms);
    }
    return result;
  })();

  inflight.set(mint, p);
  try {
    return await p;
  } finally {
    inflight.delete(mint);
  }
}

export type HoldersResolveStats = {
  ok: number;
  fail: number;
  fromCache: number;
  fromAddon: number;
  fromGpa: number;
  avgMs: number;
};

export function getHoldersResolveStats(): HoldersResolveStats {
  const total = stats.ok + stats.fail;
  const avgMs = total > 0 ? Math.round(stats.totalMs / total) : 0;
  stats.lastReadAt = nowMs();
  return {
    ok: stats.ok,
    fail: stats.fail,
    fromCache: stats.fromCache,
    fromAddon: stats.fromAddon,
    fromGpa: stats.fromGpa,
    avgMs,
  };
}

/** Test helper — clears caches and stats. */
export function _resetHoldersResolverForTests(): void {
  cache.clear();
  inflight.clear();
  excludeOwnersSetCache = null;
  stats.ok = 0;
  stats.fail = 0;
  stats.fromCache = 0;
  stats.fromAddon = 0;
  stats.fromGpa = 0;
  stats.totalMs = 0;
  stats.lastReadAt = 0;
}
