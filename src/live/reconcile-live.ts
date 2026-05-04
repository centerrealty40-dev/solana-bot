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

/** Merge parsed token accounts (raw amount atoms) by mint. */
function parseTokenAccountsRpcValue(raw: unknown): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
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

/** SPL Token + Token-2022 balances per mint (raw atoms). Used by live sells to avoid USD-math dust tails. */
export async function fetchLiveWalletSplBalancesByMint(
  cfg: LiveOscarConfig,
): Promise<Map<string, bigint> | null> {
  return fetchWalletTokenRawByMint(cfg, 'confirmed');
}
