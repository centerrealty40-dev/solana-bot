/**
 * W8.0 Phase 7 — SPL balances vs replayed `open` positions (RPC via `qnCall`, feature **`sim`** + optional `LIVE_RPC_HTTP_URL`).
 */
import { qnCall } from '../core/rpc/qn-client.js';
import type { OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig, LiveReconcileMode } from './config.js';
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

async function fetchWalletTokenRawByMint(cfg: LiveOscarConfig): Promise<Map<string, bigint> | null> {
  const pk = walletPubkey58(cfg);
  if (!pk) return null;
  const opts = {
    feature: 'sim' as const,
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
    httpUrl: cfg.liveRpcHttpUrl,
  };
  const merged = new Map<string, bigint>();
  for (const programId of [SPL_TOKEN, SPL_TOKEN_2022]) {
    const res = await qnCall<unknown>(
      'getTokenAccountsByOwner',
      [pk, { programId }, { encoding: 'jsonParsed' }],
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

function expectedTokenRawAtoms(ot: OpenTrade): bigint | null {
  const dec = ot.tokenDecimals ?? 6;
  if (!(ot.avgEntry > 0) || !(ot.totalInvestedUsd > 0)) return null;
  const usdRem = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
  const tokens = usdRem / ot.avgEntry;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const factor = 10 ** dec;
  const raw = BigInt(Math.max(0, Math.floor(tokens * factor + 1e-9)));
  return raw;
}

export interface ReconcileLiveWalletResult {
  ok: boolean;
  mode: LiveReconcileMode;
  mismatches: Array<{ mint: string; expectedRaw: string; actualRaw: string; note?: string }>;
}

export async function reconcileLiveWalletVsReplay(args: {
  liveCfg: LiveOscarConfig;
  open: Map<string, OpenTrade>;
  toleranceAtoms: bigint;
  mode: LiveReconcileMode;
}): Promise<ReconcileLiveWalletResult> {
  const { liveCfg, open, mode } = args;
  const tol = args.toleranceAtoms < 0n ? 0n : args.toleranceAtoms;
  const mismatches: ReconcileLiveWalletResult['mismatches'] = [];

  if (open.size === 0) {
    return { ok: true, mode, mismatches };
  }

  const chain = await fetchWalletTokenRawByMint(liveCfg);
  if (chain === null) {
    mismatches.push({
      mint: '_rpc_',
      expectedRaw: '0',
      actualRaw: '0',
      note: 'getTokenAccountsByOwner_failed',
    });
    return { ok: false, mode, mismatches };
  }

  for (const ot of open.values()) {
    const exp = expectedTokenRawAtoms(ot);
    if (exp === null) {
      mismatches.push({
        mint: ot.mint,
        expectedRaw: 'unknown',
        actualRaw: (chain.get(ot.mint) ?? 0n).toString(),
        note: 'expected_skipped_bad_avg_or_invested',
      });
      continue;
    }
    const act = chain.get(ot.mint) ?? 0n;
    const diff = exp > act ? exp - act : act - exp;
    if (diff > tol) {
      mismatches.push({
        mint: ot.mint,
        expectedRaw: exp.toString(),
        actualRaw: act.toString(),
      });
    }
  }

  return { ok: mismatches.length === 0, mode, mismatches };
}
