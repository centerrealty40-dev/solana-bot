import { describe, expect, it, vi } from 'vitest';
import { PoolMintResolver } from '../../src/milddip/pool-mint-resolver.js';
import { PUMPSWAP_POOL_OWNER } from '../../src/milddip/stream-events.js';

const pool = '3SYEYjJRvtJDbNoPh1gho2YJtJK2g2L445cJRG6RyjAs';
const mint = 'Cb8sgkM1veaDMCVPKxwQSDbm3r8dfUzmRVmiNCZypump';
const accountData =
  '8ZptBBGxbbz+AAA09mWSF0UTkCs9P+CQxa8xKwbfn9BrUnQPcI/k7sBPHqwvNOwf1eFlvxAneYe+TlMyF14x/2WniVi7z7Vq9GSPBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAGQyVFaPShvFo2UOykHcpxBzl6N7qso5SAW6xg8W/SsGNjX+Yg5lpLxDX9/K2eOIliv7E0rqpnAdUyJgqM/RjxO2C6gVhYr9iPHbsMcMYudevkyox/BAsIOjL+tOIMK0gnsQmtZ0AMAABfxBKtP5nnzOdG6WHZqggUHOPZ3iEMvtke0TVgVzSI7AADIQR4YBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 50 && !fn(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

describe('PoolMintResolver', () => {
  it('batches, deduplicates, resolves callbacks, and serves cache hits', async () => {
    const pools = Array.from({ length: 3 }, (_, i) => `${pool.slice(0, -1)}${i}`);
    const fetchAccounts = vi.fn(async (requested: string[]) => {
      expect(requested.length).toBeLessThanOrEqual(2);
      return requested.map(() => ({ owner: PUMPSWAP_POOL_OWNER, data: [accountData, 'base64'] as [string, string] }));
    });
    const onMint = vi.fn();
    const resolver = new PoolMintResolver({
      rpcHttpUrl: 'https://rpc.invalid',
      onMint,
      batchSize: 2,
      batchIntervalMs: 1,
      fetchAccounts,
    });
    resolver.enqueue(pools[0]!, 10, 'sig-1');
    resolver.enqueue(pools[0]!, 11, 'sig-2');
    resolver.enqueue(pools[1]!, 12, 'sig-3');
    resolver.enqueue(pools[2]!, 13, 'sig-4');
    await waitFor(() => onMint.mock.calls.length === 4);
    resolver.enqueue(pools[0]!, 14, 'sig-5');
    expect(onMint).toHaveBeenCalledWith(mint, 10, 'sig-1');
    expect(onMint).toHaveBeenCalledWith(mint, 11, 'sig-2');
    expect(onMint).toHaveBeenCalledWith(mint, 14, 'sig-5');
    expect(fetchAccounts).toHaveBeenCalledTimes(2);
    expect(resolver.stats().cacheHits).toBe(1);
    resolver.stop();
  });

  it('retries RPC errors, then negative-caches the pool and bounds the queue', async () => {
    const fetchAccounts = vi.fn(async () => {
      throw new Error('offline');
    });
    const resolver = new PoolMintResolver({
      rpcHttpUrl: 'https://rpc.invalid',
      onMint: vi.fn(),
      batchSize: 1,
      batchIntervalMs: 1,
      maxAttempts: 2,
      maxQueue: 1,
      negativeTtlMs: 60_000,
      fetchAccounts,
    });
    resolver.enqueue(pool, 1);
    resolver.enqueue(`${pool.slice(0, -1)}1`, 2);
    await waitFor(() => resolver.stats().rejected === 1);
    resolver.enqueue(pool, 3);
    expect(fetchAccounts).toHaveBeenCalledTimes(2);
    expect(resolver.stats().dropped).toBeGreaterThanOrEqual(1);
    expect(resolver.stats().rejected).toBe(1);
    resolver.stop();
  });
});
