import { QUOTE_MINTS, isQuoteMint } from '../core/constants.js';
import { child } from '../core/logger.js';
import type { NormalizedSwap, SwapSide } from '../core/types.js';

const log = child('normalizer');

/**
 * Raw shape we expect from Helius enhanced webhook for a swap-like transaction.
 * See https://docs.helius.dev/api-reference/enhanced-transactions
 *
 * We are intentionally permissive in typing — Helius payloads vary by program.
 */
export interface HeliusTokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount: string | null;
  toTokenAccount: string | null;
  tokenAmount: number;
  mint: string;
}

export interface HeliusEnhancedTx {
  signature: string;
  slot: number;
  timestamp: number;
  type?: string;
  source?: string;
  feePayer?: string;
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: Array<{
        userAccount: string;
        tokenAmount: { tokenAmount: string; decimals: number };
        mint: string;
      }>;
      tokenOutputs?: Array<{
        userAccount: string;
        tokenAmount: { tokenAmount: string; decimals: number };
        mint: string;
      }>;
      innerSwaps?: unknown[];
    };
  };
  tokenTransfers?: HeliusTokenTransfer[];
  accountData?: Array<{ account: string; nativeBalanceChange: number }>;
  instructions?: unknown[];
}

/**
 * Convert a Helius enhanced transaction into 0..N normalized swap rows.
 *
 * Strategy:
 *   1. Find the user wallet (feePayer is a strong heuristic; fallback to first signer)
 *   2. Find the (base, quote) pair: quote is whichever side touches SOL/USDC/USDT, base is the other
 *   3. Compute amounts using decimals from token transfers
 *   4. Compute USD price from quote-side and a known quote price
 *
 * @param tx the enhanced transaction
 * @param quotePrices snapshot { mint -> usd price } for resolving USD value (SOL, USDC=1, USDT=1)
 */
