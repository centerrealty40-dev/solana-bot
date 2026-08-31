import { PublicKey } from '@solana/web3.js';

export const PUMPFUN_TRADE_EVENT_DISCRIMINATOR = Buffer.from(
  'bddb7fd34ee661ee',
  'hex',
);
export const PUMPSWAP_BUY_EVENT_DISCRIMINATOR = Buffer.from(
  '67f4521f2cf57777',
  'hex',
);
export const PUMPSWAP_SELL_EVENT_DISCRIMINATOR = Buffer.from(
  '3e2f370aa503dc2a',
  'hex',
);
export const PUMPSWAP_POOL_ACCOUNT_DISCRIMINATOR = Buffer.from(
  'f19a6d0411b16dbc',
  'hex',
);
export const PUMPFUN_MINT_OFFSET = 8;
export const PUMPSWAP_POOL_OFFSET = 120;
export const PUMPSWAP_POOL_BASE_MINT_OFFSET = 43;
export const PUMPSWAP_POOL_QUOTE_MINT_OFFSET = 75;
export const PUMPSWAP_POOL_ACCOUNT_MIN_LENGTH = 301;
export const PUMPSWAP_POOL_OWNER = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

function sameBytes(data: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (data.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (data[offset + i] !== expected[i]) return false;
  }
  return true;
}

function keyFromBytes(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null;
  const bytes = data.slice(offset, offset + 32);
  if (bytes.every((value) => value === 0)) return null;
  try {
    return new PublicKey(bytes).toBase58();
  } catch {
    return null;
  }
}

function decodeBase64(value: string): Uint8Array | null {
  const text = value.trim();
  if (!text || text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    return null;
  }
  try {
    const data = Buffer.from(text, 'base64');
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

export function parseStreamEvents(logs: string[]): { mints: string[]; pools: string[] } {
  const mints = new Set<string>();
  const pools = new Set<string>();
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const data = decodeBase64(line.slice('Program data: '.length));
    if (!data) continue;
    if (sameBytes(data, 0, PUMPFUN_TRADE_EVENT_DISCRIMINATOR)) {
      const mint = keyFromBytes(data, PUMPFUN_MINT_OFFSET);
      if (mint && !QUOTE_MINTS.has(mint)) mints.add(mint);
    } else if (
      sameBytes(data, 0, PUMPSWAP_BUY_EVENT_DISCRIMINATOR) ||
      sameBytes(data, 0, PUMPSWAP_SELL_EVENT_DISCRIMINATOR)
    ) {
      const pool = keyFromBytes(data, PUMPSWAP_POOL_OFFSET);
      if (pool) pools.add(pool);
    }
  }
  return { mints: [...mints], pools: [...pools] };
}

export function decodePoolTokenMint(data: Uint8Array): string | null {
  if (
    data.length < PUMPSWAP_POOL_ACCOUNT_MIN_LENGTH ||
    !sameBytes(data, 0, PUMPSWAP_POOL_ACCOUNT_DISCRIMINATOR)
  ) {
    return null;
  }
  const base = keyFromBytes(data, PUMPSWAP_POOL_BASE_MINT_OFFSET);
  const quote = keyFromBytes(data, PUMPSWAP_POOL_QUOTE_MINT_OFFSET);
  if (base && !QUOTE_MINTS.has(base)) return base;
  if (quote && !QUOTE_MINTS.has(quote)) return quote;
  return null;
}
