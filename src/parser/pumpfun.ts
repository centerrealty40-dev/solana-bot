import type { TxJsonParsed, TokenBal } from './rpc-http.js';

/** Pump.fun bonding curve program (mainnet). */
export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** Wrapped SOL mint — Pump.fun quotes against SOL (via WSOL ATA deltas). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export type SwapInsert = {
  signature: string;
  slot: number;
  blockTime: Date;
  wallet: string;
  baseMint: string;
  quoteMint: string;
  side: 'buy' | 'sell';
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  priceUsd: number;
  amountUsd: number;
  dex: string;
  source: string;
};

function accountKeysList(message: Record<string, unknown> | undefined): string[] {
  if (!message) return [];
  const ak = (message.accountKeys ?? message.staticAccountKeys) as unknown;
  if (!Array.isArray(ak)) return [];
  const out: string[] = [];
  for (const k of ak) {
    if (typeof k === 'string') out.push(k);
    else if (k && typeof k === 'object' && 'pubkey' in k && typeof (k as { pubkey?: unknown }).pubkey === 'string') {
      out.push((k as { pubkey: string }).pubkey);
    }
  }
  return out;
}

/** All tx signers (Pump swaps occasionally differ from fee-payer-only balance shifts). */
function signerPubkeys(tx: TxJsonParsed): string[] {
  const msg = tx.transaction?.message as Record<string, unknown> | undefined;
  if (!msg) return [];
  const keysRaw = (msg.accountKeys ?? msg.staticAccountKeys) as unknown;
  if (!Array.isArray(keysRaw)) return [];
  const out: string[] = [];
  for (const k of keysRaw) {
    if (k && typeof k === 'object' && 'pubkey' in k) {
      const o = k as { pubkey?: string; signer?: boolean };
      if (o.signer && typeof o.pubkey === 'string') out.push(o.pubkey);
    }
  }
  if (out.length > 0) return out;
  const fallback = accountKeysList(msg)[0];
  return fallback ? [fallback] : [];
}

function logsArray(tx: TxJsonParsed): string[] {
  const lm = tx.meta?.logMessages;
  if (!Array.isArray(lm)) return [];
  return lm.map(String);
}

/** Fast filter — Pump invoke + explicit Buy/Sell log line. */
export function isPumpfunSwap(tx: TxJsonParsed | null | undefined, pumpProgramId: string): boolean {
  if (!tx?.meta) return false;
  if (tx.meta.err != null) return false;
  const logs = logsArray(tx);
  const mentionsPump = logs.some((l) => l.includes(pumpProgramId));
  const buySell = logs.some((l) => l.includes('Instruction: Buy') || l.includes('Instruction: Sell'));
  return mentionsPump && buySell;
}

function fullAccountKeys(tx: TxJsonParsed): string[] {
  const msg = tx.transaction?.message as Record<string, unknown> | undefined;
  const base = accountKeysList(msg);
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded || typeof loaded !== 'object') return base;
  const w = Array.isArray(loaded.writable) ? loaded.writable.map(String) : [];
  const r = Array.isArray(loaded.readonly) ? loaded.readonly.map(String) : [];
  return [...base, ...w, ...r];
}

function walletLamportsDelta(tx: TxJsonParsed, wallet: string): bigint | null {
  const keys = fullAccountKeys(tx);
  const wi = keys.indexOf(wallet);
  const pre = tx.meta?.preBalances;
  const post = tx.meta?.postBalances;
  if (wi < 0 || !Array.isArray(pre) || !Array.isArray(post)) return null;
  const a = pre[wi];
  const b = post[wi];
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return BigInt(b) - BigInt(a);
}

function balanceTotalsForOwner(balances: TokenBal[] | null | undefined, owner: string): Map<string, bigint> {
  const m = new Map<string, bigint>();
  if (!balances) return m;
  for (const b of balances) {
    if (!b?.owner || b.owner !== owner || !b.mint) continue;
    const raw = b.uiTokenAmount?.amount;
    if (raw === undefined || raw === null) continue;
    try {
      const v = BigInt(String(raw));
      m.set(b.mint, (m.get(b.mint) ?? 0n) + v);
    } catch {
      /* skip malformed */
    }
  }
  return m;
}

function decimalsForMint(balances: TokenBal[] | null | undefined, owner: string, mint: string): number | null {
  if (!balances) return null;
  for (const b of balances) {
    if (b?.owner === owner && b.mint === mint && typeof b.uiTokenAmount?.decimals === 'number') {
      return b.uiTokenAmount.decimals;
    }
  }
  return null;
}

