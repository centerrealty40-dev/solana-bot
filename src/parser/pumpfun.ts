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

/** Prefer first signer account (fee payer / authority), not merely index 0 for loaded-address layouts. */
function feePayerPubkey(tx: TxJsonParsed): string | null {
  const msg = tx.transaction?.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const keysRaw = (msg.accountKeys ?? msg.staticAccountKeys) as unknown;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0) return null;
  for (const k of keysRaw) {
    if (k && typeof k === 'object' && 'pubkey' in k) {
      const o = k as { pubkey?: string; signer?: boolean };
      if (o.signer && typeof o.pubkey === 'string') return o.pubkey;
    }
  }
  return accountKeysList(msg)[0] ?? null;
}

function logsArray(tx: TxJsonParsed): string[] {
  const lm = tx.meta?.logMessages;
  if (!Array.isArray(lm)) return [];
  return lm.map(String);
}

/**
 * Fast filter — avoids treating every pump mention as a trade.
 * Requires virtual-reserve lines (spec W4) + explicit Buy/Sell inside pump flow.
 */
export function isPumpfunSwap(tx: TxJsonParsed | null | undefined, pumpProgramId: string): boolean {
  if (!tx?.meta) return false;
  if (tx.meta.err != null) return false;
  const logs = logsArray(tx);
  const mentionsPump = logs.some((l) => l.includes(pumpProgramId));
  const buySell = logs.some((l) => l.includes('Instruction: Buy') || l.includes('Instruction: Sell'));
  const hasVirtualSol = logs.some((l) => /\bvSOL:\s*\d+/.test(l));
  const hasVirtualTok = logs.some((l) => /\bvToken:\s*\d+/.test(l));
  return mentionsPump && buySell && hasVirtualSol && hasVirtualTok;
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

/**
 * Minimal Pump.fun swap decoder (no Anchor IDL): Buy/Sell logs + signer WSOL vs SPL deltas.
 * Multi-leg / ambiguous mint movements → empty array (counts as decode failure upstream).
 */
export function decodePumpfunSwap(
  tx: TxJsonParsed | null | undefined,
  pumpProgramId: string,
  solUsd: number,
): SwapInsert[] {
  if (!tx || !isPumpfunSwap(tx, pumpProgramId)) return [];

  const wallet = feePayerPubkey(tx);
  if (!wallet) return [];

  const sig = tx.transaction?.signatures?.[0];
  if (!sig || typeof sig !== 'string') return [];

  const slot = typeof tx.slot === 'number' && Number.isFinite(tx.slot) ? tx.slot : null;
  if (slot === null) return [];

  const bt = tx.blockTime;
  if (typeof bt !== 'number' || !Number.isFinite(bt)) return [];

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

  if (baseDeltas.size === 0) return [];

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
  if (!baseMint || baseDelta === 0n || quoteDelta === 0n) return [];

  let side: 'buy' | 'sell';
  if (baseDelta > 0n && quoteDelta < 0n) side = 'buy';
  else if (baseDelta < 0n && quoteDelta > 0n) side = 'sell';
  else return [];

  const baseAmountRaw = baseDelta >= 0n ? baseDelta : -baseDelta;
  const quoteAmountRaw = quoteDelta >= 0n ? quoteDelta : -quoteDelta;

  const dec =
    decimalsForMint(tx.meta?.postTokenBalances ?? [], wallet, baseMint) ??
    decimalsForMint(tx.meta?.preTokenBalances ?? [], wallet, baseMint);
  if (dec === null || dec < 0 || dec > 18) {
    return [
      {
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
      },
    ];
  }

  const baseHuman = Number(baseAmountRaw) / 10 ** dec;
  const quoteHuman = Number(quoteAmountRaw) / 1e9;
  if (!Number.isFinite(baseHuman) || !Number.isFinite(quoteHuman) || baseHuman <= 0 || quoteHuman <= 0) {
    return [
      {
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
      },
    ];
  }

  const amountUsd = quoteHuman * solUsd;
  const priceUsd = amountUsd / baseHuman;

  return [
    {
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
    },
  ];
}