export function normalizeHeliusSwap(
  tx: HeliusEnhancedTx,
  quotePrices: Record<string, number>,
): NormalizedSwap[] {
  const swap = tx.events?.swap;
  const wallet = tx.feePayer ?? null;
  if (!wallet) {
    log.debug({ sig: tx.signature }, 'no feePayer, skipping');
    return [];
  }

  // Fallback path: Helius did NOT label this tx as SWAP (the enhanced parser
  // only knows a small whitelist of DEX programs). Reconstruct the swap from
  // the raw tokenTransfers + nativeBalanceChange, which Helius always includes.
  // This gives us coverage for memecoin DEXes, custom bonding curves, new
  // aggregators, etc. — any program that moves a token in exchange for SOL/USDC.
  if (!swap) {
    return normalizeFromTokenTransfers(tx, wallet, quotePrices);
  }

  // Build (mint, signedAmount) map from token + native transfers from the wallet's perspective.
  // Positive: wallet received. Negative: wallet sent.
  const walletDelta = new Map<string, { raw: bigint; decimals: number }>();
  const SOL = QUOTE_MINTS.SOL;

  if (swap.nativeInput?.account === wallet && swap.nativeInput.amount) {
    const lamports = BigInt(swap.nativeInput.amount);
    walletDelta.set(SOL, { raw: -lamports, decimals: 9 });
  }
  if (swap.nativeOutput?.account === wallet && swap.nativeOutput.amount) {
    const lamports = BigInt(swap.nativeOutput.amount);
    const cur = walletDelta.get(SOL);
    walletDelta.set(SOL, {
      raw: (cur?.raw ?? 0n) + lamports,
      decimals: 9,
    });
  }

  for (const ti of swap.tokenInputs ?? []) {
    if (ti.userAccount !== wallet) continue;
    // Helius pumpfun bonding-curve swaps occasionally emit tokenInputs without
    // a `tokenAmount` object (the swap is fully described by the SOL leg + the
    // mint reference, with the token amount living elsewhere in the payload).
    // Skipping these legs avoids a crash and only loses one mint side; the
    // SOL leg + the matching tokenOutput on the other side still let us
    // reconstruct the swap.
    if (!ti.tokenAmount || ti.tokenAmount.tokenAmount === undefined || ti.tokenAmount.decimals === undefined) {
      log.debug({ sig: tx.signature, mint: ti.mint }, 'tokenInputs leg missing tokenAmount, skipping');
      continue;
    }
    const decimals = ti.tokenAmount.decimals;
    let raw: bigint;
    try { raw = BigInt(ti.tokenAmount.tokenAmount); }
    catch { continue; }
    const cur = walletDelta.get(ti.mint);
    walletDelta.set(ti.mint, { raw: (cur?.raw ?? 0n) - raw, decimals });
  }
  for (const to of swap.tokenOutputs ?? []) {
    if (to.userAccount !== wallet) continue;
    if (!to.tokenAmount || to.tokenAmount.tokenAmount === undefined || to.tokenAmount.decimals === undefined) {
      log.debug({ sig: tx.signature, mint: to.mint }, 'tokenOutputs leg missing tokenAmount, skipping');
      continue;
    }
    const decimals = to.tokenAmount.decimals;
    let raw: bigint;
    try { raw = BigInt(to.tokenAmount.tokenAmount); }
    catch { continue; }
    const cur = walletDelta.get(to.mint);
    walletDelta.set(to.mint, { raw: (cur?.raw ?? 0n) + raw, decimals });
  }

  if (walletDelta.size < 2) return [];

  // Identify quote side (the SOL/USDC/USDT that the wallet touched).
  let quoteMint: string | null = null;
  for (const mint of walletDelta.keys()) {
    if (isQuoteMint(mint)) {
      quoteMint = mint;
      break;
    }
  }
  if (!quoteMint) return [];
  const quote = walletDelta.get(quoteMint)!;
  const quotePrice =
    quoteMint === QUOTE_MINTS.USDC || quoteMint === QUOTE_MINTS.USDT
      ? 1
      : (quotePrices[quoteMint] ?? 0);
  if (quotePrice <= 0) return [];

  // For each non-quote mint with non-zero delta, emit a swap.
  const out: NormalizedSwap[] = [];
  for (const [mint, delta] of walletDelta) {
    if (mint === quoteMint) continue;
    if (delta.raw === 0n) continue;
    const side: SwapSide = delta.raw > 0n ? 'buy' : 'sell';
    const baseRaw = delta.raw > 0n ? delta.raw : -delta.raw;
    const quoteRaw = quote.raw < 0n ? -quote.raw : quote.raw;
    const quoteAmount = Number(quoteRaw) / 10 ** quote.decimals;
    const baseAmount = Number(baseRaw) / 10 ** delta.decimals;
    if (baseAmount <= 0) continue;
    const amountUsd = quoteAmount * quotePrice;
    const priceUsd = amountUsd / baseAmount;
    out.push({
      signature: tx.signature,
      slot: tx.slot,
      blockTime: new Date(tx.timestamp * 1000),
      wallet,
      baseMint: mint,
      quoteMint,
      side,
      baseAmountRaw: baseRaw,
      quoteAmountRaw: quoteRaw,
      priceUsd,
      amountUsd,
      dex: detectDex(tx.source),
      source: 'helius_webhook',
    });
  }
  return out;
}

function detectDex(source: string | undefined): NormalizedSwap['dex'] {
  if (!source) return 'unknown';
  const s = source.toUpperCase();
  if (s.includes('RAYDIUM')) return 'raydium';
  if (s.includes('JUPITER')) return 'jupiter';
  if (s.includes('PUMP')) return 'pumpfun';
  if (s.includes('METEORA')) return 'meteora';
  if (s.includes('ORCA') || s.includes('WHIRLPOOL')) return 'orca';
  return 'unknown';
}

/**
 * Reconstruct swaps from raw tokenTransfers + native balance change for the
 * feePayer wallet. Used when Helius did not classify the tx as SWAP (custom
 * DEX programs, new launchpads, etc).
 *
 * Algorithm:
 *   1. Compute the wallet's net delta per mint from tokenTransfers (signed):
 *        - if wallet is `toUserAccount`   -> delta += amount
 *        - if wallet is `fromUserAccount` -> delta -= amount
 *   2. Compute the wallet's SOL delta from accountData.nativeBalanceChange
 *      (lamports, signed). Subtract a fee allowance so dust-only fee payments
 *      don't masquerade as a SOL leg of a swap.
 *   3. If the wallet has BOTH a quote-side delta (SOL/USDC/USDT) AND at least
 *      one base-side delta with the OPPOSITE sign → it's a swap. Emit one row
 *      per base mint.
 *
 * We're strict about the opposite-sign requirement so airdrops, transfers and
 * pure liquidity provision don't get logged as swaps.
 */
