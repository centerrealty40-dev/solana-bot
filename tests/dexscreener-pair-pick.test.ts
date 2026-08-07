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

  it('NEEGY: allowedDexIds prefers pumpswap over higher-liq meteora', () => {
    // Live miss: meteora liq > pumpswap → mint rejected on ALLOWED_DEX; dump was on pumpswap.
    const neegy = '6oGuFDbEeaSzTcvrmmd2MqfNYwHKXFoN7regcR22pump';
    const pairs = [
      {
        chainId: 'solana',
        dexId: 'meteora',
        baseToken: { address: neegy, symbol: 'NEEGY' },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.002052',
        liquidity: { usd: 203_064 },
        priceChange: { m5: -5.78 },
      },
      {
        chainId: 'solana',
        dexId: 'pumpswap',
        baseToken: { address: neegy, symbol: 'NEEGY' },
        quoteToken: { address: SOL, symbol: 'SOL' },
        priceUsd: '0.002033',
        liquidity: { usd: 162_923 },
        priceChange: { m5: -17.39 },
      },
    ];
    const unrestricted = pickBestSolanaPairForMint(pairs, neegy);
    expect(unrestricted?.dexId).toBe('meteora');
    const allowed = pickBestSolanaPairForMint(pairs, neegy, {
      allowedDexIds: ['pumpswap', 'pumpfun', 'raydium'],
    });
    expect(allowed?.dexId).toBe('pumpswap');
    expect(Number((allowed as { priceChange?: { m5?: number } }).priceChange?.m5)).toBeCloseTo(
      -17.39,
      2,
    );
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
