/**
 * Extends pump.fun–only ingest: Jupiter / PumpSwap / Raydium / Orca / Meteora txs
 * decoded via signer token-balance deltas (WSOL, native SOL, USDC, USDT as quote).
 *
 * Pump.fun bonding curve txs still prefer `decodePumpfunSwap` (exact log gate).
 */
import type { TokenBal, TxJsonParsed } from './rpc-http.js';
import { decodePumpfunSwap, signerPubkeys, WSOL_MINT } from './pumpfun.js';
import type { SwapInsert } from './pumpfun.js';

/** Pump.fun “PumpSwap” AMM (mainnet). */
export const PUMP_SWAP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT_MAINNET = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Jupiter aggregator v4 (legacy routes still seen on-chain). */
const JUPITER_V4 = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB';
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
/** Raydium CPMM — docs.raydium.io program-addresses */
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
/** Raydium AMM routing program */
const RAYDIUM_ROUTE = 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS';
const METEORA_DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
/** Meteora DAMM v2 — docs.meteora.ag */
const METEORA_DAMM_V2 = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PHOENIX = 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY';
const LIFINITY_V2 = '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c';
/** Moonit / Moonshot token launchpad (IDL V4 `address`, gomoonit/moonit-sdk). */
const MOONIT_LAUNCHPAD = 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG';

/** Programs that justify balance-based swap decode (hot paths for live-oscar / Jupiter). */
export const SWAPS_ALLOWLISTED_PROGRAM_IDS: ReadonlySet<string> = new Set([
  PUMP_FUN_PROGRAM_ID,
  PUMP_SWAP_AMM_PROGRAM_ID,
  MOONIT_LAUNCHPAD,
  JUPITER_V6,
  JUPITER_V4,
  RAYDIUM_AMM_V4,
  RAYDIUM_CLMM,
  RAYDIUM_CPMM,
  RAYDIUM_ROUTE,
  METEORA_DLMM,
  METEORA_DAMM_V2,
  ORCA_WHIRLPOOL,
  PHOENIX,
  LIFINITY_V2,
]);

function logsArray(tx: TxJsonParsed): string[] {
  const lm = tx.meta?.logMessages;
  if (!Array.isArray(lm)) return [];
  return lm.map(String);
}

