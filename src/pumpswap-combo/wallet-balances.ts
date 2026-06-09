import { qnCall } from '../core/rpc/qn-client.js';
import type { LiveOscarConfig } from '../live/config.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import type { PumpswapComboConfig } from './config.js';

const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

let cache: { at: number; map: Map<string, bigint> } | null = null;

function tokenAccountEntriesFromOwnerRpcResult(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { value?: unknown }).value)) {
    return (raw as { value: unknown[] }).value;
  }
  return [];
}

function parseTokenAccountsRpcValue(raw: unknown): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const entry of tokenAccountEntriesFromOwnerRpcResult(raw)) {
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
    try {
      const amt = BigInt(ta.amount);
      if (amt === 0n) continue;
      out.set(mint, (out.get(mint) ?? 0n) + amt);
    } catch {
      /* skip */
    }
  }
  return out;
}

function walletPubkey58(liveCfg: LiveOscarConfig): string | null {
  const s = liveCfg.walletSecret?.trim();
  if (!s) return null;
  try {
    return loadLiveKeypairFromSecretEnv(s).publicKey.toBase58();
  } catch {
    return null;
  }
}

export async function ensureComboWalletBalances(
  cfg: PumpswapComboConfig,
  liveCfg: LiveOscarConfig,
): Promise<Map<string, bigint> | null> {
  const now = Date.now();
  const ttl = Math.max(3000, cfg.balanceCacheTtlMs);
  if (cache && now - cache.at < ttl) return cache.map;

  const pk = walletPubkey58(liveCfg);
  if (!pk) return null;

  const merged = new Map<string, bigint>();
  for (const programId of [SPL_TOKEN, SPL_TOKEN_2022]) {
    const res = await qnCall<unknown>(
      'getTokenAccountsByOwner',
      [pk, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      {
        feature: 'pumpswap_combo',
        creditsPerCall: 30,
        timeoutMs: 12_000,
        httpUrl: cfg.rpcUrl,
      },
    );
    if (!res.ok) return cache?.map ?? null;
    const m = parseTokenAccountsRpcValue(res.value);
    for (const [mint, amt] of m) merged.set(mint, (merged.get(mint) ?? 0n) + amt);
  }

  cache = { at: now, map: merged };
  return merged;
}

export function resetComboWalletBalanceCacheForTests(): void {
  cache = null;
}
