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
  if (!swap) return [];
  const wallet = tx.feePayer ?? null;
  if (!wallet) {
    log.debug({ sig: tx.signature }, 'no feePayer, skipping');
    return [];
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
    const decimals = ti.tokenAmount.decimals;
    const raw = BigInt(ti.tokenAmount.tokenAmount);
    const cur = walletDelta.get(ti.mint);
    walletDelta.set(ti.mint, { raw: (cur?.raw ?? 0n) - raw, decimals });
  }
  for (const to of swap.tokenOutputs ?? []) {
    if (to.userAccount !== wallet) continue;
    const decimals = to.tokenAmount.decimals;
    const raw = BigInt(to.tokenAmount.tokenAmount);
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
