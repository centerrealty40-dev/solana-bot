/**
 * SPL balances on the live wallet (RPC via `qnCall`, feature **`sim`** + optional `LIVE_RPC_HTTP_URL`).
 * Used by live sells and periodic tail sweep. Journal-vs-wallet SPL reconcile gates were removed.
 */
import { qnCall } from '../core/rpc/qn-client.js';
import type { LiveOscarConfig } from './config.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';

const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function walletPubkey58(cfg: LiveOscarConfig): string | null {
  const s = cfg.walletSecret?.trim();
  if (!s) return null;
  try {
    return loadLiveKeypairFromSecretEnv(s).publicKey.toBase58();
  } catch {
    return null;
  }
}

/**
 * `getTokenAccountsByOwner` JSON-RPC `result` is normally `{ context, value: [...] }`;
 * some gateways may return a bare array. Normalize to the account entry list.
 */
function tokenAccountEntriesFromOwnerRpcResult(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { value?: unknown }).value)) {
    return (raw as { value: unknown[] }).value;
  }
  return [];
}

/** Merge parsed token accounts (raw amount atoms) by mint. */
function parseTokenAccountsRpcValue(raw: unknown): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const entries = tokenAccountEntriesFromOwnerRpcResult(raw);
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const acc = (entry as { account?: { data?: unknown } }).account;
    const data = acc?.data;
    if (typeof data !== 'object' || data === null) continue;
    const parsed = (data as { parsed?: { info?: unknown } }).parsed;
    const info = parsed?.info;
    if (typeof info !== 'object' || info === null) continue;
    const mint = String((info as { mint?: string }).mint ?? '');
    const ta = (info as { tokenAmount?: { amount?: string } }).tokenAmount;
    if (!mint || typeof ta?.amount !== 'string') continue;
    let amt: bigint;
    try {
      amt = BigInt(ta.amount);
    } catch {
      continue;
    }
    if (amt === 0n) continue;
    out.set(mint, (out.get(mint) ?? 0n) + amt);
  }
  return out;
}

function qnReadOpts(cfg: LiveOscarConfig) {
  return {
    feature: 'sim' as const,
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
    httpUrl: cfg.liveRpcHttpUrl,
  };
}

type SplBalanceCommitment = 'processed' | 'confirmed' | 'finalized';

async function fetchWalletTokenRawByMint(
  cfg: LiveOscarConfig,
  commitment: SplBalanceCommitment = 'confirmed',
): Promise<Map<string, bigint> | null> {
  const pk = walletPubkey58(cfg);
  if (!pk) return null;
  const opts = qnReadOpts(cfg);
  const merged = new Map<string, bigint>();
  for (const programId of [SPL_TOKEN, SPL_TOKEN_2022]) {
    const res = await qnCall<unknown>(
      'getTokenAccountsByOwner',
      [pk, { programId }, { encoding: 'jsonParsed', commitment }],
      opts,
    );
    if (!res.ok) return null;
    const m = parseTokenAccountsRpcValue(res.value);
    for (const [mint, amt] of m) {
      merged.set(mint, (merged.get(mint) ?? 0n) + amt);
    }
  }
  return merged;
}

/**
 * 1.11.231 — TTL-cache для `fetchLiveWalletSplBalancesByMint`.
 *
 * Раньше каждый sell + tracker-tick запрашивал `getTokenAccountsByOwner` × 2 (SPL + Token-2022) =
 * ~120 credits на call. При активных позициях это 5-10 calls/min без причины — после прошлого
 * вызова баланс изменился только тогда, когда мы сами что-то купили/продали. Кэш с TTL
 * `LIVE_WALLET_SPL_BALANCE_CACHE_TTL_MS` (default 0 = off для backward-compat) урезает это в 5-10×.
 *
 * Инвалидация:
 *   - явно: после buy/sell в pipeline вызываем `invalidateLiveWalletSplBalanceCache()`.
 *   - неявно: TTL.
 */
let cachedBalances: Map<string, bigint> | null = null;
let cachedBalancesTs = 0;

export function invalidateLiveWalletSplBalanceCache(): void {
  cachedBalances = null;
  cachedBalancesTs = 0;
}

/** Test helper. */
export function _clearLiveWalletSplBalanceCacheForTests(): void {
  invalidateLiveWalletSplBalanceCache();
}

/** SPL Token + Token-2022 balances per mint (raw atoms). Used by live sells to avoid USD-math dust tails. */
export async function fetchLiveWalletSplBalancesByMint(
  cfg: LiveOscarConfig,
): Promise<Map<string, bigint> | null> {
  const ttlMs = Math.max(0, cfg.liveWalletSplBalanceCacheTtlMs ?? 0);
  if (ttlMs > 0 && cachedBalances && Date.now() - cachedBalancesTs < ttlMs) {
    return cachedBalances;
  }
  const fresh = await fetchWalletTokenRawByMint(cfg, 'confirmed');
  if (fresh && ttlMs > 0) {
    cachedBalances = fresh;
    cachedBalancesTs = Date.now();
  }
  return fresh;
}

/** Tests / diagnostics: parse `getTokenAccountsByOwner` `result` after unwrap. */
export function parseTokenBalancesFromGetTokenAccountsByOwnerResult(result: unknown): Map<string, bigint> {
  return parseTokenAccountsRpcValue(result);
}