function tryDecodeForWallet(
  wallet: string,
  tx: TxJsonParsed,
  sig: string,
  slot: number,
  bt: number,
  solUsd: number,
): SwapInsert | null {
  const pre = balanceTotalsForOwner(tx.meta?.preTokenBalances ?? [], wallet);
  const post = balanceTotalsForOwner(tx.meta?.postTokenBalances ?? [], wallet);

  const mints = new Set<string>([...pre.keys(), ...post.keys()]);
  let quoteDelta = 0n;
  const baseDeltas = new Map<string, bigint>();

  for (const mint of mints) {
    const d = (post.get(mint) ?? 0n) - (pre.get(mint) ?? 0n);
    if (mint === WSOL_MINT) {
      quoteDelta += d;
    } else if (d !== 0n) {
      baseDeltas.set(mint, d);
    }
  }

  if (baseDeltas.size === 0) return null;

  let baseMint = '';
  let baseDelta = 0n;
  let bestAbs = 0n;
  for (const [mint, d] of baseDeltas) {
    const a = d >= 0n ? d : -d;
    if (a > bestAbs) {
      bestAbs = a;
      baseMint = mint;
      baseDelta = d;
    }
  }
  if (!baseMint || baseDelta === 0n) return null;

  // Buy path sometimes spends native SOL without touching WSOL token balances in meta.
  if (quoteDelta === 0n && baseDelta > 0n && typeof tx.meta?.fee === 'number') {
    const lam = walletLamportsDelta(tx, wallet);
    const fee = BigInt(tx.meta.fee);
    if (lam !== null && lam < 0n) {
      const spent = -lam - fee;
      if (spent > 0n) quoteDelta = -spent;
    }
  }

  if (quoteDelta === 0n) return null;

  let side: 'buy' | 'sell';
  if (baseDelta > 0n && quoteDelta < 0n) side = 'buy';
  else if (baseDelta < 0n && quoteDelta > 0n) side = 'sell';
  else return null;

  const baseAmountRaw = baseDelta >= 0n ? baseDelta : -baseDelta;
  const quoteAmountRaw = quoteDelta >= 0n ? quoteDelta : -quoteDelta;

  const dec =
    decimalsForMint(tx.meta?.postTokenBalances ?? [], wallet, baseMint) ??
    decimalsForMint(tx.meta?.preTokenBalances ?? [], wallet, baseMint);
  if (dec === null || dec < 0 || dec > 18) {
    return {
      signature: sig,
      slot,
      blockTime: new Date(bt * 1000),
      wallet,
      baseMint,
      quoteMint: WSOL_MINT,
      side,
      baseAmountRaw,
      quoteAmountRaw,
      priceUsd: 0,
      amountUsd: 0,
      dex: 'pumpfun',
      source: 'sa-parser-noprice',
    };
  }

  const baseHuman = Number(baseAmountRaw) / 10 ** dec;
  const quoteHuman = Number(quoteAmountRaw) / 1e9;
  if (!Number.isFinite(baseHuman) || !Number.isFinite(quoteHuman) || baseHuman <= 0 || quoteHuman <= 0) {
    return {
      signature: sig,
      slot,
      blockTime: new Date(bt * 1000),
      wallet,
      baseMint,
      quoteMint: WSOL_MINT,
      side,
      baseAmountRaw,
      quoteAmountRaw,
      priceUsd: 0,
      amountUsd: 0,
      dex: 'pumpfun',
      source: 'sa-parser-noprice',
    };
  }

  const amountUsd = quoteHuman * solUsd;
  const priceUsd = amountUsd / baseHuman;

  return {
    signature: sig,
    slot,
    blockTime: new Date(bt * 1000),
    wallet,
    baseMint,
    quoteMint: WSOL_MINT,
    side,
    baseAmountRaw,
    quoteAmountRaw,
    priceUsd,
    amountUsd,
    dex: 'pumpfun',
    source: 'sa-parser',
  };
}

/**
 * Minimal Pump.fun swap decoder (no Anchor IDL): Buy/Sell logs + SPL balance deltas.
 * Tries each signer until WSOL vs mint deltas line up.
 */
export function decodePumpfunSwap(
  tx: TxJsonParsed | null | undefined,
  pumpProgramId: string,
  solUsd: number,
): SwapInsert[] {
  if (!tx || !isPumpfunSwap(tx, pumpProgramId)) return [];

  const sig = tx.transaction?.signatures?.[0];
  if (!sig || typeof sig !== 'string') return [];

  const slot = typeof tx.slot === 'number' && Number.isFinite(tx.slot) ? tx.slot : null;
  if (slot === null) return [];

  const bt = tx.blockTime;
  if (typeof bt !== 'number' || !Number.isFinite(bt)) return [];

  for (const wallet of signerPubkeys(tx)) {
    const row = tryDecodeForWallet(wallet, tx, sig, slot, bt, solUsd);
    if (row) return [row];
  }

  return [];
}
