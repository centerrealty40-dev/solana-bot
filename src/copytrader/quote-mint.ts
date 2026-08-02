/**
 * Funding (quote) asset for the copy-trader lane: wrapped SOL or USDC.
 *
 * USDC funding decouples position sizing from the SOL price — $100 stays $100
 * regardless of where SOL trades. Native SOL is still required in the wallet for
 * priority fees and ATA rent; only the swap leg changes.
 *
 * Every conversion between raw quote units and USD lives here. Mixing the two
 * decimal scales (SOL 1e9, USDC 1e6) silently misprices fills by ~150x, so the
 * rest of the lane must never divide by a hardcoded literal.
 */
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type CopyQuoteAsset = 'SOL' | 'USDC';

export type CopyQuoteSpec = {
  asset: CopyQuoteAsset;
  mint: string;
  decimals: number;
  /** Raw units per whole token (10 ** decimals). */
  unit: number;
  /** USDC is a dollar stablecoin — no SOL/USD feed needed for sizing. */
  usdPegged: boolean;
};

const SOL_SPEC: CopyQuoteSpec = {
  asset: 'SOL',
  mint: WRAPPED_SOL_MINT,
  decimals: 9,
  unit: 1e9,
  usdPegged: false,
};

const USDC_SPEC: CopyQuoteSpec = {
  asset: 'USDC',
  mint: USDC_MINT,
  decimals: 6,
  unit: 1e6,
  usdPegged: true,
};

/** Accepts `SOL` / `USDC` aliases or a raw mint address. Unknown input → SOL. */
export function parseCopyQuoteAsset(raw: unknown): CopyQuoteSpec {
  const s = String(raw ?? '').trim();
  if (s.length === 0) return SOL_SPEC;
  const upper = s.toUpperCase();
  if (upper === 'USDC' || s === USDC_MINT) return USDC_SPEC;
  if (upper === 'SOL' || upper === 'WSOL' || s === WRAPPED_SOL_MINT) return SOL_SPEC;
  return SOL_SPEC;
}

export function copyQuoteSpec(cfg: { quoteAsset?: CopyQuoteAsset }): CopyQuoteSpec {
  return cfg.quoteAsset === 'USDC' ? USDC_SPEC : SOL_SPEC;
}

/**
 * Raw input amount for a buy of `sizeUsd`.
 * Returns null when SOL funding is used but no usable SOL/USD mark is available.
 */
export function copyBuyInputAmountRaw(
  spec: CopyQuoteSpec,
  sizeUsd: number,
  solUsd: number,
): number | null {
  if (!(sizeUsd > 0)) return null;
  if (spec.usdPegged) return Math.max(1, Math.floor(sizeUsd * spec.unit));
  if (!(solUsd > 0)) return null;
  return Math.max(1, Math.floor((sizeUsd / solUsd) * spec.unit));
}

/** USD value of a raw quote-asset amount (swap input on buy, output on sell). */
export function copyQuoteRawToUsd(spec: CopyQuoteSpec, raw: number, solUsd: number): number {
  if (!(raw > 0)) return 0;
  const whole = raw / spec.unit;
  if (spec.usdPegged) return whole;
  if (!(solUsd > 0)) return 0;
  return whole * solUsd;
}

/**
 * Implied token USD price from a Jupiter buy quote.
 * `tokenDecimals` defaults to 6 (SPL memecoin standard on pump.fun / Raydium).
 */
export function copyBuyQuotePriceUsd(args: {
  spec: CopyQuoteSpec;
  inAmountRaw: unknown;
  outAmountRaw: unknown;
  solUsd: number;
  tokenDecimals?: number;
}): number {
  const { spec, solUsd } = args;
  const inN = toNumber(args.inAmountRaw);
  const outN = toNumber(args.outAmountRaw);
  if (!(inN > 0) || !(outN > 0)) return 0;
  const spentUsd = copyQuoteRawToUsd(spec, inN, solUsd);
  if (!(spentUsd > 0)) return 0;
  const tokens = outN / 10 ** (args.tokenDecimals ?? 6);
  if (!(tokens > 0)) return 0;
  return spentUsd / tokens;
}

/** Exit price from a Jupiter sell quote: quote-asset proceeds over tokens sold. */
export function copySellQuotePriceUsd(args: {
  spec: CopyQuoteSpec;
  outAmountRaw: unknown;
  tokenAmountRaw: string | bigint;
  solUsd: number;
  tokenDecimals?: number;
}): { proceedsUsd: number; priceUsd: number } {
  const { spec, solUsd } = args;
  const outN = toNumber(args.outAmountRaw);
  const proceedsUsd = copyQuoteRawToUsd(spec, outN, solUsd);
  const soldRaw = Number(args.tokenAmountRaw);
  const tokens = soldRaw > 0 ? soldRaw / 10 ** (args.tokenDecimals ?? 6) : 0;
  const priceUsd = tokens > 0 && proceedsUsd > 0 ? proceedsUsd / tokens : 0;
  return { proceedsUsd, priceUsd };
}

/** True when the lane can size and price trades without a SOL/USD mark. */
export function copyQuoteNeedsSolUsd(spec: CopyQuoteSpec): boolean {
  return !spec.usdPegged;
}

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
