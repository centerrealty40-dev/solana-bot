import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUMP_FUN_PROGRAM_ID } from '../../src/parser/pumpfun.js';
import { createStreamPriceSampler } from '../../src/milddip/stream-price-sampler.js';

const mint = (suffix: string): string => `${suffix}${'A'.repeat(44 - suffix.length)}`;

function parsedBuyTx(targetMint: string, signature: string): unknown {
  const wallet = mint('wallet');
  return {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [{ pubkey: wallet, signer: true }],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      logMessages: [
        `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`,
        'Program log: Instruction: Buy',
      ],
      preBalances: [1_000_000_000],
      postBalances: [900_000_000],
      preTokenBalances: [
        {
          owner: wallet,
          mint: targetMint,
          uiTokenAmount: { amount: '0', decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          owner: wallet,
          mint: targetMint,
          uiTokenAmount: { amount: '1000000', decimals: 6 },
        },
      ],
    },
  };
}

const waitForSampler = async (ms = 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stream price sampler retry and skip telemetry', () => {
  it('retries a null transaction, samples on success, and respects the retry limit', async () => {
    const targetMint = mint('retry');
    let calls = 0;
    const sampler = createStreamPriceSampler({
      rpcUrl: 'https://rpc.invalid',
      shouldSample: () => true,
      minGapMsPerMint: 500,
      txRetryEnabled: true,
      txRetryMaxAttempts: 2,
      txRetryDelayMs: 1,
      txRetryMaxAgeMs: 30_000,
      fetchParsedTransactionFn: async (_rpcUrl, signature) => {
        calls += 1;
        return calls === 1 ? null : parsedBuyTx(targetMint, signature);
      },
    });

    sampler.enqueue(targetMint, 'retry-signature');
    await waitForSampler();
    const stats = sampler.stats();
    sampler.stop();

    expect(calls).toBe(2);
    expect(stats.sampled).toBe(1);
    expect(stats.txRetryAttempts).toBe(1);
    expect(stats.txRetrySucceeded).toBe(1);
    expect(stats.skipReasonCounts.get_tx_null).toBe(1);
  });

  it('does not retry a transaction job older than the freshness limit', async () => {
    const targetMint = mint('stale');
    let calls = 0;
    const sampler = createStreamPriceSampler({
      rpcUrl: 'https://rpc.invalid',
      shouldSample: () => true,
      txRetryEnabled: true,
      txRetryMaxAttempts: 2,
      txRetryDelayMs: 1,
      txRetryMaxAgeMs: 30_000,
      fetchParsedTransactionFn: async () => {
        calls += 1;
        return null;
      },
    });

    sampler.enqueue(targetMint, 'stale-signature', Date.now() - 31_000);
    await waitForSampler();
    const stats = sampler.stats();
    sampler.stop();

    expect(calls).toBe(1);
    expect(stats.txRetryAttempts).toBe(0);
    expect(stats.txRetrySucceeded).toBe(0);
    expect(stats.skipReasonCounts).toEqual({ get_tx_null: 1 });
  });

  it('counts skip reasons and keeps retries disabled by default', async () => {
    const targetMint = mint('reasons');
    let calls = 0;
    const sampler = createStreamPriceSampler({
      rpcUrl: 'https://rpc.invalid',
      shouldSample: () => true,
      minGapMsPerMint: 500,
      fetchParsedTransactionFn: async () => {
        calls += 1;
        return calls === 1 ? null : {};
      },
    });

    sampler.enqueue(targetMint, 'null-signature');
    await waitForSampler();
    sampler.enqueue(targetMint, 'decode-signature');
    await waitForSampler();
    const stats = sampler.stats();
    sampler.stop();

    expect(calls).toBe(1);
    expect(stats.txRetryAttempts).toBe(0);
    expect(stats.txRetrySucceeded).toBe(0);
    expect(stats.skipReasonCounts).toEqual({
      get_tx_null: 1,
      min_gap: 1,
    });
  });
});
