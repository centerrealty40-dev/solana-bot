import { describe, expect, it } from 'vitest';
import type { TxJsonParsed } from '../src/parser/rpc-http.js';
import { extractNativeSolTransfers } from '../src/intel/wallet-backfill-sol-flows.js';

describe('wallet-backfill-sol-flows', () => {
  it('extractNativeSolTransfers reads system transfer', () => {
    const tx = {
      slot: 1,
      blockTime: 1700000000,
      meta: { err: null },
      transaction: {
        signatures: ['sig1'],
        message: {
          accountKeys: [{ pubkey: 'A', signer: true }],
          instructions: [
            {
              programId: '11111111111111111111111111111111',
              parsed: {
                type: 'transfer',
                info: { source: 'AAA', destination: 'BBB', lamports: 1_500_000 },
              },
            },
          ],
        },
      },
    } as unknown as TxJsonParsed;

    const legs = extractNativeSolTransfers(tx);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.sourceWallet).toBe('AAA');
    expect(legs[0]?.targetWallet).toBe('BBB');
    expect(legs[0]?.amount).toBeCloseTo(0.0015);
  });
});
