import { describe, expect, it } from 'vitest';
import {
  extractBuyEconomics,
  extractMintFromParsedTx,
  feePayerSolSpent,
} from '../../src/milddip/buy-economics.js';
import type { TxJsonParsed } from '../../src/parser/rpc-http.js';

const MINT = 'EavU1XbHSwmjP1QtXELKMz6ZS4kR1Xzvi7VeyWdBpump';
const PAYER = '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5';
const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP_SWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

function buyTx(solSpent: number, tokenDelta: number): TxJsonParsed {
  const lamports = Math.round(solSpent * 1e9);
  return {
    slot: 1,
    blockTime: 1_786_282_204,
    meta: {
      err: null,
      preBalances: [lamports + 2e9, 0],
      postBalances: [2e9, 0],
      logMessages: [`Program ${PUMP_SWAP} invoke [1]`, 'Program log: Instruction: Buy'],
      preTokenBalances: [
        {
          mint: MINT,
          owner: PAYER,
          uiTokenAmount: { uiAmount: 0, decimals: 6, amount: '0' },
        },
      ],
      postTokenBalances: [
        {
          mint: MINT,
          owner: PAYER,
          uiTokenAmount: {
            uiAmount: tokenDelta,
            decimals: 6,
            amount: String(Math.round(tokenDelta * 1e6)),
          },
        },
        {
          mint: WSOL,
          owner: PAYER,
          uiTokenAmount: { uiAmount: 0, decimals: 9, amount: '0' },
        },
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [{ programId: PUMP_SWAP, accounts: [], data: '' }],
        },
      ],
    },
    transaction: {
      signatures: ['2gbJEyig9L2jJkL89MveZaysSVxjgkVDevd9eYb2VCjkr95so3EPY2VtgAVq48LMePEUPJR4A4pAGggPnrJfcWpP'],
      message: {
        accountKeys: [PAYER, MINT, PUMP_SWAP],
        instructions: [{ programId: PUMP_SWAP, accounts: [], data: '' }],
      },
    },
  } as unknown as TxJsonParsed;
}

describe('buy-economics', () => {
  it('extracts mint from fee-payer token delta', () => {
    const tx = buyTx(8.8, 813_910);
    expect(extractMintFromParsedTx(tx)).toBe(MINT);
    expect(feePayerSolSpent(tx)).toBeGreaterThan(8);
  });

  it('extractBuyEconomics returns price + sol notional', () => {
    const tx = buyTx(8.8, 813_910);
    const econ = extractBuyEconomics(tx, { solUsd: 150 });
    expect(econ).not.toBeNull();
    expect(econ!.mint).toBe(MINT);
    expect(econ!.solNotional).toBeGreaterThan(8);
    expect(econ!.priceUsd).toBeGreaterThan(0);
    expect(econ!.amountUsd).toBeGreaterThan(1000);
  });
});
