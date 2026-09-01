import { describe, expect, it } from 'vitest';
import type { TxJsonParsed } from '../../src/parser/rpc-http.js';
import { mintPriceUsdFromTxMeta } from '../../src/milddip/stream-mint-price.js';

const MINT = 'TokenMint1111111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const BUYER = 'BuyerWallet1111111111111111111111111111111';
const POOL = 'PoolOwner111111111111111111111111111111111';

function txBuy(args: {
  tokenRawIn: string;
  wsolRawOut: string;
  lamportsSpent: number;
  fee?: number;
}): TxJsonParsed {
  const fee = args.fee ?? 5000;
  return {
    slot: 1,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ['sigPrice111111111111111111111111111111111'],
      message: {
        accountKeys: [
          { pubkey: BUYER, signer: true, writable: true },
          { pubkey: 'Other1111111111111111111111111111111111111', signer: false, writable: true },
        ],
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [args.lamportsSpent + fee + 1_000_000, 0],
      postBalances: [1_000_000, 0],
      preTokenBalances: [
        {
          mint: MINT,
          owner: BUYER,
          uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
        },
        {
          mint: WSOL,
          owner: BUYER,
          uiTokenAmount: { amount: args.wsolRawOut, decimals: 9, uiAmount: null },
        },
      ],
      postTokenBalances: [
        {
          mint: MINT,
          owner: BUYER,
          uiTokenAmount: { amount: args.tokenRawIn, decimals: 6, uiAmount: null },
        },
        {
          mint: WSOL,
          owner: BUYER,
          uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0 },
        },
      ],
    },
  };
}

describe('mintPriceUsdFromTxMeta', () => {
  it('prices a buy from WSOL spend', () => {
    // spend 0.1 SOL (= $15 at solUsd=150), receive 1_000_000 raw (=1 token @ 6 dec)
    const tx = txBuy({
      tokenRawIn: '1000000',
      wsolRawOut: '100000000', // 0.1 SOL pre, 0 post
      lamportsSpent: 0, // quote via wsol only
    });
    // Also spend lamports path: set wsol delta via balances above.
    const px = mintPriceUsdFromTxMeta(tx, MINT, 150);
    expect(px).toBeCloseTo(15, 5);
  });

  it('returns null on failed tx', () => {
    const tx = txBuy({ tokenRawIn: '1000000', wsolRawOut: '100000000', lamportsSpent: 0 });
    tx.meta!.err = { InstructionError: [0, 'Custom'] };
    expect(mintPriceUsdFromTxMeta(tx, MINT, 150)).toBeNull();
  });

  it('uses the pool quote instead of signer rent and fee deltas', () => {
    const tx = txBuy({
      tokenRawIn: '67000000',
      wsolRawOut: '0',
      lamportsSpent: 1100000,
    });
    tx.transaction!.message!.accountKeys!.push({
      pubkey: POOL,
      signer: false,
      writable: true,
    });
    tx.meta!.preTokenBalances!.push({
      accountIndex: 2,
      mint: MINT,
      owner: POOL,
      uiTokenAmount: { amount: '67000000', decimals: 6, uiAmount: 67 },
    });
    tx.meta!.postTokenBalances!.push({
      accountIndex: 2,
      mint: MINT,
      owner: POOL,
      uiTokenAmount: { amount: '0', decimals: 0, uiAmount: 0 },
    });
    tx.meta!.preTokenBalances!.push({
      accountIndex: 3,
      mint: WSOL,
      owner: POOL,
      uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0 },
    });
    tx.meta!.postTokenBalances!.push({
      accountIndex: 3,
      mint: WSOL,
      owner: POOL,
      uiTokenAmount: { amount: '75300', decimals: 9, uiAmount: 0.0000753 },
    });
    const px = mintPriceUsdFromTxMeta(tx, MINT, 103.26);
    expect(px).toBeCloseTo(0.00011605, 7);
    expect(px).not.toBeCloseTo(0.0016, 4);
  });

  it('rejects a signer-only dust quote below the fallback notional floor', () => {
    const tx = txBuy({
      tokenRawIn: '67000000',
      wsolRawOut: '0',
      lamportsSpent: 1100000,
    });
    tx.transaction!.message!.accountKeys!.push({
      pubkey: POOL,
      signer: false,
      writable: true,
    });
    tx.meta!.preTokenBalances!.push({
      accountIndex: 2,
      mint: MINT,
      owner: POOL,
      uiTokenAmount: { amount: '67000000', decimals: 6, uiAmount: 67 },
    });
    tx.meta!.postTokenBalances!.push({
      accountIndex: 2,
      mint: MINT,
      owner: POOL,
      uiTokenAmount: { amount: '0', decimals: 0, uiAmount: 0 },
    });
    expect(mintPriceUsdFromTxMeta(tx, MINT, 103.26)).toBeNull();
  });
});
