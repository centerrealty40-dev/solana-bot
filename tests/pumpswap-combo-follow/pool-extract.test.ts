import { describe, expect, it } from 'vitest';
import {
  extractPumpSwapPoolFromTx,
  PUMP_SWAP_AMM_PROGRAM_ID,
} from '../../src/parser/allowlisted-dex-swap.js';
import type { TxJsonParsed } from '../../src/parser/rpc-http.js';

const POOL = 'Pool1111111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';

function mockPumpSwapBuyTx(): TxJsonParsed {
  return {
    slot: 1,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [OTHER, POOL, PUMP_SWAP_AMM_PROGRAM_ID],
        instructions: [
          {
            programIdIndex: 2,
            accounts: [1],
          },
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programId: PUMP_SWAP_AMM_PROGRAM_ID,
              accounts: [1],
            },
          ],
        },
      ],
    },
  } as unknown as TxJsonParsed;
}

describe('extractPumpSwapPoolFromTx', () => {
  it('reads pool from outer PumpSwap instruction', () => {
    const tx = mockPumpSwapBuyTx();
    expect(extractPumpSwapPoolFromTx(tx)).toBe(POOL);
  });

  it('reads pool from inner PumpSwap instruction when outer is Jupiter', () => {
    const tx = mockPumpSwapBuyTx();
    (tx.transaction!.message as { instructions: unknown[] }).instructions = [
      { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [0] },
    ];
    expect(extractPumpSwapPoolFromTx(tx)).toBe(POOL);
  });

  it('reads pool from PumpSwap instruction with string account keys', () => {
    const pool = '8joL92GpGiuya3Vv5TMtQzzaMWBMVsPzBUUveTP4o8KU';
    const tx = {
      transaction: {
        message: {
          accountKeys: [],
          instructions: [
            {
              programId: PUMP_SWAP_AMM_PROGRAM_ID,
              accounts: [pool, 'hnu5iBK8UoHb51UFsH1RYTUAYdrhjHvV5YMTf9T1CYN'],
            },
          ],
        },
      },
    } as unknown as import('../../src/parser/rpc-http.js').TxJsonParsed;
    expect(extractPumpSwapPoolFromTx(tx)).toBe(pool);
  });

  it('returns null when PumpSwap program not invoked', () => {
    const tx = mockPumpSwapBuyTx();
    (tx.transaction!.message as { instructions: unknown[] }).instructions = [
      { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [1] },
    ];
    tx.meta!.innerInstructions = [];
    expect(extractPumpSwapPoolFromTx(tx)).toBeNull();
  });
});
