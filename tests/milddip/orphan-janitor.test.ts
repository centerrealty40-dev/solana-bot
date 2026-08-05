import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { SPL_TOKEN_PROGRAM_ID } from '../../src/milddip/close-empty-ata.js';
import { buildBurnInstruction } from '../../src/milddip/orphan-janitor.js';

describe('buildBurnInstruction', () => {
  it('encodes Burn (ix=8) with little-endian amount', () => {
    const account = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const amount = 123456789n;
    const ix = buildBurnInstruction({
      tokenAccount: account,
      mint,
      owner,
      amountRaw: amount,
      programId: SPL_TOKEN_PROGRAM_ID,
    });
    expect(ix.data[0]).toBe(8);
    expect(ix.data.readBigUInt64LE(1)).toBe(amount);
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[0]?.isWritable).toBe(true);
    expect(ix.keys[1]?.isWritable).toBe(true);
    expect(ix.keys[2]?.isSigner).toBe(true);
  });
});
