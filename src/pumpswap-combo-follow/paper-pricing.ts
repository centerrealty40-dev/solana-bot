import { Keypair } from '@solana/web3.js';
import { quotePumpSwapExitPriceUsd } from '../pumpswap-combo/pumpswap-direct.js';
import type { FollowPosition } from './types.js';

function investedUsdAllLegs(pos: FollowPosition): number {
  return pos.legs.reduce((s, l) => s + l.usd, 0);
}

function avgFillPrice(pos: FollowPosition): number {
  let w = 0;
  let t = 0;
  for (const l of pos.legs) {
    if (l.fillPriceUsd > 0) {
      w += l.usd;
      t += l.usd / l.fillPriceUsd;
    }
  }
  return t > 0 ? w / t : 0;
}

const PAPER_QUOTE_USER = Keypair.generate().publicKey;
const DEFAULT_DECIMALS = 6;

export function paperTokenQty(pos: FollowPosition): number {
  let qty = 0;
  for (const leg of pos.legs) {
    if (leg.fillPriceUsd > 0 && leg.usd > 0) {
      qty += leg.usd / leg.fillPriceUsd;
    }
  }
  return qty * Math.max(0, pos.remainingFrac);
}

export function paperTokenRaw(pos: FollowPosition, decimals = DEFAULT_DECIMALS): bigint {
  const qty = paperTokenQty(pos);
  if (!(qty > 0)) return 0n;
  return BigInt(Math.max(1, Math.floor(qty * 10 ** decimals)));
}

/** Pool sell quote for virtual paper bag — same SDK path as live combo exits. */
export async function paperPoolExitQuoteUsd(args: {
  rpcUrl: string;
  pos: FollowPosition;
}): Promise<{ priceUsd: number | null; tokenRaw: bigint; decimals: number }> {
  const pool = args.pos.poolAddress?.trim();
  if (!pool) return { priceUsd: null, tokenRaw: 0n, decimals: DEFAULT_DECIMALS };
  const tokenRaw = paperTokenRaw(args.pos);
  if (tokenRaw <= 0n) return { priceUsd: null, tokenRaw: 0n, decimals: DEFAULT_DECIMALS };
  const q = await quotePumpSwapExitPriceUsd({
    rpcUrl: args.rpcUrl,
    poolAddress: pool,
    tokenRaw,
    user: PAPER_QUOTE_USER,
  });
  return { priceUsd: q.priceUsd, tokenRaw, decimals: q.decimals };
}

export function paperPnlPctVsAvg(pos: FollowPosition, markPriceUsd: number): number {
  const avg = avgFillPrice(pos);
  if (!(avg > 0) || !(markPriceUsd > 0)) return 0;
  return (markPriceUsd / avg - 1) * 100;
}

export function paperInvestedRemainingUsd(pos: FollowPosition): number {
  return investedUsdAllLegs(pos) * Math.max(0, pos.remainingFrac);
}