/** Outer + inner jsonParsed instructions + `Program … invoke` log fallback. */
export function programIdsInvokedInTx(tx: TxJsonParsed): Set<string> {
  const out = new Set<string>();
  const msg = tx.transaction?.message as Record<string, unknown> | undefined;
  const collect = (ixs: unknown) => {
    if (!Array.isArray(ixs)) return;
    for (const ix of ixs) {
      if (!ix || typeof ix !== 'object') continue;
      const pid = (ix as { programId?: string }).programId;
      if (typeof pid === 'string' && pid.length >= 32) out.add(pid);
    }
  };
  if (msg) {
    collect(msg.instructions);
  }
  const meta = tx.meta as Record<string, unknown> | null | undefined;
  const inner = meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const b of inner) {
      collect((b as { instructions?: unknown }).instructions);
    }
  }
  for (const line of logsArray(tx)) {
    const m = line.match(/Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke/);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

export function txTouchesAllowlistedSwapProgram(tx: TxJsonParsed): boolean {
  const ids = programIdsInvokedInTx(tx);
  for (const p of SWAPS_ALLOWLISTED_PROGRAM_IDS) {
    if (ids.has(p)) return true;
  }
  return false;
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
      /* skip */
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

function fullAccountKeys(tx: TxJsonParsed): string[] {
  const msg = tx.transaction?.message as Record<string, unknown> | undefined;
  const ak = msg?.accountKeys ?? msg?.staticAccountKeys;
  const base: string[] = [];
  if (Array.isArray(ak)) {
    for (const k of ak) {
      if (typeof k === 'string') base.push(k);
      else if (k && typeof k === 'object' && 'pubkey' in k && typeof (k as { pubkey?: string }).pubkey === 'string') {
        base.push((k as { pubkey: string }).pubkey);
      }
    }
  }
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

function inferDex(ids: Set<string>): string {
  if (ids.has(MOONIT_LAUNCHPAD)) return 'moonshot';
  if (ids.has(PUMP_FUN_PROGRAM_ID)) return 'pumpfun';
  if (ids.has(PUMP_SWAP_AMM_PROGRAM_ID)) return 'pumpswap';
  if (ids.has(PHOENIX)) return 'phoenix';
  if (ids.has(LIFINITY_V2)) return 'lifinity';
  if (ids.has(RAYDIUM_CPMM) || ids.has(RAYDIUM_ROUTE) || ids.has(RAYDIUM_AMM_V4) || ids.has(RAYDIUM_CLMM)) {
    return 'raydium';
  }
  if (ids.has(METEORA_DLMM) || ids.has(METEORA_DAMM_V2)) return 'meteora';
  if (ids.has(ORCA_WHIRLPOOL)) return 'orca';
  if (ids.has(JUPITER_V6) || ids.has(JUPITER_V4)) return 'jupiter';
  return 'unknown';
}

/**
 * Balance-route swap for Jupiter-style bundles: pick dominant non-stable mint delta vs SOL/USDC/USDT spend.
 */
function tryDecodeAllowlistedRouteForWallet(
  wallet: string,
  tx: TxJsonParsed,
  sig: string,
  slot: number,
  bt: number,
  solUsd: number,
  dexLabel: string,
): SwapInsert | null {
  if (tx.meta?.err != null) return null;

  const pre = balanceTotalsForOwner(tx.meta?.preTokenBalances ?? [], wallet);
  const post = balanceTotalsForOwner(tx.meta?.postTokenBalances ?? [], wallet);
  const mints = new Set<string>([...pre.keys(), ...post.keys()]);

  let wsolDelta = 0n;
  let usdcDelta = 0n;
  let usdtDelta = 0n;
  const baseDeltas = new Map<string, bigint>();

  for (const mint of mints) {
    const d = (post.get(mint) ?? 0n) - (pre.get(mint) ?? 0n);
    if (d === 0n) continue;
    if (mint === WSOL_MINT) wsolDelta += d;
    else if (mint === USDC_MINT_MAINNET) usdcDelta += d;
    else if (mint === USDT_MINT_MAINNET) usdtDelta += d;
    else baseDeltas.set(mint, d);
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

  let spentLamports = 0n;
  if (typeof tx.meta?.fee === 'number') {
    const lam = walletLamportsDelta(tx, wallet);
    const fee = BigInt(tx.meta.fee);
    if (lam !== null && baseDelta > 0n && lam < 0n) {
      const spent = -lam - fee;
      if (spent > 0n) spentLamports = spent;
    }
  }

  const spentWsol = wsolDelta < 0n ? -wsolDelta : 0n;
  const spentUsdc = usdcDelta < 0n ? -usdcDelta : 0n;
  const spentUsdt = usdtDelta < 0n ? -usdtDelta : 0n;

  let side: 'buy' | 'sell';
  let quoteMint: string;
  let quoteAmountRaw: bigint;

  if (baseDelta > 0n) {
    side = 'buy';
    const solUsdSpend = Number(spentLamports) / 1e9 * solUsd + Number(spentWsol) / 1e9 * solUsd;
    const usdcUsd = Number(spentUsdc) / 1e6;
    const usdtUsd = Number(spentUsdt) / 1e6;
    const dominantUsd = Math.max(solUsdSpend, usdcUsd, usdtUsd);
    if (dominantUsd <= 0) return null;
    if (dominantUsd === solUsdSpend && (spentLamports > 0n || spentWsol > 0n)) {
      quoteMint = WSOL_MINT;
      quoteAmountRaw = spentLamports + spentWsol;
    } else if (dominantUsd === usdcUsd && spentUsdc > 0n) {
      quoteMint = USDC_MINT_MAINNET;
      quoteAmountRaw = spentUsdc;
    } else if (spentUsdt > 0n) {
      quoteMint = USDT_MINT_MAINNET;
      quoteAmountRaw = spentUsdt;
    } else if (spentWsol > 0n || spentLamports > 0n) {
      quoteMint = WSOL_MINT;
      quoteAmountRaw = spentLamports > 0n ? spentLamports : spentWsol;
    } else return null;
  } else if (baseDelta < 0n) {
    side = 'sell';
    const lamDv = walletLamportsDelta(tx, wallet);
    const recvLamports = lamDv !== null && lamDv > 0n ? lamDv : 0n;
    const recvWsol = wsolDelta > 0n ? wsolDelta : 0n;
    const recvUsdc = usdcDelta > 0n ? usdcDelta : 0n;
    const recvUsdt = usdtDelta > 0n ? usdtDelta : 0n;
    const solRecvUsd = Number(recvLamports + recvWsol) / 1e9 * solUsd;
    const dominantRecv = Math.max(solRecvUsd, Number(recvUsdc) / 1e6, Number(recvUsdt) / 1e6);
    if (dominantRecv <= 0) return null;
    if (dominantRecv === solRecvUsd && (recvLamports > 0n || recvWsol > 0n)) {
      quoteMint = WSOL_MINT;
      quoteAmountRaw = recvLamports + recvWsol;
    } else if (recvUsdc > 0n && Number(recvUsdc) / 1e6 >= dominantRecv * 0.99) {
      quoteMint = USDC_MINT_MAINNET;
      quoteAmountRaw = recvUsdc;
    } else if (recvUsdt > 0n) {
      quoteMint = USDT_MINT_MAINNET;
      quoteAmountRaw = recvUsdt;
    } else {
      quoteMint = WSOL_MINT;
      quoteAmountRaw = recvWsol > 0n ? recvWsol : recvLamports;
    }
  } else return null;

  const baseAmountRaw = baseDelta >= 0n ? baseDelta : -baseDelta;
  const baseDec =
    decimalsForMint(tx.meta?.postTokenBalances ?? [], wallet, baseMint) ??
    decimalsForMint(tx.meta?.preTokenBalances ?? [], wallet, baseMint);
  const quoteDec =
    quoteMint === WSOL_MINT
      ? 9
      : quoteMint === USDC_MINT_MAINNET || quoteMint === USDT_MINT_MAINNET
        ? 6
        : null;

  if (baseDec === null || baseDec < 0 || baseDec > 18 || quoteDec === null) {
    return {
      signature: sig,
      slot,
      blockTime: new Date(bt * 1000),
      wallet,
      baseMint,
      quoteMint,
      side,
      baseAmountRaw,
      quoteAmountRaw,
      priceUsd: 0,
      amountUsd: 0,
      dex: dexLabel,
      source: 'allowlisted_dex_parser_noprice',
    };
  }

  const baseHuman = Number(baseAmountRaw) / 10 ** baseDec;
  const quoteHuman = Number(quoteAmountRaw) / 10 ** quoteDec;
  if (!Number.isFinite(baseHuman) || !Number.isFinite(quoteHuman) || baseHuman <= 0 || quoteHuman <= 0) {
    return {
      signature: sig,
      slot,
      blockTime: new Date(bt * 1000),
      wallet,
      baseMint,
      quoteMint,
      side,
      baseAmountRaw,
      quoteAmountRaw,
      priceUsd: 0,
      amountUsd: 0,
      dex: dexLabel,
      source: 'allowlisted_dex_parser_noprice',
    };
  }

  let amountUsd = 0;
  if (quoteMint === WSOL_MINT) amountUsd = quoteHuman * solUsd;
  else amountUsd = quoteHuman;

  const priceUsd = amountUsd / baseHuman;

  return {
    signature: sig,
    slot,
    blockTime: new Date(bt * 1000),
    wallet,
    baseMint,
    quoteMint,
    side,
    baseAmountRaw,
    quoteAmountRaw,
    priceUsd,
    amountUsd,
    dex: dexLabel,
    source: 'allowlisted_dex_parser',
  };
}

/**
 * Prefer exact pump.fun decode; else decode allowlisted DEX routes by balance deltas.
 */
export function decodeAllowlistedDexSwapInserts(
  tx: TxJsonParsed | null | undefined,
  pumpProgramId: string,
  solUsd: number,
): SwapInsert[] {
  if (!tx) return [];
  const pf = decodePumpfunSwap(tx, pumpProgramId, solUsd);
  if (pf.length > 0) return pf;

  if (tx.meta?.err != null) return [];
  if (!txTouchesAllowlistedSwapProgram(tx)) return [];

  const sig = tx.transaction?.signatures?.[0];
  if (!sig || typeof sig !== 'string') return [];

  const slot = typeof tx.slot === 'number' && Number.isFinite(tx.slot) ? tx.slot : null;
  if (slot === null) return [];

  const bt = tx.blockTime;
  if (typeof bt !== 'number' || !Number.isFinite(bt)) return [];

  const ids = programIdsInvokedInTx(tx);
  const dexLabel = inferDex(ids);

  for (const wallet of signerPubkeys(tx)) {
    const row = tryDecodeAllowlistedRouteForWallet(wallet, tx, sig, slot, bt, solUsd, dexLabel);
    if (row) return [row];
  }

  return [];
}
