import { getJupQuote } from '../collectors/jupiter-price.js';
import { QUOTE_MINTS, DEFAULTS } from '../core/constants.js';

/**
 * Realistic paper-fill estimator.
 *
 * Approach:
 *   1. Ask Jupiter for an actual quote (USDC -> baseMint or vice versa)
 *   2. priceImpactPct from Jupiter is treated as our slippage
 *   3. Add a small worst-case buffer (5 bps) to model tx failure / route shift
 *   4. Compute fee = LP fee (~25-30 bps for typical Solana pools) + priority fee (~$0.0005 flat)
 *
 * Returns:
 *   - fillPriceUsd  — effective price including slippage
 *   - slippageBps   — total slippage in bps vs mid
 *   - feeUsd        — fee in USD
 *   - outAmountRaw  — base raw amount we'd receive (for buy) or USDC raw we'd receive (for sell)
 */
export interface PaperFillEstimate {
  fillPriceUsd: number;
  slippageBps: number;
  feeUsd: number;
  outAmountRaw: bigint;
  inAmountRaw: bigint;
}

export interface PaperFillRequest {
  side: 'buy' | 'sell';
  baseMint: string;
  /** USD-denominated trade size (notional) */
  sizeUsd: number;
  /** raw base amount when side=sell, otherwise computed from price */
  baseAmountRaw?: bigint;
  /** mid price right now (best estimate) — used as fallback when quote fails */
  midPriceUsd: number;
  /** decimals of the base mint, needed to convert sizeUsd into raw amount */
  decimals: number;
}

export async function estimatePaperFill(
  req: PaperFillRequest,
): Promise<PaperFillEstimate> {
  const usdc = QUOTE_MINTS.USDC;
  const slippageCap = DEFAULTS.hardSlippageBps;
  const baseFeeBps = DEFAULTS.baseFeeBps;
  // Convert sizeUsd to USDC raw (6 decimals)
  const sizeUsdcRaw = BigInt(Math.round(req.sizeUsd * 1_000_000));

  let inputMint: string;
  let outputMint: string;
  let inAmount: bigint;
  if (req.side === 'buy') {
    inputMint = usdc;
    outputMint = req.baseMint;
    inAmount = sizeUsdcRaw;
  } else {
    inputMint = req.baseMint;
    outputMint = usdc;
    if (!req.baseAmountRaw || req.baseAmountRaw <= 0n) {
      // approximate baseAmount from sizeUsd / midPrice
      inAmount = BigInt(
        Math.round((req.sizeUsd / Math.max(req.midPriceUsd, 1e-12)) * 10 ** req.decimals),
      );
    } else {
      inAmount = req.baseAmountRaw;
    }
  }

  const quote = await getJupQuote({
    inputMint,
    outputMint,
    amountRaw: inAmount,
    slippageBps: slippageCap,
  });

  if (!quote) {
    // Fallback: synthetic slippage = size / pool depth heuristic
    const syntheticSlippageBps = Math.min(
      DEFAULTS.paperSlippageMultiplierBps + Math.sqrt(req.sizeUsd) * 2,
      slippageCap,
    );
    const fillPrice =
      req.side === 'buy'
        ? req.midPriceUsd * (1 + syntheticSlippageBps / 10_000)
        : req.midPriceUsd * (1 - syntheticSlippageBps / 10_000);
    const baseRaw =
      req.side === 'buy'
        ? BigInt(Math.round((req.sizeUsd / fillPrice) * 10 ** req.decimals))
        : inAmount;
    const usdcRaw =
      req.side === 'sell'
        ? BigInt(Math.round((Number(inAmount) / 10 ** req.decimals) * fillPrice * 1_000_000))
        : sizeUsdcRaw;
    const feeUsd = (req.sizeUsd * baseFeeBps) / 10_000 + 0.001;
    return {
      fillPriceUsd: fillPrice,
      slippageBps: syntheticSlippageBps,
      feeUsd,
      outAmountRaw: req.side === 'buy' ? baseRaw : usdcRaw,
      inAmountRaw: inAmount,
    };
  }

  const inAmtBig = BigInt(quote.inAmount);
  const outAmtBig = BigInt(quote.outAmount);
  const priceImpactBps = Math.round(parseFloat(quote.priceImpactPct ?? '0') * 10_000);
  const totalSlipBps = Math.min(Math.max(priceImpactBps, 5), slippageCap);
  let fillPriceUsd: number;
  if (req.side === 'buy') {
    const usdcSpent = Number(inAmtBig) / 1_000_000;
    const baseReceived = Number(outAmtBig) / 10 ** req.decimals;
    fillPriceUsd = baseReceived === 0 ? req.midPriceUsd : usdcSpent / baseReceived;
  } else {
    const baseSent = Number(inAmtBig) / 10 ** req.decimals;
    const usdcReceived = Number(outAmtBig) / 1_000_000;
    fillPriceUsd = baseSent === 0 ? req.midPriceUsd : usdcReceived / baseSent;
  }
  const feeUsd = (req.sizeUsd * baseFeeBps) / 10_000 + 0.001;
  return {
    fillPriceUsd,
    slippageBps: totalSlipBps,
    feeUsd,
    outAmountRaw: outAmtBig,
    inAmountRaw: inAmtBig,
  };
}
