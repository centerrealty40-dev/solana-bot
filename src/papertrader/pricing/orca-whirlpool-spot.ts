/**
 * Decode Orca Whirlpool pool account (sqrt_price X64) → approximate USD/base for corridor checks.
 * Layout: Anchor 8-byte discriminator + Pod fields per Orca Whirlpool `repr(C)` (liquidity @64, sqrt_price @80, token_mint_a @116, token_mint_b @148).
 */
import { PublicKey } from '@solana/web3.js';

export const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const OFF_LIQUIDITY = 64;
const OFF_SQRT_PRICE = 80;
const OFF_TOKEN_MINT_A = 116;
const OFF_TOKEN_MINT_B = 148;

function readU128LE(buf: Buffer, offset: number): bigint {
  let x = 0n;
  for (let i = 0; i < 16; i++) x |= BigInt(buf[offset + i]!) << BigInt(8 * i);
  return x;
}

function mintDecimals(mint: string): number | null {
  if (mint === USDC_MINT || mint === USDT_MINT) return 6;
  if (mint === WSOL_MINT) return 9;
  return null;
}

/**
 * sqrt_price X64 is Q64.64 fixed point; Orca price definition: token_b per token_a (raw) = (sqrt^2 / 2^128).
 */
export function sqrtPriceX64ToTokenBPerTokenA(sqrtPriceX64: bigint): number {
  const sqrt = Number(sqrtPriceX64);
  if (!(sqrt > 0) || !Number.isFinite(sqrt)) return NaN;
  const p = (sqrt / Math.pow(2, 64)) ** 2;
  return p;
}

export type OrcaSpotDecode =
  | {
      ok: true;
      sqrtPriceX64: string;
      tokenMintA: string;
      tokenMintB: string;
      /** Estimated USD per 1 base token (base = baseMint argument when it matches A or B). */
      spotUsdPerBase: number;
    }
  | { ok: false; reason: 'too_short' | 'zero_liquidity' | 'bad_sqrt' | 'unknown_quote' | 'base_not_in_pool' };

export function decodeWhirlpoolSpotUsd(
  accountDataBase64: string,
  baseMint: string,
  baseDecimals: number,
  solUsd: number,
): OrcaSpotDecode {
  let buf: Buffer;
  try {
    buf = Buffer.from(accountDataBase64, 'base64');
  } catch {
    return { ok: false, reason: 'too_short' };
  }
  const need = OFF_TOKEN_MINT_B + 32;
  if (buf.length < need) return { ok: false, reason: 'too_short' };

  const liq = readU128LE(buf, OFF_LIQUIDITY);
  if (liq === 0n) return { ok: false, reason: 'zero_liquidity' };

  const sqrt = readU128LE(buf, OFF_SQRT_PRICE);
  if (sqrt <= 0n) return { ok: false, reason: 'bad_sqrt' };

  const mintA = new PublicKey(buf.subarray(OFF_TOKEN_MINT_A, OFF_TOKEN_MINT_A + 32)).toBase58();
  const mintB = new PublicKey(buf.subarray(OFF_TOKEN_MINT_B, OFF_TOKEN_MINT_B + 32)).toBase58();

  const bd =
    Number.isFinite(baseDecimals) && baseDecimals >= 0 && baseDecimals <= 24
      ? Math.floor(baseDecimals)
      : null;
  if (bd === null) return { ok: false, reason: 'bad_sqrt' };

  let decA: number;
  let decB: number;
  if (baseMint === mintA) {
    decA = bd;
    const dq = mintDecimals(mintB);
    if (dq == null) return { ok: false, reason: 'unknown_quote' };
    decB = dq;
  } else if (baseMint === mintB) {
    decB = bd;
    const dq = mintDecimals(mintA);
    if (dq == null) return { ok: false, reason: 'unknown_quote' };
    decA = dq;
  } else {
    return { ok: false, reason: 'base_not_in_pool' };
  }

  const rawRatio = sqrtPriceX64ToTokenBPerTokenA(sqrt);
  if (!(rawRatio > 0) || !Number.isFinite(rawRatio)) return { ok: false, reason: 'bad_sqrt' };

  const humanBPerA = rawRatio * Math.pow(10, decA - decB);

  let usdPerBase: number;
  if (baseMint === mintA) {
    const usdB = mintB === WSOL_MINT ? solUsd : mintB === USDC_MINT || mintB === USDT_MINT ? 1 : NaN;
    if (!Number.isFinite(usdB)) return { ok: false, reason: 'unknown_quote' };
    usdPerBase = humanBPerA * usdB;
  } else {
    const humanAPerB = humanBPerA > 0 ? 1 / humanBPerA : NaN;
    const usdA = mintA === WSOL_MINT ? solUsd : mintA === USDC_MINT || mintA === USDT_MINT ? 1 : NaN;
    if (!Number.isFinite(usdA)) return { ok: false, reason: 'unknown_quote' };
    usdPerBase = humanAPerB * usdA;
  }

  if (!(usdPerBase > 0) || !Number.isFinite(usdPerBase)) return { ok: false, reason: 'bad_sqrt' };

  return {
    ok: true,
    sqrtPriceX64: sqrt.toString(),
    tokenMintA: mintA,
    tokenMintB: mintB,
    spotUsdPerBase: usdPerBase,
  };
}
