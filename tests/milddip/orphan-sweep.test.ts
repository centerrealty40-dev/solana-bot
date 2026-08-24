import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { sweepUnmanagedOrphans } from '../../src/milddip/orphan-sweep.js';

const signer = Keypair.generate();
const mint = Keypair.generate().publicKey.toBase58();
const row = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint,
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  amountRaw: '1000000',
  lamports: 2_000_000,
  decimals: 6,
  uiAmount: 1,
};

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    executionMode: 'live',
    orphanSweepEnabled: true,
    orphanSweepMaxSells: 10,
    orphanSellMinUsd: 0.5,
    dustBurnMinAgeMs: 1000,
    dustBurnSettleMs: 1000,
    rpcUrl: 'https://example.invalid',
    entry: { minLiquidityUsd: 0, minMarketCapUsd: 0, maxMarketCapUsd: 0 },
    walletSecret: 'secret',
    walletPubkeyExpected: signer.publicKey.toBase58(),
    journalPath: '/tmp/orphan-sweep-test.jsonl',
    tradesPath: '/tmp/orphan-sweep-trades.jsonl',
    open: {},
    recentEntryMsByMint: {},
    lastExitByMint: {},
    leaderMirrorWatches: {},
    ...overrides,
  } as never;
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    open: {},
    recentEntryMsByMint: {},
    lastExitByMint: {},
    leaderMirrorWatches: {},
    updatedAtMs: 10_000,
    ...overrides,
  } as never;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    signer: () => signer,
    list: async () => [row],
    quote: async () => ({ ok: true, usd: 2 }),
    sell: async () => ({ ok: true, priceUsd: 2, signature: 'sig', quoteReceivedUsd: 2 }),
    close: async () => ({ closed: 1, reclaimedLamports: 2_000_000, signatures: [], errors: [] }),
    ...overrides,
  };
}

describe('orphan sweep', () => {
  it('fails closed outside live mode, when disabled, and on owner mismatch', async () => {
    for (const options of [
      { executionMode: 'paper' },
      { orphanSweepEnabled: false },
      { walletPubkeyExpected: Keypair.generate().publicKey.toBase58() },
    ]) {
      let sold = 0;
      const result = await sweepUnmanagedOrphans({
        cfg: cfg(options),
        state: state(),
        deps: deps({ sell: async () => { sold += 1; return { ok: true, priceUsd: 1 }; } }),
      });
      expect(result.sold).toBe(0);
      expect(sold).toBe(0);
    }
  });

  it('sells a non-pump candidate, writes the fill, and closes its ATA', async () => {
    let closed = 0;
    const result = await sweepUnmanagedOrphans({
      cfg: cfg(),
      state: state(),
      nowMs: 10_000,
      deps: deps({
        close: async () => { closed += 1; return { closed: 1, reclaimedLamports: 2_000_000, signatures: [], errors: [] }; },
      }),
    });
    expect(result.sold).toBe(1);
    expect(closed).toBe(1);
  });
});
