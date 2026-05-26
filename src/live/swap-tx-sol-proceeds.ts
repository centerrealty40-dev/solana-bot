/**
 * Parse gross SOL credited by a confirmed Jupiter-style swap from tx meta
 * (native SOL Δ + fee + WSOL token Δ). Shared by live sell accounting + slippage report.
 */
import { qnCall } from '../core/rpc/qn-client.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';

type TokenBalRow = {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmountString?: string;
    uiAmount?: number;
  };
};

function uiStringToRaw(ui: string, decimals: number): bigint {
  const neg = ui.startsWith('-');
  const s = neg ? ui.slice(1) : ui;
  const [intPart, fracPart = ''] = s.split('.');
  const ip = intPart.replace(/^0+/, '') || '0';
  const pad = decimals > 0 ? (fracPart + '0'.repeat(decimals)).slice(0, decimals) : '';
  const fracBig = decimals > 0 ? BigInt(pad.padEnd(decimals, '0')) : 0n;
  let v = BigInt(ip) * 10n ** BigInt(decimals) + fracBig;
  if (neg) v = -v;
  return v;
}

function rawFromRow(r: TokenBalRow): bigint {
  const amt = r.uiTokenAmount?.amount;
  if (typeof amt === 'string' && /^\d+$/.test(amt)) return BigInt(amt);
  const ui = r.uiTokenAmount?.uiAmountString;
  const dec = r.uiTokenAmount?.decimals;
  if (typeof ui === 'string' && typeof dec === 'number' && dec >= 0 && dec <= 24) return uiStringToRaw(ui, dec);
  return 0n;
}

/** Sum (post − pre) raw token amounts for mint + owner across all ATAs in the tx. */
export function mintOwnerRawDelta(meta: Record<string, unknown>, mint: string, owner: string): bigint {
  const pre = (meta.preTokenBalances ?? []) as TokenBalRow[];
  const post = (meta.postTokenBalances ?? []) as TokenBalRow[];
  const byIdx = new Map<number, { pre: bigint; post: bigint }>();
  for (const r of pre) {
    if (r.mint !== mint || r.owner !== owner) continue;
    const ix = r.accountIndex;
    const cur = byIdx.get(ix) ?? { pre: 0n, post: 0n };
    cur.pre = rawFromRow(r);
    byIdx.set(ix, cur);
  }
  for (const r of post) {
    if (r.mint !== mint || r.owner !== owner) continue;
    const ix = r.accountIndex;
    const cur = byIdx.get(ix) ?? { pre: 0n, post: 0n };
    cur.post = rawFromRow(r);
    byIdx.set(ix, cur);
  }
  let sum = 0n;
  for (const v of byIdx.values()) sum += v.post - v.pre;
  return sum;
}

export function signerIndex(accountKeys: unknown[], wallet: string): number {
  for (let i = 0; i < accountKeys.length; i++) {
    const k = accountKeys[i] as string | { pubkey?: string };
    const pk = typeof k === 'string' ? k : k?.pubkey;
    if (pk === wallet) return i;
  }
  return -1;
}

/** RPC `json` message: legacy accountKeys или v0 staticAccountKeys. */
export function messageAccountKeys(message: Record<string, unknown>): unknown[] {
  const ak = message.accountKeys;
  if (Array.isArray(ak) && ak.length > 0) return ak;
  const sak = message.staticAccountKeys;
  if (Array.isArray(sak) && sak.length > 0) return sak;
  return [];
}

/** Gross SOL credited by swap path: native Δ + fee + WSOL token Δ (lamports). */
export function solProceedsLamports(meta: Record<string, unknown>, walletPk: string, signerIdx: number): bigint {
  const preB = (meta.preBalances ?? []) as number[];
  const postB = (meta.postBalances ?? []) as number[];
  const fee = BigInt(typeof meta.fee === 'number' && meta.fee >= 0 ? meta.fee : 0);
  let native = 0n;
  if (signerIdx >= 0 && signerIdx < preB.length && signerIdx < postB.length) {
    native = BigInt(postB[signerIdx] ?? 0) - BigInt(preB[signerIdx] ?? 0);
  }
  const wsolDelta = mintOwnerRawDelta(meta, WRAPPED_SOL_MINT, walletPk);
  return native + fee + wsolDelta;
}

function qnReadOpts(cfg: LiveOscarConfig) {
  return {
    feature: 'sim' as const,
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
    httpUrl: cfg.liveRpcHttpUrl,
  };
}

/** Loads confirmed tx meta + message (same shape as slippage-from-journal). */
export async function fetchConfirmedTxMeta(
  cfg: LiveOscarConfig,
  signature: string,
): Promise<{ meta: Record<string, unknown>; message: Record<string, unknown> } | null> {
  const res = await qnCall<unknown>(
    'getTransaction',
    [
      signature,
      {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        commitment: cfg.liveConfirmCommitment,
      },
    ],
    qnReadOpts(cfg),
  );
  if (!res.ok) return null;
  const tx = res.value as {
    meta?: Record<string, unknown>;
    transaction?: { message?: Record<string, unknown> };
  } | null;
  if (tx == null || typeof tx !== 'object') return null;
  const err = tx.meta?.err;
  if (err != null && err !== false) return null;
  if (!tx.meta || typeof tx.meta !== 'object') return null;
  const msg = tx.transaction?.message;
  if (!msg || typeof msg !== 'object') return null;
  return { meta: tx.meta, message: msg };
}

/** SOL proceeds (lamports) credited to wallet by a confirmed token→SOL swap. */
export async function fetchConfirmedSwapSolProceedsLamports(
  cfg: LiveOscarConfig,
  signature: string,
  walletPk: string,
): Promise<bigint | null> {
  const tryOnce = async (): Promise<bigint | null> => {
    const loaded = await fetchConfirmedTxMeta(cfg, signature);
    if (!loaded) return null;
    const msg = loaded.message as Record<string, unknown>;
    const keys = messageAccountKeys(msg);
    const ix = signerIndex(keys, walletPk);
    if (ix < 0) return null;
    const lamports = solProceedsLamports(loaded.meta, walletPk, ix);
    return lamports > 0n ? lamports : null;
  };

  let out = await tryOnce();
  if (out == null) {
    await new Promise((r) => setTimeout(r, 320));
    out = await tryOnce();
  }
  if (out == null) {
    await new Promise((r) => setTimeout(r, 900));
    out = await tryOnce();
  }
  return out;
}
