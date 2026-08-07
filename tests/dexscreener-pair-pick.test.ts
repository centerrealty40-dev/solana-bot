import { describe, expect, it } from 'vitest';
import {
  isUsdPriceOutlierVsAnchor,
  pickBestSolanaPairForMint,
} from '../src/papertrader/pricing/dexscreener-pair-pick.js';

const MINT = 'Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump';
const SOL = 'So11111111111111111111111111111111111111112';
const MET = 'METxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1'; // placeholder addr

describe('pickBestSolanaPairForMint', () => {
  it('prefers SOL-quoted pair over higher-liq MET pair with garbage USD', () => {
    const pairs = [
      {
        chainId: 'solana',
        dexId: 'meteora',
        baseToken: { address: MINT, symbol: 'Jimothy' },
        quoteToken: { address: MET, symbol: 'MET' },
        priceUsd: '128.46',
        liquidity: { usd: 1_618_253 },
      },
      {
        chainId: 'solana',
        dexId: 'pumpswap',
        baseToken: { address: MINT, symbol: 'Jimothy' },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.02655',
        liquidity: { usd: 672_227 },
      },
      {
        chainId: 'solana',
        dexId: 'meteora',
        baseToken: { address: MINT, symbol: 'Jimothy' },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.02660',
        liquidity: { usd: 793_347 },
      },
    ];
    const best = pickBestSolanaPairForMint(pairs, MINT);
    expect(best).not.toBeNull();
    expect(Number(best!.priceUsd)).toBeCloseTo(0.0266, 4);
    expect((best!.quoteToken as { symbol?: string }).symbol).toBe('SOL');
  });

  it('prefers allowedDexIds pumpswap over higher-liq meteora (NEEGY)', () => {
    const pairs = [
      {
        chainId: 'solana',
        dexId: 'meteora',
        baseToken: { address: MINT, symbol: 'NEEGY' },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.02',
        liquidity: { usd: 218_794 },
        volume: { m5: 3191 },
      },
      {
        chainId: 'solana',
        dexId: 'pumpswap',
        baseToken: { address: MINT, symbol: 'NEEGY' },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.021',
        liquidity: { usd: 154_865 },
        volume: { m5: 9076 },
      },
    ];
    const best = pickBestSolanaPairForMint(pairs, MINT, {
      allowedDexIds: ['pumpswap', 'pumpfun', 'raydium'],
    });
    expect(best).not.toBeNull();
    expect(best!.dexId).toBe('pumpswap');
    expect((best!.liquidity as { usd: number }).usd).toBe(154_865);
  });

  it('still picks max-liq when all quotes are stable', () => {
    const pairs = [
      {
        chainId: 'solana',
        baseToken: { address: MINT },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.02',
        liquidity: { usd: 100_000 },
      },
      {
        chainId: 'solana',
        baseToken: { address: MINT },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.021',
        liquidity: { usd: 500_000 },
      },
    ];
    const best = pickBestSolanaPairForMint(pairs, MINT);
    expect(Number(best!.priceUsd)).toBeCloseTo(0.021, 5);
    expect((best!.liquidity as { usd: number }).usd).toBe(500_000);
  });
});

describe('isUsdPriceOutlierVsAnchor', () => {
  it('flags Ge87 Dex $138 vs leader $0.028', () => {
    expect(isUsdPriceOutlierVsAnchor(138.4, 0.028318, 2)).toBe(true);
  });
  it('allows normal premium within 2x', () => {
    expect(isUsdPriceOutlierVsAnchor(0.029, 0.028, 2)).toBe(false);
  });
});