function normalizeFromTokenTransfers(
  tx: HeliusEnhancedTx,
  wallet: string,
  quotePrices: Record<string, number>,
): NormalizedSwap[] {
  const transfers = tx.tokenTransfers ?? [];
  if (transfers.length === 0) return [];

  // mint -> signed amount (decimal-adjusted, as Helius gives it)
  const tokenDelta = new Map<string, number>();
  for (const t of transfers) {
    if (typeof t.tokenAmount !== 'number' || !isFinite(t.tokenAmount) || t.tokenAmount === 0) continue;
    if (t.toUserAccount === wallet) {
      tokenDelta.set(t.mint, (tokenDelta.get(t.mint) ?? 0) + t.tokenAmount);
    }
    if (t.fromUserAccount === wallet) {
      tokenDelta.set(t.mint, (tokenDelta.get(t.mint) ?? 0) - t.tokenAmount);
    }
  }

  // SOL leg: native balance change for our wallet (lamports). Skip dust below
  // 0.001 SOL so a tx that just paid 5000 lamports of network fee isn't mistaken
  // for a 0.000005 SOL "swap".
  let solDelta = 0;
  for (const a of tx.accountData ?? []) {
    if (a.account === wallet && typeof a.nativeBalanceChange === 'number') {
      solDelta += a.nativeBalanceChange;
    }
  }
  const SOL = QUOTE_MINTS.SOL;
  if (Math.abs(solDelta) >= 1_000_000) {
    // Convert lamports → SOL. Sign tells direction:
    //   solDelta < 0 (wallet spent SOL) → wallet bought a token
    //   solDelta > 0 (wallet received SOL) → wallet sold a token
    const cur = tokenDelta.get(SOL) ?? 0;
    tokenDelta.set(SOL, cur + solDelta / 1e9);
  }

  if (tokenDelta.size < 2) return [];

  // Find the quote side
  let quoteMint: string | null = null;
  for (const m of tokenDelta.keys()) {
    if (isQuoteMint(m)) {
      quoteMint = m;
      break;
    }
  }
  if (!quoteMint) return [];
  const quoteAmt = tokenDelta.get(quoteMint)!;
  if (quoteAmt === 0) return [];
  const quotePrice =
    quoteMint === QUOTE_MINTS.USDC || quoteMint === QUOTE_MINTS.USDT
      ? 1
      : (quotePrices[quoteMint] ?? 0);
  if (quotePrice <= 0) return [];

  const out: NormalizedSwap[] = [];
  for (const [mint, amt] of tokenDelta) {
    if (mint === quoteMint || amt === 0) continue;
    if (isQuoteMint(mint)) continue;
    // Opposite sign requirement: wallet received base ↔ spent quote (= buy),
    // or wallet sent base ↔ received quote (= sell).
    if (Math.sign(amt) === Math.sign(quoteAmt)) continue;

    const side: SwapSide = amt > 0 ? 'buy' : 'sell';
    const baseAmount = Math.abs(amt);
    const quoteAmount = Math.abs(quoteAmt);
    if (baseAmount <= 0) continue;
    const amountUsd = quoteAmount * quotePrice;
    const priceUsd = amountUsd / baseAmount;
    // We don't have the original raw amounts/decimals from tokenTransfers, so
    // we encode them with decimals=9 and back-compute raw. Downstream code uses
    // raw / 10^decimals to display, which round-trips to the same baseAmount.
    const baseRaw = BigInt(Math.round(baseAmount * 1e9));
    const quoteRaw = BigInt(Math.round(quoteAmount * 1e9));
    out.push({
      signature: tx.signature,
      slot: tx.slot,
      blockTime: new Date(tx.timestamp * 1000),
      wallet,
      baseMint: mint,
      quoteMint,
      side,
      baseAmountRaw: baseRaw,
      quoteAmountRaw: quoteRaw,
      priceUsd,
      amountUsd,
      dex: detectDex(tx.source),
      source: 'helius_webhook',
    });
  }
  return out;
}
