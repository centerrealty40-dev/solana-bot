/**
 * Extract mint + USD price + SOL notional from one parsed Buy tx.
 * Used by buy-mint-resolve so we never need a second getTransaction for price.
 */
import { getSolUsd } from '../papertrader/pricing.js';
import { decodeAllowlistedDexSwapInserts } from '../parser/allowlisted-dex-swap.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import type { TokenBal, TxJsonParsed } from '../parser/rpc-http.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SKIP = new Set([WSOL, USDC, USDT]);

export type BuyEconomics = {
  mint: string;
  priceUsd: number;
  /** Native SOL + WSOL spent by fee-payer (approx buy size). */
  solNotional: number;
  amountUsd: number;
  signature: string;
};

function accountKeyPubkeys(tx: TxJsonParsed): string[] {
  const msg = tx.transaction?.message as
    | { accountKeys?: Array<string | { pubkey?: string }> }
    | undefined;
  const keys = msg?.accountKeys;
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k === 'string') out.push(k);
    else if (k && typeof k.pubkey === 'string') out.push(k.pubkey);
  }
  return out;
}

function uiAmount(b: TokenBal): number {
  const ui = b.uiTokenAmount?.uiAmount;
  if (typeof ui === 'number' && Number.isFinite(ui)) return ui;
  const amt = b.uiTokenAmount?.amount;
  const dec = b.uiTokenAmount?.decimals ?? 0;
  if (typeof amt === 'string' && /^\d+$/.test(amt)) {
    return Number(amt) / 10 ** dec;
  }
  return 0;
}

/**
 * Prefer fee-payer's largest positive non-stable token delta (Buy).
 * Fallback: .pump in account keys, then largest |delta| non-stable mint.
 */
export function extractMintFromParsedTx(tx: TxJsonParsed | null | undefined): string | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = accountKeyPubkeys(tx);
  const payer = keys[0] ?? '';
  const pre = new Map<string, number>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (!b.mint || SKIP.has(b.mint)) continue;
    const owner = b.owner ?? '';
    pre.set(`${owner}|${b.mint}`, uiAmount(b));
  }

  let bestPayer: { mint: string; delta: number } | null = null;
  let bestAny: { mint: string; abs: number } | null = null;

  for (const b of tx.meta.postTokenBalances ?? []) {
    if (!b.mint || SKIP.has(b.mint)) continue;
    const owner = b.owner ?? '';
    const key = `${owner}|${b.mint}`;
    const post = uiAmount(b);
    const before = pre.get(key) ?? 0;
    const delta = post - before;
    if (owner === payer && delta > 0) {
      if (!bestPayer || delta > bestPayer.delta) bestPayer = { mint: b.mint, delta };
    }
    const abs = Math.abs(delta);
    if (abs > 0 && (!bestAny || abs > bestAny.abs)) bestAny = { mint: b.mint, abs };
  }

  for (const b of tx.meta.postTokenBalances ?? []) {
    if (!b.mint || SKIP.has(b.mint)) continue;
    const owner = b.owner ?? '';
    const key = `${owner}|${b.mint}`;
    if (pre.has(key)) continue;
    const post = uiAmount(b);
    if (owner === payer && post > 0) {
      if (!bestPayer || post > bestPayer.delta) bestPayer = { mint: b.mint, delta: post };
    }
  }

  if (bestPayer?.mint) return bestPayer.mint;

  const pumpKey = keys.find((k) => k.endsWith('pump') && !SKIP.has(k));
  if (pumpKey) return pumpKey;

  return bestAny?.mint ?? null;
}

/** Fee-payer SOL spent (lamports drop) + WSOL token drop. */
export function feePayerSolSpent(tx: TxJsonParsed): number {
  const keys = accountKeyPubkeys(tx);
  const payer = keys[0] ?? '';
  const pre = tx.meta?.preBalances?.[0];
  const post = tx.meta?.postBalances?.[0];
  let native = 0;
  if (typeof pre === 'number' && typeof post === 'number' && pre > post) {
    native = (pre - post) / 1e9;
  }
  let wsol = 0;
  if (payer) {
    let before = 0;
    for (const b of tx.meta?.preTokenBalances ?? []) {
      if (b.mint === WSOL && b.owner === payer) before = uiAmount(b);
    }
    for (const b of tx.meta?.postTokenBalances ?? []) {
      if (b.mint !== WSOL || b.owner !== payer) continue;
      const after = uiAmount(b);
      if (before > after) wsol = Math.max(wsol, before - after);
    }
  }
  const spent = Math.max(native, wsol);
  return spent > 0.001 ? spent : 0;
}

export function extractBuyEconomics(
  tx: TxJsonParsed | null | undefined,
  opts?: { solUsd?: number },
): BuyEconomics | null {
  if (!tx?.meta || tx.meta.err) return null;
  const solUsd = opts?.solUsd ?? getSolUsd();
  if (!(solUsd > 0)) return null;

  const mint = extractMintFromParsedTx(tx);
  if (!mint) return null;

  const sig =
    typeof tx.transaction?.signatures?.[0] === 'string'
      ? tx.transaction.signatures[0]
      : '';
  if (!sig) return null;

  let priceUsd = 0;
  let amountUsd = 0;
  const swaps = decodeAllowlistedDexSwapInserts(tx, PUMP_FUN_PROGRAM_ID, solUsd);
  for (const s of swaps) {
    if (s.baseMint === mint && s.priceUsd > 0) {
      priceUsd = s.priceUsd;
      amountUsd = s.amountUsd > 0 ? s.amountUsd : 0;
      break;
    }
  }

  const solNotional = feePayerSolSpent(tx);
  if (!(amountUsd > 0) && solNotional > 0) {
    amountUsd = solNotional * solUsd;
  }
  if (!(priceUsd > 0) && amountUsd > 0) {
    const keys = accountKeyPubkeys(tx);
    const payer = keys[0] ?? '';
    let tok = 0;
    let before = 0;
    for (const b of tx.meta.preTokenBalances ?? []) {
      if (b.mint === mint && b.owner === payer) before = uiAmount(b);
    }
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (b.mint !== mint || b.owner !== payer) continue;
      tok = uiAmount(b) - before;
    }
    if (tok > 0) priceUsd = amountUsd / tok;
  }

  if (!(priceUsd > 0)) return null;

  return {
    mint,
    priceUsd,
    solNotional,
    amountUsd,
    signature: sig,
  };
}
