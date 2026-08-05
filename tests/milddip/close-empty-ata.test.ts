import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  SPL_TOKEN_2022_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  buildCloseAccountInstruction,
} from '../../src/milddip/close-empty-ata.js';

describe('buildCloseAccountInstruction', () => {
  it('encodes CloseAccount (ix=9) for classic SPL token', () => {
    const account = Keypair.generate().publicKey;
    const dest = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const ix = buildCloseAccountInstruction({
      tokenAccount: account,
      destination: dest,
      owner,
      programId: SPL_TOKEN_PROGRAM_ID,
    });
    expect(ix.programId.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.data.equals(Buffer.from([9]))).toBe(true);
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[0]?.pubkey.equals(account)).toBe(true);
    expect(ix.keys[0]?.isWritable).toBe(true);
    expect(ix.keys[1]?.pubkey.equals(dest)).toBe(true);
    expect(ix.keys[1]?.isWritable).toBe(true);
    expect(ix.keys[2]?.pubkey.equals(owner)).toBe(true);
    expect(ix.keys[2]?.isSigner).toBe(true);
  });

  it('uses Token-2022 program id for pump ATAs', () => {
    const ix = buildCloseAccountInstruction({
      tokenAccount: Keypair.generate().publicKey,
      destination: Keypair.generate().publicKey,
      owner: Keypair.generate().publicKey,
      programId: SPL_TOKEN_2022_PROGRAM_ID,
    });
    expect(ix.programId.equals(SPL_TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});
